use dashmap::DashMap;
use iii_sdk::{InitOptions, RegisterFunction, TriggerRequest, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use zeroize::Zeroizing;

const AUTO_DISPOSE_MS: u64 = 30_000;

fn registry() -> &'static DashMap<String, Zeroizing<Vec<u8>>> {
    static REG: OnceLock<DashMap<String, Zeroizing<Vec<u8>>>> = OnceLock::new();
    REG.get_or_init(DashMap::new)
}

fn secret_patterns() -> &'static Vec<regex::Regex> {
    static PATTERNS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        SECRET_PATTERNS
            .iter()
            .filter_map(|p| regex::Regex::new(p).ok())
            .collect()
    })
}

static SECRET_PATTERNS: &[&str] = &[
    r"(?i)(?:api[_-]?key|apikey)\s*[:=]\s*\S+",
    r"(?i)(?:secret|password|passwd|token)\s*[:=]\s*\S+",
    r"(?:sk|pk)[-_][a-zA-Z0-9]{20,}",
    r"ghp_[a-zA-Z0-9]{36}",
    r"xox[bpas]-[a-zA-Z0-9\-]+",
    r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----",
    r"Bearer\s+[a-zA-Z0-9._\-]{20,}",
];

fn wrap_secret(value: &str, auto_dispose_ms: u64) -> String {
    let id = uuid_v4();
    let bytes = Zeroizing::new(value.as_bytes().to_vec());
    registry().insert(id.clone(), bytes);

    let id_clone = id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(auto_dispose_ms)).await;
        registry().remove(&id_clone);
    });

    id
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("zb-{:x}", nanos)
}

fn scan_value_for_secrets(value: &Value) -> Vec<String> {
    let s = serde_json::to_string(value).unwrap_or_default();
    secret_patterns()
        .iter()
        .filter(|re| re.is_match(&s))
        .map(|re| {
            let src = re.as_str();
            let take = src.len().min(30);
            src[..take].to_string()
        })
        .collect()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("security::zeroize_wrap", move |input: Value| async move {
            let value = input
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or_else(|| IIIError::Handler("value is required".into()))?;
            if value.is_empty() {
                return Err(IIIError::Handler("value is required".into()));
            }
            let auto_dispose_ms = input
                .get("autoDisposeMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(AUTO_DISPOSE_MS);

            let _id = wrap_secret(value, auto_dispose_ms);
            Ok::<Value, IIIError>(json!({
                "wrapped": true,
                "autoDisposeMs": auto_dispose_ms,
            }))
        })
        .description("Wrap a secret string in a zeroized buffer"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("security::zeroize_check", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let target_scopes: Vec<String> = input
                    .get("scopes")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_else(|| {
                        vec!["config".into(), "sessions".into(), "agents".into()]
                    });

                let mut findings: Vec<Value> = Vec::new();

                for scope in &target_scopes {
                    let entries = iii
                        .trigger(TriggerRequest {
                            function_id: "state::list".to_string(),
                            payload: json!({ "scope": scope }),
                            action: None,
                            timeout_ms: None,
                        })
                        .await
                        .unwrap_or(json!([]));

                    let items: Vec<Value> = match &entries {
                        Value::Array(a) => a.clone(),
                        Value::Object(o) => o
                            .get("entries")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default(),
                        _ => Vec::new(),
                    };

                    for entry in items {
                        let value = entry.get("value").cloned().unwrap_or(json!(""));
                        let matched = scan_value_for_secrets(&value);
                        if !matched.is_empty() {
                            findings.push(json!({
                                "scope": scope,
                                "key": entry.get("key").and_then(|v| v.as_str()).unwrap_or("unknown"),
                                "patterns": matched,
                            }));
                        }
                    }
                }

                if !findings.is_empty() {
                    let _iii = iii.clone();
                    let count = findings.len();
                    let scopes_clone = target_scopes.clone();
                    tokio::spawn(async move {
                        let _ = _iii
                            .trigger(TriggerRequest {
                                function_id: "security::audit".to_string(),
                                payload: json!({
                                    "type": "zeroize_scan_findings",
                                    "detail": { "count": count, "scopes": scopes_clone },
                                }),
                                action: None,
                                timeout_ms: None,
                            })
                            .await;
                    });
                }

                Ok::<Value, IIIError>(json!({
                    "clean": findings.is_empty(),
                    "findings": findings,
                    "scanned": target_scopes.len(),
                }))
            }
        })
        .description("Scan KV state for potential unzeroized secrets"),
    );

    tracing::info!("security-zeroize worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_patterns_compile() {
        assert_eq!(secret_patterns().len(), SECRET_PATTERNS.len());
    }

    #[test]
    fn test_scan_detects_api_key() {
        let v = json!("api_key=abcdef1234567890");
        let matches = scan_value_for_secrets(&v);
        assert!(!matches.is_empty());
    }

    #[test]
    fn test_scan_detects_password() {
        let v = json!("password=hunter2hello");
        let matches = scan_value_for_secrets(&v);
        assert!(!matches.is_empty());
    }

    #[test]
    fn test_scan_detects_github_token() {
        let v = json!("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let matches = scan_value_for_secrets(&v);
        assert!(!matches.is_empty());
    }

    #[test]
    fn test_scan_detects_slack_token() {
        let v = json!("xoxb-12345-abcdef");
        let matches = scan_value_for_secrets(&v);
        assert!(!matches.is_empty());
    }

    #[test]
    fn test_scan_detects_pem_private_key() {
        let v = json!("-----BEGIN RSA PRIVATE KEY-----");
        let matches = scan_value_for_secrets(&v);
        assert!(!matches.is_empty());
    }

    #[test]
    fn test_scan_detects_bearer_token() {
        let v = json!("Authorization: Bearer abcdef1234567890abcdef1234");
        let matches = scan_value_for_secrets(&v);
        assert!(!matches.is_empty());
    }

    #[test]
    fn test_scan_clean_value() {
        let v = json!({ "name": "alice", "age": 30 });
        let matches = scan_value_for_secrets(&v);
        assert!(matches.is_empty());
    }

    #[test]
    fn test_scan_empty_object() {
        let v = json!({});
        let matches = scan_value_for_secrets(&v);
        assert!(matches.is_empty());
    }

    #[test]
    fn test_pattern_truncation_under_30() {
        let v = json!("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let matches = scan_value_for_secrets(&v);
        for m in &matches {
            assert!(m.len() <= 30);
        }
    }

    #[tokio::test]
    async fn test_wrap_secret_inserts_in_registry() {
        let id = wrap_secret("super-secret", 60_000);
        assert!(registry().contains_key(&id));
        registry().remove(&id);
    }

    #[test]
    fn test_zeroizing_buffer_holds_data() {
        let buf = Zeroizing::new(b"hello".to_vec());
        assert_eq!(&*buf, b"hello");
    }
}
