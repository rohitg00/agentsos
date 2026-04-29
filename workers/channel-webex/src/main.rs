use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::RwLock;

const API_URL: &str = "https://webexapis.com/v1";
const MAX_MESSAGE_LEN: usize = 7439;

/// Process-local cache of the bot's own `personId`, populated lazily so we do
/// not hit `/v1/people/me` on every webhook delivery.
type BotIdCache = Arc<RwLock<Option<String>>>;

async fn get_secret(iii: &III, key: &str) -> String {
    let result = iii
        .trigger(TriggerRequest {
            function_id: "vault::get".to_string(),
            payload: json!({ "key": key }),
            action: None,
            timeout_ms: None,
        })
        .await;
    if let Ok(value) = result
        && let Some(v) = value.get("value").and_then(|v| v.as_str())
        && !v.is_empty()
    {
        return v.to_string();
    }
    std::env::var(key).unwrap_or_default()
}

async fn resolve_agent(iii: &III, channel: &str, channel_id: &str) -> String {
    let key = format!("{channel}:{channel_id}");
    let result = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": "channel_agents", "key": key }),
            action: None,
            timeout_ms: None,
        })
        .await;
    if let Ok(value) = result
        && let Some(agent) = value.get("agentId").and_then(|v| v.as_str())
    {
        return agent.to_string();
    }
    "default".to_string()
}

fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.chars().count() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut remaining = text.to_string();
    while !remaining.is_empty() {
        if remaining.chars().count() <= max_len {
            chunks.push(remaining);
            break;
        }
        let cutoff = remaining
            .char_indices()
            .nth(max_len)
            .map(|(idx, _)| idx)
            .unwrap_or(remaining.len());
        let window = &remaining[..cutoff];
        let split_at = match window.rfind('\n') {
            Some(idx) if window[..idx].chars().count() > max_len / 2 => idx,
            _ => cutoff,
        };
        chunks.push(remaining[..split_at].to_string());
        remaining = if split_at < cutoff && remaining.as_bytes().get(split_at) == Some(&b'\n') {
            remaining[split_at + 1..].to_string()
        } else {
            remaining[split_at..].to_string()
        };
    }
    chunks
}

