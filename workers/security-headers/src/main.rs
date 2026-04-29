use iii_sdk::{InitOptions, RegisterFunction, RegisterTriggerInput, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Map, Value};
use std::net::IpAddr;
use std::time::Duration;
use url::Url;

const SECURITY_HEADERS: &[(&str, &str)] = &[
    (
        "Content-Security-Policy",
        "default-src 'self'; script-src 'none'; object-src 'none'; frame-ancestors 'none'",
    ),
    ("Strict-Transport-Security", "max-age=31536000; includeSubDomains"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("X-XSS-Protection", "0"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
    ("Cache-Control", "no-store"),
    ("Pragma", "no-cache"),
];

fn required_keys() -> Vec<String> {
    SECURITY_HEADERS.iter().map(|(k, _)| k.to_string()).collect()
}

fn apply_to_obj(input: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = input.clone();
    for (k, v) in SECURITY_HEADERS {
        merged.insert(k.to_string(), Value::String(v.to_string()));
    }
    merged
}

fn assert_safe_external_url(raw: &str) -> Result<(), IIIError> {
    let parsed = Url::parse(raw)
        .map_err(|e| IIIError::Handler(format!("invalid URL: {e}")))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(IIIError::Handler(format!(
            "scheme not allowed: {scheme} (only http/https)"
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| IIIError::Handler("URL has no host".into()))?;
    let host_lc = host.to_ascii_lowercase();
    if host_lc == "localhost"
        || host_lc.ends_with(".localhost")
        || host_lc.ends_with(".internal")
        || host_lc.ends_with(".local")
    {
        return Err(IIIError::Handler(format!(
            "blocked host: {host}"
        )));
    }
    let ip_candidate = host_lc
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(&host_lc);
    if let Ok(ip) = ip_candidate.parse::<IpAddr>() {
        let blocked = match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_unspecified()
                    || v4.is_multicast()
                    || v4.octets()[0] == 169 && v4.octets()[1] == 254
            }
            IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
        if blocked {
            return Err(IIIError::Handler(format!(
                "blocked IP literal: {host}"
            )));
        }
    }
    Ok(())
}

async fn check_url(url: &str) -> Result<Value, IIIError> {
    assert_safe_external_url(url)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let resp = client
        .head(url)
        .send()
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut missing = Vec::new();
    let mut present = Vec::new();
    for (key, _) in SECURITY_HEADERS {
        if resp.headers().keys().any(|h| h.as_str().eq_ignore_ascii_case(key)) {
            present.push(*key);
        } else {
            missing.push(*key);
        }
    }

    Ok(json!({
        "compliant": missing.is_empty(),
        "present": present,
        "missing": missing,
        "url": url,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("security::headers_apply", move |input: Value| async move {
            let headers = input
                .get("headers")
                .and_then(|h| h.as_object())
                .cloned()
                .unwrap_or_default();
            let merged = apply_to_obj(&headers);
            Ok::<Value, IIIError>(json!({
                "headers": Value::Object(merged),
                "applied": SECURITY_HEADERS.len(),
            }))
        })
        .description("Apply security headers to a response object"),
    );

    iii.register_function(
        RegisterFunction::new_async("security::headers_check", move |input: Value| async move {
            let url = input.get("url").and_then(|v| v.as_str());
            match url {
                None | Some("") => Ok::<Value, IIIError>(json!({
                    "compliant": false,
                    "missing": required_keys(),
                    "message": "No URL provided, returning full required header list",
                })),
                Some(url) => check_url(url).await,
            }
        })
        .description("Verify all required security headers are present"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "security::headers_check".to_string(),
        config: json!({ "api_path": "api/security/headers/check", "http_method": "POST" }),
        metadata: None,
    })?;

    tracing::info!("security-headers worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_required_keys_count() {
        assert_eq!(required_keys().len(), 9);
    }

    #[test]
    fn test_required_keys_contains_csp() {
        let keys = required_keys();
        assert!(keys.iter().any(|k| k == "Content-Security-Policy"));
    }

    #[test]
    fn test_required_keys_contains_hsts() {
        let keys = required_keys();
        assert!(keys.iter().any(|k| k == "Strict-Transport-Security"));
    }

    #[test]
    fn test_apply_to_empty() {
        let input = Map::new();
        let merged = apply_to_obj(&input);
        assert_eq!(merged.len(), SECURITY_HEADERS.len());
        assert_eq!(merged.get("X-Frame-Options"), Some(&Value::String("DENY".into())));
    }

    #[test]
    fn test_apply_to_existing_keeps_input_keys() {
        let mut input = Map::new();
        input.insert("X-Custom".into(), Value::String("yes".into()));
        let merged = apply_to_obj(&input);
        assert_eq!(merged.get("X-Custom"), Some(&Value::String("yes".into())));
        assert!(merged.contains_key("Content-Security-Policy"));
    }

    #[test]
    fn test_apply_to_overrides_security_keys() {
        let mut input = Map::new();
        input.insert("X-Frame-Options".into(), Value::String("ALLOW".into()));
        let merged = apply_to_obj(&input);
        assert_eq!(merged.get("X-Frame-Options"), Some(&Value::String("DENY".into())));
    }

    #[test]
    fn test_csp_value_blocks_scripts() {
        let csp = SECURITY_HEADERS
            .iter()
            .find(|(k, _)| *k == "Content-Security-Policy")
            .map(|(_, v)| *v)
            .unwrap();
        assert!(csp.contains("script-src 'none'"));
    }

    #[test]
    fn test_hsts_includes_subdomains() {
        let hsts = SECURITY_HEADERS
            .iter()
            .find(|(k, _)| *k == "Strict-Transport-Security")
            .map(|(_, v)| *v)
            .unwrap();
        assert!(hsts.contains("includeSubDomains"));
    }

    #[test]
    fn test_cache_control_no_store() {
        let cc = SECURITY_HEADERS
            .iter()
            .find(|(k, _)| *k == "Cache-Control")
            .map(|(_, v)| *v)
            .unwrap();
        assert_eq!(cc, "no-store");
    }

    #[test]
    fn test_assert_safe_url_accepts_public() {
        assert!(assert_safe_external_url("https://example.com/foo").is_ok());
        assert!(assert_safe_external_url("http://example.com").is_ok());
    }

    #[test]
    fn test_assert_safe_url_rejects_localhost() {
        assert!(assert_safe_external_url("http://localhost/foo").is_err());
        assert!(assert_safe_external_url("https://api.localhost/").is_err());
    }

    #[test]
    fn test_assert_safe_url_rejects_loopback_ip() {
        assert!(assert_safe_external_url("http://127.0.0.1/").is_err());
        assert!(assert_safe_external_url("http://[::1]/").is_err());
    }

    #[test]
    fn test_assert_safe_url_rejects_private_ranges() {
        assert!(assert_safe_external_url("http://10.0.0.1/").is_err());
        assert!(assert_safe_external_url("http://192.168.1.1/").is_err());
        assert!(assert_safe_external_url("http://172.16.0.1/").is_err());
    }

    #[test]
    fn test_assert_safe_url_rejects_link_local() {
        assert!(assert_safe_external_url("http://169.254.169.254/").is_err());
        assert!(assert_safe_external_url("http://[fe80::1]/").is_err());
    }

    #[test]
    fn test_assert_safe_url_rejects_unsupported_schemes() {
        assert!(assert_safe_external_url("file:///etc/passwd").is_err());
        assert!(assert_safe_external_url("gopher://example.com/").is_err());
        assert!(assert_safe_external_url("ftp://example.com/").is_err());
    }

    #[test]
    fn test_assert_safe_url_rejects_internal_suffix() {
        assert!(assert_safe_external_url("https://svc.internal/").is_err());
        assert!(assert_safe_external_url("https://api.local/").is_err());
    }
}
