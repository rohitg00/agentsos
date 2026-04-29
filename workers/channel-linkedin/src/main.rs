use iii_sdk::error::IIIError;
use iii_sdk::protocol::TriggerAction;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

const LINKEDIN_API: &str = "https://api.linkedin.com/v2";
const MAX_MESSAGE_LEN: usize = 4096;
const MESSAGE_EVENT_KEY: &str = "com.linkedin.voyager.messaging.event.MessageEvent";

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

async fn webhook_handler(
    iii: &III,
    client: &reqwest::Client,
    input: Value,
) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input);

    let element = body
        .get("elements")
        .and_then(|e| e.as_array())
        .and_then(|arr| arr.first())
        .cloned();

    let Some(element) = element else {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    };

    let msg_event = element
        .get("event")
        .and_then(|e| e.get(MESSAGE_EVENT_KEY))
        .cloned();

    let Some(msg_event) = msg_event else {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    };

    let Some(text) = extract_message_text(&msg_event) else {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    };

    if text.is_empty() {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
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

    Ok(json!({ "status_code": 200, "body": { "ok": true } }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let ws_url =
        std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());
    let client = reqwest::Client::new();

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
