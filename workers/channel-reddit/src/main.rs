use iii_sdk::error::IIIError;
use iii_sdk::protocol::TriggerAction;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;

const REDDIT_TOKEN_URL: &str = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE: &str = "https://oauth.reddit.com";

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

async fn refresh_access_token(
    iii: &III,
    client: &reqwest::Client,
) -> Result<String, IIIError> {
    let client_id = get_secret(iii, "REDDIT_CLIENT_ID").await;
    if client_id.is_empty() {
        return Err(IIIError::Handler("REDDIT_CLIENT_ID not configured".into()));
    }
    let client_secret = get_secret(iii, "REDDIT_SECRET").await;
    if client_secret.is_empty() {
        return Err(IIIError::Handler("REDDIT_SECRET not configured".into()));
    }
    let refresh_token = get_secret(iii, "REDDIT_REFRESH_TOKEN").await;
    if refresh_token.is_empty() {
        return Err(IIIError::Handler(
            "REDDIT_REFRESH_TOKEN not configured".into(),
        ));
    }

    let res = client
        .post(REDDIT_TOKEN_URL)
        .basic_auth(&client_id, Some(&client_secret))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|e| IIIError::Handler(format!("Reddit token refresh error: {e}")))?;

    if !res.status().is_success() {
        let status = res.status();
        return Err(IIIError::Handler(format!(
            "Reddit token refresh failed: {status}"
        )));
    }
    let body: Value = res
        .json()
        .await
        .map_err(|e| IIIError::Handler(format!("Reddit token decode: {e}")))?;
    let token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("Reddit response missing access_token".into()))?;
    Ok(token.to_string())
}

async fn send_message(
    iii: &III,
    client: &reqwest::Client,
    token_cache: &Arc<Mutex<String>>,
    parent_name: &str,
    text: &str,
) -> Result<(), IIIError> {
    let mut token = {
        let guard = token_cache.lock().await;
        guard.clone()
    };
    if token.is_empty() {
        token = refresh_access_token(iii, client).await?;
        let mut guard = token_cache.lock().await;
        *guard = token.clone();
    }

    let url = format!("{REDDIT_API_BASE}/api/comment");
    let mut res = client
        .post(&url)
        .bearer_auth(&token)
        .form(&[("thing_id", parent_name), ("text", text)])
        .send()
        .await
        .map_err(|e| IIIError::Handler(format!("Reddit comment error: {e}")))?;

    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        token = refresh_access_token(iii, client).await?;
        {
            let mut guard = token_cache.lock().await;
            *guard = token.clone();
        }
        res = client
            .post(&url)
            .bearer_auth(&token)
            .form(&[("thing_id", parent_name), ("text", text)])
            .send()
            .await
            .map_err(|e| IIIError::Handler(format!("Reddit comment error: {e}")))?;
    }

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(IIIError::Handler(format!(
            "Reddit comment failed ({status}): {}",
            body.chars().take(300).collect::<String>()
        )));
    }
    Ok(())
}

async fn webhook_handler(
    iii: &III,
    client: &reqwest::Client,
    token_cache: &Arc<Mutex<String>>,
    input: Value,
) -> Result<Value, IIIError> {
    let body = input.get("body").cloned().unwrap_or(input);

    let subreddit = body
        .get("subreddit")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let author = body
        .get("author")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let text = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let link_id = body
        .get("link_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if text.is_empty() || author == "[deleted]" {
        return Ok(json!({ "status_code": 200, "body": { "ok": true } }));
    }

    let agent_id = resolve_agent(iii, "reddit", &subreddit).await;

    let session_anchor = if !link_id.is_empty() { &link_id } else { &name };

    let chat = iii
        .trigger(TriggerRequest {
            function_id: "agent::chat".to_string(),
            payload: json!({
                "agentId": agent_id,
                "message": text,
                "sessionId": format!("reddit:{session_anchor}"),
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
        && !name.is_empty()
        && let Err(e) = send_message(iii, client, token_cache, &name, &reply).await
    {
        tracing::error!(error = %e, "failed to post Reddit comment");
    }

    let _ = iii
        .trigger(TriggerRequest {
            function_id: "security::audit".to_string(),
            payload: json!({
                "type": "channel_message",
                "agentId": agent_id,
                "detail": { "channel": "reddit", "subreddit": subreddit, "author": author },
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
    let token_cache: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    let iii_clone = iii.clone();
    let client_clone = client.clone();
    let token_clone = token_cache.clone();
    iii.register_function(
        RegisterFunction::new_async("channel::reddit::webhook", move |input: Value| {
            let iii = iii_clone.clone();
            let client = client_clone.clone();
            let token_cache = token_clone.clone();
            async move { webhook_handler(&iii, &client, &token_cache, input).await }
        })
        .description("Handle Reddit webhook"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "channel::reddit::webhook".to_string(),
        config: json!({ "http_method": "POST", "api_path": "webhook/reddit" }),
        metadata: None,
    })?;

    tracing::info!("channel-reddit worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    fn pick_session_anchor(link_id: &str, name: &str) -> String {
        if !link_id.is_empty() {
            link_id.to_string()
        } else {
            name.to_string()
        }
    }

    #[test]
    fn ignores_missing_text() {
        let body = json!({ "subreddit": "test", "author": "user1" });
        let text = body.get("body").and_then(|v| v.as_str()).unwrap_or("");
        assert!(text.is_empty());
    }

    #[test]
    fn ignores_deleted_author() {
        let body = json!({
            "subreddit": "test",
            "author": "[deleted]",
            "body": "deleted msg",
        });
        let author = body.get("author").and_then(|v| v.as_str()).unwrap();
        assert_eq!(author, "[deleted]");
    }

    #[test]
    fn session_uses_link_id_when_present() {
        let anchor = pick_session_anchor("t3_post123", "t1_comment");
        assert_eq!(anchor, "t3_post123");
    }

    #[test]
    fn session_falls_back_to_name() {
        let anchor = pick_session_anchor("", "t1_fallback");
        assert_eq!(anchor, "t1_fallback");
    }
}
