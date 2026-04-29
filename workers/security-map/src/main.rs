use hmac::{Hmac, Mac};
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use iii_sdk::error::IIIError;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

const NONCE_TTL_MS: u64 = 5 * 60 * 1000;
const CHALLENGE_WINDOW_MS: u64 = 60 * 1000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn body_or_self(input: &Value) -> Value {
    input.get("body").cloned().unwrap_or_else(|| input.clone())
}

fn require_auth(input: &Value) -> Result<(), IIIError> {
    let expected = std::env::var("AGENTOS_API_KEY")
        .map_err(|_| IIIError::Handler("AGENTOS_API_KEY not configured".into()))?;
    let header = input
        .get("headers")
        .and_then(|h| h.get("authorization"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let token = header.strip_prefix("Bearer ").unwrap_or(header);
    if token.as_bytes().ct_eq(expected.as_bytes()).into() {
        Ok(())
    } else {
        Err(IIIError::Handler("Unauthorized".into()))
    }
}

fn random_nonce_hex() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn hmac_hex(secret: &str, payload: &str) -> Result<String, IIIError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|e| IIIError::Handler(format!("HMAC key error: {e}")))?;
    mac.update(payload.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

async fn map_challenge(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = body_or_self(&input);
    let source_agent = body
        .get("sourceAgent")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let target_agent = body
        .get("targetAgent")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if source_agent.is_empty() || target_agent.is_empty() {
        return Err(IIIError::Handler(
            "sourceAgent and targetAgent are required".into(),
        ));
    }

    let nonce = random_nonce_hex();
    let timestamp = now_ms();

    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
            "scope": "map_challenges",
            "key": &nonce,
            "value": {
                "nonce": &nonce,
                "timestamp": timestamp,
                "sourceAgent": source_agent,
                "targetAgent": target_agent,
            },
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let nonce_short = nonce.chars().take(8).collect::<String>();
    let source = source_agent.to_string();
    let target = target_agent.to_string();
    let _iii = iii.clone();
    tokio::spawn(async move {
        let _ = _iii
            .trigger(TriggerRequest {
                function_id: "security::audit".to_string(),
                payload: json!({
                    "type": "map_challenge_issued",
                    "detail": {
                        "sourceAgent": source,
                        "targetAgent": target,
                        "nonce": nonce_short,
                    },
                }),
                action: None,
                timeout_ms: None,
            })
            .await;
    });

    Ok(json!({
        "nonce": nonce,
        "timestamp": timestamp,
        "sourceAgent": source_agent,
    }))
}

async fn map_respond(iii: &III, input: Value) -> Result<Value, IIIError> {
    let body = body_or_self(&input);
    let nonce = body.get("nonce").and_then(|v| v.as_str()).unwrap_or("");
    let source_agent = body
        .get("sourceAgent")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let responder_agent = body
        .get("responderAgent")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let timestamp = body
        .get("timestamp")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if nonce.is_empty() || source_agent.is_empty() || responder_agent.is_empty() {
        return Err(IIIError::Handler(
            "nonce, sourceAgent, and responderAgent are required".into(),
        ));
    }

    let secret_entry: Value = iii
        .trigger(TriggerRequest {
            function_id: "vault::get".to_string(),
            payload: json!({ "key": format!("map:{}", responder_agent) }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(json!(null));

    let secret = secret_entry
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("No shared secret configured for agent".into()))?;

    let payload = format!("{nonce}:{source_agent}:{responder_agent}:{timestamp}");
    let signature = hmac_hex(secret, &payload)?;

    Ok(json!({
        "signature": signature,
        "nonce": nonce,
        "responderAgent": responder_agent,
    }))
}

async fn audit_emit(iii: &III, entry_type: &str, detail: Value) {
    let _iii = iii.clone();
    let entry_type = entry_type.to_string();
    tokio::spawn(async move {
        let _ = _iii
            .trigger(TriggerRequest {
                function_id: "security::audit".to_string(),
                payload: json!({ "type": entry_type, "detail": detail }),
                action: None,
                timeout_ms: None,
            })
            .await;
    });
}

async fn map_verify(iii: &III, input: Value) -> Result<Value, IIIError> {
    if input.get("headers").is_some() {
        require_auth(&input)?;
    }
    let body = body_or_self(&input);
    let nonce = body.get("nonce").and_then(|v| v.as_str()).unwrap_or("");
    let signature = body.get("signature").and_then(|v| v.as_str()).unwrap_or("");
    let responder_agent = body
        .get("responderAgent")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if nonce.is_empty() || signature.is_empty() || responder_agent.is_empty() {
        return Err(IIIError::Handler(
            "nonce, signature, and responderAgent are required".into(),
        ));
    }

    let challenge: Value = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": "map_challenges", "key": nonce }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(json!(null));

    if challenge.is_null() || challenge.as_object().map(|o| o.is_empty()).unwrap_or(false) {
        let _ = iii
            .trigger(TriggerRequest {
                function_id: "state::delete".to_string(),
                payload: json!({ "scope": "map_challenges", "key": nonce }),
                action: None,
                timeout_ms: None,
            })
            .await;
        audit_emit(
            iii,
            "map_verify_failed",
            json!({ "reason": "unknown_nonce", "responderAgent": responder_agent }),
        )
        .await;
        return Ok(json!({ "verified": false, "reason": "unknown_nonce" }));
    }

    let challenge_ts = challenge.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0);
    let source_agent = challenge
        .get("sourceAgent")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if now_ms().saturating_sub(challenge_ts) > CHALLENGE_WINDOW_MS {
        let _ = iii
            .trigger(TriggerRequest {
                function_id: "state::delete".to_string(),
                payload: json!({ "scope": "map_challenges", "key": nonce }),
                action: None,
                timeout_ms: None,
            })
            .await;
        audit_emit(
            iii,
            "map_verify_failed",
            json!({ "reason": "expired", "responderAgent": responder_agent }),
        )
        .await;
        return Ok(json!({ "verified": false, "reason": "challenge_expired" }));
    }

    let used: Value = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": "map_used_nonces", "key": nonce }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(json!(null));

    if !(used.is_null() || used.as_object().map(|o| o.is_empty()).unwrap_or(false)) {
        let _ = iii
            .trigger(TriggerRequest {
                function_id: "state::delete".to_string(),
                payload: json!({ "scope": "map_challenges", "key": nonce }),
                action: None,
                timeout_ms: None,
            })
            .await;
        audit_emit(
            iii,
            "map_verify_failed",
            json!({ "reason": "replay_detected", "responderAgent": responder_agent }),
        )
        .await;
        return Ok(json!({ "verified": false, "reason": "replay_detected" }));
    }

    let secret_entry: Value = iii
        .trigger(TriggerRequest {
            function_id: "vault::get".to_string(),
            payload: json!({ "key": format!("map:{}", responder_agent) }),
            action: None,
            timeout_ms: None,
        })
        .await
        .unwrap_or(json!(null));

    let secret = match secret_entry.get("value").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Ok(json!({ "verified": false, "reason": "no_shared_secret" })),
    };

    let payload = format!(
        "{nonce}:{source_agent}:{responder_agent}:{challenge_ts}"
    );
    let expected = hmac_hex(&secret, &payload)?;

    let expected_bytes = hex::decode(&expected).unwrap_or_default();
    let signature_bytes = hex::decode(signature).unwrap_or_default();
    let verified = expected_bytes.len() == signature_bytes.len()
        && bool::from(expected_bytes.ct_eq(&signature_bytes));

    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({
            "scope": "map_used_nonces",
            "key": nonce,
            "value": { "usedAt": now_ms(), "responderAgent": responder_agent },
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger(TriggerRequest {
        function_id: "state::delete".to_string(),
        payload: json!({ "scope": "map_challenges", "key": nonce }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let nonce_owned = nonce.to_string();
    let _iii = iii.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(NONCE_TTL_MS)).await;
        let _ = _iii
            .trigger(TriggerRequest {
                function_id: "state::delete".to_string(),
                payload: json!({ "scope": "map_used_nonces", "key": nonce_owned }),
                action: None,
                timeout_ms: None,
            })
            .await;
    });

    audit_emit(
        iii,
        if verified {
            "map_verify_success"
        } else {
            "map_verify_failed"
        },
        json!({
            "responderAgent": responder_agent,
            "sourceAgent": source_agent,
        }),
    )
    .await;

    if verified {
        Ok(json!({ "verified": true, "agent": responder_agent }))
    } else {
        Ok(json!({ "verified": false }))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("security::map_challenge", move |input: Value| {
            let iii = iii_ref.clone();
            async move { map_challenge(&iii, input).await }
        })
        .description("Generate MAP mutual-auth challenge nonce"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("security::map_respond", move |input: Value| {
            let iii = iii_ref.clone();
            async move { map_respond(&iii, input).await }
        })
        .description("Sign MAP challenge nonce with shared secret"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("security::map_verify", move |input: Value| {
            let iii = iii_ref.clone();
            async move { map_verify(&iii, input).await }
        })
        .description("Verify MAP mutual-auth response signature"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "security::map_challenge".to_string(),
        config: json!({ "api_path": "api/security/map/challenge", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "security::map_verify".to_string(),
        config: json!({ "api_path": "api/security/map/verify", "http_method": "POST" }),
        metadata: None,
    })?;

    tracing::info!("security-map worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_random_nonce_hex_length() {
        let nonce = random_nonce_hex();
        assert_eq!(nonce.len(), 64);
    }

    #[test]
    fn test_random_nonce_unique() {
        let n1 = random_nonce_hex();
        let n2 = random_nonce_hex();
        assert_ne!(n1, n2);
    }

    #[test]
    fn test_random_nonce_is_hex() {
        let nonce = random_nonce_hex();
        assert!(nonce.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_hmac_hex_deterministic() {
        let h1 = hmac_hex("secret", "payload").unwrap();
        let h2 = hmac_hex("secret", "payload").unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hmac_hex_different_secrets() {
        let h1 = hmac_hex("secret1", "payload").unwrap();
        let h2 = hmac_hex("secret2", "payload").unwrap();
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_hmac_hex_different_payloads() {
        let h1 = hmac_hex("secret", "p1").unwrap();
        let h2 = hmac_hex("secret", "p2").unwrap();
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_hmac_hex_64_chars() {
        let h = hmac_hex("k", "v").unwrap();
        assert_eq!(h.len(), 64);
    }

    #[test]
    fn test_now_ms_nonzero() {
        assert!(now_ms() > 0);
    }

    #[test]
    fn test_body_or_self_with_body() {
        let v = json!({ "body": { "x": 1 } });
        assert_eq!(body_or_self(&v), json!({ "x": 1 }));
    }

    #[test]
    fn test_body_or_self_no_body() {
        let v = json!({ "y": 2 });
        assert_eq!(body_or_self(&v), json!({ "y": 2 }));
    }

    #[test]
    fn test_constant_time_eq_match() {
        let a = b"abcdef";
        let b = b"abcdef";
        assert!(bool::from(a.ct_eq(b)));
    }

    #[test]
    fn test_constant_time_eq_no_match() {
        let a = b"abcdef";
        let b = b"abcdeg";
        assert!(!bool::from(a.ct_eq(b)));
    }

    #[test]
    fn test_signature_format_concat() {
        let nonce = "n1";
        let src = "alice";
        let resp = "bob";
        let ts = 12345u64;
        let payload = format!("{nonce}:{src}:{resp}:{ts}");
        assert_eq!(payload, "n1:alice:bob:12345");
    }

    #[test]
    fn test_constants_in_milliseconds() {
        assert_eq!(NONCE_TTL_MS, 300_000);
        assert_eq!(CHALLENGE_WINDOW_MS, 60_000);
    }
}
