use hmac::{Hmac, Mac};
use iii_sdk::error::IIIError;
use iii_sdk::protocol::TriggerAction;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};
use sha2::Sha256;
use std::time::Duration;

type HmacSha256 = Hmac<Sha256>;

const LINKEDIN_API: &str = "https://api.linkedin.com/v2";
const MAX_MESSAGE_LEN: usize = 4096;
const MESSAGE_EVENT_KEY: &str = "com.linkedin.voyager.messaging.event.MessageEvent";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const NOTIFICATION_DEDUPE_TTL_SECS: u64 = 24 * 60 * 60;

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Compute hex-encoded HMAC-SHA256 over `body` using `secret` as the key.
fn hmac_sha256_hex(secret: &str, body: &[u8]) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|e| format!("HMAC init error: {e}"))?;
    mac.update(body);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// Verify LinkedIn `X-LI-Signature` header per
/// https://learn.microsoft.com/en-us/linkedin/shared/api-guide/webhook-validation
/// Header value is `hmacsha256={hex}`.
fn verify_linkedin_signature(secret: &str, raw_body: &str, signature: &str) -> Result<(), String> {
    if secret.is_empty() {
        return Err("LinkedIn client secret not configured".into());
    }
    let computed = hmac_sha256_hex(secret, raw_body.as_bytes())?;
    let expected = format!("hmacsha256={computed}");
    if !constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
        return Err("Invalid LinkedIn signature".into());
    }
    Ok(())
}

fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.chars().count() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut remaining: &str = text;
    while !remaining.is_empty() {
        if remaining.chars().count() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }
        let split_idx = remaining
            .char_indices()
            .nth(max_len)
            .map(|(i, _)| i)
            .unwrap_or(remaining.len());
        chunks.push(remaining[..split_idx].to_string());
        remaining = &remaining[split_idx..];
    }
    chunks
}

async fn get_secret(iii: &III, key: &str) -> String {
    let result = iii
        .trigger(TriggerRequest {
            function_id: "vault::get".to_string(),
            payload: json!({ "key": key }),
            action: None,
            timeout_ms: None,
        })
        .await;
    if let Ok(v) = result
        && let Some(value) = v.get("value").and_then(|s| s.as_str())
        && !value.is_empty()
    {
        return value.to_string();
    }
    std::env::var(key).unwrap_or_default()
}

async fn resolve_agent(iii: &III, channel: &str, channel_id: &str) -> String {
    let result = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({
                "scope": "channel_agents",
                "key": format!("{channel}:{channel_id}"),
            }),
            action: None,
            timeout_ms: None,
        })
        .await;
    match result {
        Ok(v) => v
            .get("agentId")
            .and_then(|a| a.as_str())
            .unwrap_or("default")
            .to_string(),
        Err(_) => "default".to_string(),
    }
}

async fn send_message(
    iii: &III,
    client: &reqwest::Client,
    thread_id: &str,
    text: &str,
) -> Result<(), IIIError> {
    let token = get_secret(iii, "LINKEDIN_TOKEN").await;
    if token.is_empty() {
        return Err(IIIError::Handler("LINKEDIN_TOKEN not configured".into()));
    }
    for chunk in split_message(text, MAX_MESSAGE_LEN) {
        let url = format!("{LINKEDIN_API}/messages");
        let res = client
            .post(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .header("X-Restli-Protocol-Version", "2.0.0")
            .json(&json!({
                "recipients": [],
                "threadId": thread_id,
                "body": chunk,
            }))
            .send()
            .await
            .map_err(|e| IIIError::Handler(format!("LinkedIn send error: {e}")))?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(IIIError::Handler(format!(
                "LinkedIn send failed ({status}): {}",
                body.chars().take(300).collect::<String>()
            )));
        }
    }
    Ok(())
}

fn extract_message_text(msg_event: &Value) -> Option<String> {
    msg_event
        .get("messageBody")
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .map(String::from)
        .or_else(|| {
            msg_event
                .get("attributedBody")
                .and_then(|b| b.get("text"))
                .and_then(|t| t.as_str())
                .map(String::from)
        })
}

/// Check whether `notification_id` was already processed via the `state::*`
/// dedup scope. Returns true if newly recorded, false if duplicate.
async fn record_notification_id(iii: &III, notification_id: &str) -> bool {
    if notification_id.is_empty() {
        return true;
    }
    let key = format!("linkedin:{notification_id}");
    let existing = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": "channel_dedupe", "key": key }),
            action: None,
            timeout_ms: None,
        })
        .await;
    if let Ok(v) = existing
        && v.get("seen").and_then(|s| s.as_bool()) == Some(true)
    {
        return false;
    }
    let _ = iii
        .trigger(TriggerRequest {
            function_id: "state::set".to_string(),
            payload: json!({
                "scope": "channel_dedupe",
                "key": key,
                "value": { "seen": true },
                "ttl": NOTIFICATION_DEDUPE_TTL_SECS,
            }),
            action: Some(TriggerAction::Void),
            timeout_ms: None,
        })
        .await;
    true
}