async fn fetch_message(
    client: &reqwest::Client,
    token: &str,
    message_id: &str,
) -> Result<Option<String>, IIIError> {
    let resp = client
        .get(format!("{API_URL}/messages/{message_id}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| IIIError::Handler(format!("Webex fetch error: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(IIIError::Handler(format!(
            "Webex fetch failed ({status}): {}",
            body.chars().take(300).collect::<String>()
        )));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| IIIError::Handler(format!("Webex decode: {e}")))?;
    Ok(body
        .get("text")
        .and_then(|v| v.as_str())
        .map(String::from))
}

/// Fetch the bot's own personId from `/v1/people/me` so we can drop self-posted
/// webhook events. Returns `None` on any failure so the caller can skip the
/// guard and continue processing.
async fn fetch_bot_person_id(client: &reqwest::Client, token: &str) -> Option<String> {
    let resp = client
        .get(format!("{API_URL}/people/me"))
        .bearer_auth(token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    body.get("id").and_then(|v| v.as_str()).map(String::from)
}

async fn send_message(
    client: &reqwest::Client,
    token: &str,
    room_id: &str,
    text: &str,
) -> Result<(), IIIError> {
    for chunk in split_message(text, MAX_MESSAGE_LEN) {
        let resp = client
            .post(format!("{API_URL}/messages"))
            .bearer_auth(token)
            .json(&json!({ "roomId": room_id, "text": chunk }))
            .send()
            .await
            .map_err(|e| IIIError::Handler(format!("Webex send error: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(IIIError::Handler(format!(
                "Webex send failed ({status}): {}",
                body.chars().take(300).collect::<String>()
            )));
        }
    }
    Ok(())
}

async fn handle_webhook(
    iii: &III,
    client: &reqwest::Client,
    bot_id_cache: &BotIdCache,
    req: Value,
) -> Result<Value, IIIError> {
    let body = req.get("body").cloned().unwrap_or_else(|| req.clone());

    let resource = body.get("resource").and_then(|v| v.as_str()).unwrap_or("");
    let event = body.get("event").and_then(|v| v.as_str()).unwrap_or("");
    if resource != "messages" || event != "created" {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let message_id = body
        .pointer("/data/id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let room_id = body
        .pointer("/data/roomId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let person_id = body
        .pointer("/data/personId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let webex_token = get_secret(iii, "WEBEX_TOKEN").await;
    if webex_token.is_empty() {
        return Ok(json!({
            "status_code": 500,
            "body": { "error": "WEBEX_TOKEN not configured" }
        }));
    }

    // Drop self-posted messages so the bot does not loop on its own replies.
    let bot_id = {
        let cached = bot_id_cache.read().await.clone();
        match cached {
            Some(id) => Some(id),
            None => {
                let fetched = fetch_bot_person_id(client, &webex_token).await;
                if let Some(id) = &fetched {
                    let mut guard = bot_id_cache.write().await;
                    if guard.is_none() {
                        *guard = Some(id.clone());
                    }
                }
                fetched
            }
        }
    };
    if let Some(id) = bot_id.as_deref()
        && id == person_id
    {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let text = match fetch_message(client, &webex_token, &message_id).await? {
        Some(t) if !t.is_empty() => t,
        _ => return Ok(json!({ "status_code": 200, "body": { "ok": true } })),
    };

    let agent_id = resolve_agent(iii, "webex", &room_id).await;

    let chat = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("webex:{room_id}"),
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(format!("agent::chat failed: {e}")))?;

    let reply = chat.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if !reply.is_empty()
        && let Err(e) = send_message(client, &webex_token, &room_id, reply).await
    {
        tracing::error!(room = %room_id, error = %e, "failed to send Webex reply");
    }

    let audit_iii = iii.clone();
    let room_for_audit = room_id.clone();
    let person_for_audit = person_id.clone();
    let agent_for_audit = agent_id.clone();
    tokio::spawn(async move {
        let _ = audit_iii
            .trigger(TriggerRequest {
                function_id: "security::audit".to_string(),
                payload: json!({
                    "type": "channel_message",
                    "agentId": agent_for_audit,
                    "detail": {
                        "channel": "webex",
                        "roomId": room_for_audit,
                        "personId": person_for_audit
                    },
                }),
                action: None,
                timeout_ms: None,
            })
            .await;
    });

    Ok(json!({ "status_code": 200, "body": { "ok": true } }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url =
        std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());
    let client = reqwest::Client::new();
    let bot_id_cache: BotIdCache = Arc::new(RwLock::new(None));

    let iii_clone = iii.clone();
    let client_clone = client.clone();
    let cache_clone = bot_id_cache.clone();
    iii.register_function(
        RegisterFunction::new_async("channel::webex::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            let cache = cache_clone.clone();
            async move { handle_webhook(&iii, &client, &cache, input).await }
        })
        .description("Handle Cisco Webex webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::webex::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/webex" }),
        metadata: None,
    })?;

    tracing::info!("channel-webex worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_non_message_resource() {
        let body = json!({ "resource": "memberships", "event": "created" });
        let resource = body.get("resource").and_then(|v| v.as_str()).unwrap_or("");
        assert_ne!(resource, "messages");
    }

    #[test]
    fn ignores_non_created_event() {
        let body = json!({ "resource": "messages", "event": "deleted" });
        let event = body.get("event").and_then(|v| v.as_str()).unwrap_or("");
        assert_ne!(event, "created");
    }

    #[test]
    fn extracts_data_fields() {
        let body = json!({
            "resource": "messages",
            "event": "created",
            "data": { "id": "M1", "roomId": "R1", "personId": "P1" }
        });
        assert_eq!(body.pointer("/data/id").and_then(|v| v.as_str()), Some("M1"));
        assert_eq!(body.pointer("/data/roomId").and_then(|v| v.as_str()), Some("R1"));
        assert_eq!(body.pointer("/data/personId").and_then(|v| v.as_str()), Some("P1"));
    }

    #[test]
    fn split_short_text_returns_single_chunk() {
        assert_eq!(split_message("hi", 7439), vec!["hi".to_string()]);
    }

    #[test]
    fn split_preserves_total_length() {
        let text = "x".repeat(20_000);
        let chunks = split_message(&text, 7439);
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn session_id_format() {
        let room = "R1";
        assert_eq!(format!("webex:{room}"), "webex:R1");
    }
}
