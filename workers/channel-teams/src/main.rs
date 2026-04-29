use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};

const AUTH_URL: &str = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const MAX_MESSAGE_LEN: usize = 4096;

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
        remaining = remaining[split_at..].to_string();
    }
    chunks
}

/// Exchange app credentials for a Bot Framework access token.
async fn get_token(client: &reqwest::Client, app_id: &str, app_password: &str) -> Result<String, IIIError> {
    if app_id.is_empty() || app_password.is_empty() {
        return Err(IIIError::Handler("Missing Teams credentials".into()));
    }
    let params = [
        ("grant_type", "client_credentials"),
        ("client_id", app_id),
        ("client_secret", app_password),
        ("scope", "https://api.botframework.com/.default"),
    ];
    let resp = client
        .post(AUTH_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| IIIError::Handler(format!("Teams token request failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(IIIError::Handler(format!("Token request failed: {status}")));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| IIIError::Handler(format!("Token decode: {e}")))?;
    body.get("access_token")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| IIIError::Handler("Token response missing access_token".into()))
}

async fn send_message(
    client: &reqwest::Client,
    token: &str,
    service_url: &str,
    conversation_id: &str,
    reply_to_id: &str,
    text: &str,
) -> Result<(), IIIError> {
    let url = format!(
        "{}/v3/conversations/{}/activities",
        service_url.trim_end_matches('/'),
        conversation_id
    );
    for chunk in split_message(text, MAX_MESSAGE_LEN) {
        let resp = client
            .post(&url)
            .bearer_auth(token)
            .json(&json!({
                "type": "message",
                "text": chunk,
                "replyToId": reply_to_id,
            }))
            .send()
            .await
            .map_err(|e| IIIError::Handler(format!("Teams send error: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(IIIError::Handler(format!(
                "Teams send failed ({status}): {}",
                body.chars().take(300).collect::<String>()
            )));
        }
    }
    Ok(())
}

async fn handle_webhook(
    iii: &III,
    client: &reqwest::Client,
    req: Value,
) -> Result<Value, IIIError> {
    let activity = req.get("body").cloned().unwrap_or_else(|| req.clone());

    if activity.get("type").and_then(|v| v.as_str()) != Some("message") {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let conversation_id = activity
        .get("conversation")
        .and_then(|c| c.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let text = activity.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let user_id = activity
        .get("from")
        .and_then(|f| f.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let service_url = activity
        .get("serviceUrl")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let activity_id = activity
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let agent_id = resolve_agent(iii, "teams", &conversation_id).await;

    let chat = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("teams:{conversation_id}"),
            }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(format!("agent::chat failed: {e}")))?;

    let reply = chat.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if !reply.is_empty() {
        let app_id = get_secret(iii, "TEAMS_APP_ID").await;
        let app_password = get_secret(iii, "TEAMS_APP_PASSWORD").await;
        match get_token(client, &app_id, &app_password).await {
            Ok(token) => {
                if let Err(e) = send_message(
                    client,
                    &token,
                    &service_url,
                    &conversation_id,
                    &activity_id,
                    reply,
                )
                .await
                {
                    tracing::error!(conversation = %conversation_id, error = %e, "failed to send Teams reply");
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "failed to acquire Teams token");
            }
        }
    }

    let audit_iii = iii.clone();
    let conv_for_audit = conversation_id.clone();
    let user_for_audit = user_id.clone();
    let agent_for_audit = agent_id.clone();
    tokio::spawn(async move {
        let _ = audit_iii
            .trigger(TriggerRequest {
                function_id: "security::audit".to_string(),
                payload: json!({
                    "type": "channel_message",
                    "agentId": agent_for_audit,
                    "detail": {
                        "channel": "teams",
                        "conversationId": conv_for_audit,
                        "userId": user_for_audit
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

    let iii_clone = iii.clone();
    let client_clone = client.clone();
    iii.register_function(
        RegisterFunction::new_async("channel::teams::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            async move { handle_webhook(&iii, &client, input).await }
        })
        .description("Handle Microsoft Teams Bot Framework webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::teams::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/teams" }),
        metadata: None,
    })?;

    tracing::info!("channel-teams worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_non_message_activity() {
        let activity = json!({ "type": "conversationUpdate" });
        assert_ne!(activity.get("type").and_then(|v| v.as_str()), Some("message"));
    }

    #[test]
    fn detects_message_activity() {
        let activity = json!({ "type": "message", "text": "hello" });
        assert_eq!(activity.get("type").and_then(|v| v.as_str()), Some("message"));
    }

    #[test]
    fn extracts_conversation_id() {
        let activity = json!({ "type": "message", "conversation": { "id": "conv-1" } });
        let id = activity
            .pointer("/conversation/id")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert_eq!(id, "conv-1");
    }

    #[test]
    fn session_id_format() {
        let conv = "conv-2";
        assert_eq!(format!("teams:{conv}"), "teams:conv-2");
    }

    #[test]
    fn split_short_text_returns_single_chunk() {
        assert_eq!(split_message("hi", 4096), vec!["hi".to_string()]);
    }

    #[test]
    fn split_preserves_total_length() {
        let text = "x".repeat(10_000);
        let chunks = split_message(&text, 4096);
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn url_with_trailing_slash_is_normalized() {
        let svc = "https://service.test.com/";
        let conv = "C1";
        let url = format!(
            "{}/v3/conversations/{}/activities",
            svc.trim_end_matches('/'),
            conv
        );
        assert_eq!(url, "https://service.test.com/v3/conversations/C1/activities");
    }
}