async fn process_element(
    iii: &III,
    client: &reqwest::Client,
    element: &Value,
) -> Result<(), IIIError> {
    let msg_event = element
        .get("event")
        .and_then(|e| e.get(MESSAGE_EVENT_KEY));
    let Some(msg_event) = msg_event else {
        return Ok(());
    };
    let Some(text) = extract_message_text(msg_event) else {
        return Ok(());
    };
    if text.is_empty() {
        return Ok(());
    }
    let thread_id = element
        .get("entityUrn")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let sender_id = element
        .get("from")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let notification_id = element
        .get("notificationId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !record_notification_id(iii, notification_id).await {
        tracing::info!(notification_id, "linkedin: skipping duplicate notification");
        return Ok(());
    }

    let agent_id = resolve_agent(iii, "linkedin", &thread_id).await;

    let chat = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("linkedin:{thread_id}"),
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(format!("agent::chat failed: {e}")))?;

    let reply = chat
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if !reply.is_empty()
        && !thread_id.is_empty()
        && let Err(e) = send_message(iii, client, &thread_id, &reply).await
    {
        tracing::error!(error = %e, "failed to post LinkedIn reply");
    }

    let _ = iii
        .trigger(TriggerRequest {
            function_id: "security::audit".to_string(),
            payload: json!({
                "type": "channel_message",
                "agentId": agent_id,
                "detail": {
                    "channel": "linkedin",
                    "threadId": thread_id,
                    "senderId": sender_id,
                },
            }),
            action: Some(TriggerAction::Void),
            timeout_ms: None,
        })
        .await;
    Ok(())
}

async fn webhook_handler(
    iii: &III,
    client: &reqwest::Client,
    input: Value,
) -> Result<Value, IIIError> {
    let method = input
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("POST")
        .to_uppercase();
    let query = input.get("query").cloned().unwrap_or_else(|| json!({}));

    // GET challenge handshake.
    if method == "GET" {
        let challenge = query
            .get("challengeCode")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if challenge.is_empty() {
            return Ok(json!({
                "status_code": 400,
                "body": { "error": "Missing challengeCode" }
            }));
        }
        let secret = get_secret(iii, "LINKEDIN_CLIENT_SECRET").await;
        if secret.is_empty() {
            return Ok(json!({
                "status_code": 500,
                "body": { "error": "LINKEDIN_CLIENT_SECRET not configured" }
            }));
        }
        let response = match hmac_sha256_hex(&secret, challenge.as_bytes()) {
            Ok(hex) => hex,
            Err(e) => {
                tracing::error!(error = %e, "linkedin: challenge HMAC failed");
                return Ok(json!({
                    "status_code": 500,
                    "body": { "error": "Challenge HMAC failed" }
                }));
            }
        };
        return Ok(json!({
            "status_code": 200,
            "body": {
                "challengeCode": challenge,
                "challengeResponse": response,
            }
        }));
    }

    // Verify X-LI-Signature on POST.
    let raw_body = input.get("rawBody").and_then(|v| v.as_str());
    let signature = input
        .get("headers")
        .and_then(|h| h.get("x-li-signature"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if let Some(raw) = raw_body {
        let secret = get_secret(iii, "LINKEDIN_CLIENT_SECRET").await;
        if secret.is_empty() {
            return Ok(json!({
                "status_code": 500,
                "body": { "error": "LINKEDIN_CLIENT_SECRET not configured" }
            }));
        }
        if signature.is_empty() {
            return Ok(json!({
                "status_code": 401,
                "body": { "error": "Missing X-LI-Signature header" }
            }));
        }
        if let Err(e) = verify_linkedin_signature(&secret, raw, signature) {
            tracing::warn!(error = %e, "linkedin signature rejected");
            return Ok(json!({
                "status_code": 401,
                "body": { "error": "Invalid LinkedIn signature" }
            }));
        }
    }

    let body = input.get("body").cloned().unwrap_or(input);

    let elements: Vec<Value> = body
        .get("elements")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();

    if elements.is_empty() {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    for element in &elements {
        if let Err(e) = process_element(iii, client, element).await {
            tracing::error!(error = %e, "failed to process LinkedIn element");
        }
    }

    Ok(json!({ "status_code": 200, "body": { "ok": true } }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let ws_url =
        std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()?;

    let iii_clone = iii.clone();
    let client_clone = client.clone();
    iii.register_function(
        RegisterFunction::new_async("channel::linkedin::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            async move { webhook_handler(&iii, &client, input).await }
        })
        .description("Handle LinkedIn messaging webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::linkedin::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/linkedin" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::linkedin::webhook".to_string(),
        config: json!({ "http_method": "GET", "api_path": "webhook/linkedin" }),
        metadata: None,
    })?;

    tracing::info!("channel-linkedin worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_short_text_returns_single_chunk() {
        let chunks = split_message("hello", 4096);
        assert_eq!(chunks, vec!["hello".to_string()]);
    }

    #[test]
    fn split_long_text_chunks_at_limit() {
        let text = "a".repeat(5000);
        let chunks = split_message(&text, 4096);
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.chars().count() <= 4096));
    }

    #[test]
    fn extracts_message_body_text() {
        let event = json!({ "messageBody": { "text": "hello" } });
        assert_eq!(extract_message_text(&event), Some("hello".to_string()));
    }

    #[test]
    fn extracts_attributed_body_fallback() {
        let event = json!({ "attributedBody": { "text": "fallback" } });
        assert_eq!(extract_message_text(&event), Some("fallback".to_string()));
    }

    #[test]
    fn returns_none_when_neither_field_present() {
        let event = json!({});
        assert_eq!(extract_message_text(&event), None);
    }
}
