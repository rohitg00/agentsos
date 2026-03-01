use iii_sdk::iii::III;
use iii_sdk::error::IIIError;
use serde_json::{json, Value};
use std::time::Instant;

mod types;

use types::{AgentConfig, ChatRequest, ToolCall};

const MAX_ITERATIONS: u32 = 50;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = III::new("ws://localhost:49134");
    iii.connect().await?;

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::chat",
        "Process a message through the agent loop",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: ChatRequest = serde_json::from_value(input)
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                agent_chat(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::list_tools",
        "List tools available to an agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("default");
                list_tools(&iii, agent_id).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::create",
        "Register a new agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let config: AgentConfig = serde_json::from_value(input)
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                create_agent(&iii, config).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::list",
        "List all agents",
        move |_: Value| {
            let iii = iii_clone.clone();
            async move {
                iii.trigger("state::list", json!({ "scope": "agents" })).await
                    .map_err(|e| IIIError::Handler(e.to_string()))
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "agent::delete",
        "Remove an agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("");
                iii.trigger("state::delete", json!({
                    "scope": "agents",
                    "key": agent_id,
                })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

                let _ = iii.trigger_void("publish", json!({
                    "topic": "agent.lifecycle",
                    "data": { "type": "deleted", "agentId": agent_id },
                }));

                Ok(json!({ "deleted": true }))
            }
        },
    );

    iii.register_trigger("queue", "agent::chat", json!({ "topic": "agent.inbox" }))?;

    tracing::info!("agent-core worker connected");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

async fn agent_chat(iii: &III, req: ChatRequest) -> Result<Value, IIIError> {
    let start = Instant::now();

    let config: Option<AgentConfig> = iii
        .trigger("state::get", json!({
            "scope": "agents",
            "key": &req.agent_id,
        }))
        .await
        .ok()
        .and_then(|v| serde_json::from_value(v).ok());

    let memories: Value = iii
        .trigger("memory::recall", json!({
            "agentId": &req.agent_id,
            "query": &req.message,
            "limit": 20,
        }))
        .await
        .unwrap_or(json!([]));

    let tools: Value = iii
        .trigger("agent::list_tools", json!({ "agentId": &req.agent_id }))
        .await
        .unwrap_or(json!([]));

    let system_prompt = req.system_prompt
        .or_else(|| config.as_ref().and_then(|c| c.system_prompt.clone()))
        .unwrap_or_default();

    let model: Value = iii
        .trigger("llm::route", json!({
            "message": &req.message,
            "toolCount": tools.as_array().map(|a| a.len()).unwrap_or(0),
            "config": config.as_ref().and_then(|c| c.model.as_ref()),
        }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let scan_result = iii
        .trigger("security::scan_injection", json!({ "text": &req.message }))
        .await
        .unwrap_or(json!({ "safe": true, "riskScore": 0.0 }));
    let risk_score = scan_result["riskScore"].as_f64().unwrap_or(0.0);
    if risk_score > 0.5 {
        return Err(IIIError::Handler(format!(
            "Message rejected: injection risk score {:.2} exceeds threshold",
            risk_score
        )));
    }

    let mut messages = vec![];
    if let Some(mems) = memories.as_array() {
        messages.extend(mems.iter().cloned());
    }
    messages.push(json!({ "role": "user", "content": &req.message }));

    let mut response: Value = iii
        .trigger("llm::complete", json!({
            "model": model,
            "systemPrompt": system_prompt,
            "messages": messages,
            "tools": tools,
        }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut iterations: u32 = 0;

    while let Some(tool_calls) = response.get("toolCalls").and_then(|v| v.as_array()) {
        if tool_calls.is_empty() || iterations >= MAX_ITERATIONS {
            break;
        }
        iterations += 1;

        let calls: Vec<ToolCall> = tool_calls
            .iter()
            .filter_map(|tc| serde_json::from_value(tc.clone()).ok())
            .collect();

        let mut tool_results = Vec::new();
        for tc in &calls {
            let cap_check = iii.trigger("security::check_capability", json!({
                "agentId": &req.agent_id,
                "capability": tc.id.split("::").next().unwrap_or(""),
                "resource": &tc.id,
            })).await;

            if cap_check.is_err() {
                tool_results.push(json!({
                    "toolCallId": tc.call_id,
                    "output": { "error": "capability denied" },
                }));
                continue;
            }

            match iii.trigger(&tc.id, tc.arguments.clone()).await {
                Ok(result) => {
                    tool_results.push(json!({
                        "toolCallId": tc.call_id,
                        "output": result,
                    }));
                }
                Err(e) => {
                    tool_results.push(json!({
                        "toolCallId": tc.call_id,
                        "output": { "error": e.to_string() },
                    }));
                }
            }
        }

        messages.push(json!({ "role": "assistant", "content": null, "tool_calls": response.get("toolCalls") }));
        for tr in &tool_results {
            messages.push(json!({ "role": "tool", "tool_call_id": tr["toolCallId"], "content": tr["output"].to_string() }));
        }

        response = iii
            .trigger("llm::complete", json!({
                "model": model,
                "systemPrompt": system_prompt,
                "messages": messages,
                "tools": tools,
            }))
            .await
            .map_err(|e| IIIError::Handler(e.to_string()))?;
    }

    let session_id = req.session_id
        .unwrap_or_else(|| format!("default:{}", req.agent_id));

    let _ = iii.trigger_void("memory::store", json!({
        "agentId": &req.agent_id,
        "sessionId": &session_id,
        "role": "user",
        "content": &req.message,
    }));

    let _ = iii.trigger_void("memory::store", json!({
        "agentId": &req.agent_id,
        "sessionId": &session_id,
        "role": "assistant",
        "content": response.get("content").and_then(|v| v.as_str()).unwrap_or(""),
        "tokenUsage": response.get("usage"),
    }));

    let _ = iii.trigger_void("state::update", json!({
        "scope": "metering",
        "key": &req.agent_id,
        "operations": [
            { "type": "increment", "path": "totalTokens", "value": response["usage"]["total"] },
            { "type": "increment", "path": "invocations", "value": 1 },
        ],
    }));

    Ok(json!({
        "content": response.get("content").and_then(|v| v.as_str()).unwrap_or(""),
        "model": response.get("model"),
        "usage": response.get("usage"),
        "iterations": iterations,
        "durationMs": start.elapsed().as_millis(),
    }))
}

async fn list_tools(iii: &III, agent_id: &str) -> Result<Value, IIIError> {
    let config: Option<AgentConfig> = iii
        .trigger("state::get", json!({ "scope": "agents", "key": agent_id }))
        .await
        .ok()
        .and_then(|v| serde_json::from_value(v).ok());

    let allowed = config
        .as_ref()
        .and_then(|c| c.capabilities.as_ref())
        .map(|c| c.tools.clone())
        .unwrap_or_else(|| vec!["*".into()]);

    let all_functions: Value = iii
        .trigger("engine::functions::list", json!({}))
        .await
        .unwrap_or(json!([]));

    if allowed.contains(&"*".to_string()) {
        return Ok(all_functions);
    }

    let filtered: Vec<&Value> = all_functions
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|f| {
                    let id = f["id"].as_str().unwrap_or("");
                    allowed.iter().any(|a| id.starts_with(a.as_str()))
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(json!(filtered))
}

#[cfg(test)]
mod tests {
    use super::*;
    use types::{ModelConfig, Capabilities, Resources};

    #[test]
    fn test_max_iterations_constant() {
        assert_eq!(MAX_ITERATIONS, 50);
    }

    #[test]
    fn test_chat_request_from_json() {
        let json_val = json!({
            "agentId": "agent-test",
            "message": "Hello world",
        });
        let req: ChatRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.agent_id, "agent-test");
        assert_eq!(req.message, "Hello world");
    }

    #[test]
    fn test_chat_request_requires_agent_id() {
        let json_val = json!({
            "message": "Hello",
        });
        let result: Result<ChatRequest, _> = serde_json::from_value(json_val);
        assert!(result.is_err());
    }

    #[test]
    fn test_chat_request_requires_message() {
        let json_val = json!({
            "agentId": "test",
        });
        let result: Result<ChatRequest, _> = serde_json::from_value(json_val);
        assert!(result.is_err());
    }

    #[test]
    fn test_tool_call_parsing() {
        let json_val = json!({
            "callId": "tc-1",
            "id": "memory::store",
            "arguments": {"content": "test data", "agentId": "agent-1"},
        });
        let tc: ToolCall = serde_json::from_value(json_val).unwrap();
        assert_eq!(tc.call_id, "tc-1");
        assert_eq!(tc.id, "memory::store");
        assert_eq!(tc.arguments["content"], "test data");
    }

    #[test]
    fn test_tool_call_id_split_for_capability() {
        let tc = ToolCall {
            call_id: "c-1".to_string(),
            id: "security::check_capability".to_string(),
            arguments: json!({}),
        };
        let capability = tc.id.split("::").next().unwrap_or("");
        assert_eq!(capability, "security");
    }

    #[test]
    fn test_tool_call_id_split_no_separator() {
        let tc = ToolCall {
            call_id: "c-2".to_string(),
            id: "simple_tool".to_string(),
            arguments: json!({}),
        };
        let capability = tc.id.split("::").next().unwrap_or("");
        assert_eq!(capability, "simple_tool");
    }

    #[test]
    fn test_agent_config_creation() {
        let config = AgentConfig {
            id: Some("test-id".to_string()),
            name: "Test Agent".to_string(),
            description: Some("A test agent".to_string()),
            model: Some(ModelConfig {
                provider: Some("anthropic".to_string()),
                model: Some("claude-sonnet-4-20250514".to_string()),
                max_tokens: Some(4096),
            }),
            system_prompt: Some("Be helpful".to_string()),
            capabilities: Some(Capabilities {
                tools: vec!["*".to_string()],
                memory_scopes: None,
                network_hosts: None,
            }),
            resources: Some(Resources {
                max_tokens_per_hour: Some(100000),
            }),
            tags: Some(vec!["test".to_string()]),
        };
        assert_eq!(config.name, "Test Agent");
        assert!(config.capabilities.unwrap().tools.contains(&"*".to_string()));
    }

    #[test]
    fn test_agent_config_id_fallback() {
        let config = AgentConfig {
            id: None,
            name: "NoIdAgent".to_string(),
            description: None,
            model: None,
            system_prompt: None,
            capabilities: None,
            resources: None,
            tags: None,
        };
        let id = config.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        assert!(!id.is_empty());
    }

    #[test]
    fn test_system_prompt_fallback_chain() {
        let req_prompt = Some("request prompt".to_string());
        let config_prompt = Some("config prompt".to_string());

        let result = req_prompt.or(config_prompt).unwrap_or_default();
        assert_eq!(result, "request prompt");
    }

    #[test]
    fn test_system_prompt_fallback_to_config() {
        let req_prompt: Option<String> = None;
        let config_prompt = Some("config prompt".to_string());

        let result = req_prompt.or(config_prompt).unwrap_or_default();
        assert_eq!(result, "config prompt");
    }

    #[test]
    fn test_system_prompt_fallback_to_default() {
        let req_prompt: Option<String> = None;
        let config_prompt: Option<String> = None;

        let result = req_prompt.or(config_prompt).unwrap_or_default();
        assert_eq!(result, "");
    }

    #[test]
    fn test_session_id_default_format() {
        let agent_id = "agent-42";
        let session_id: Option<String> = None;
        let result = session_id.unwrap_or_else(|| format!("default:{}", agent_id));
        assert_eq!(result, "default:agent-42");
    }

    #[test]
    fn test_session_id_explicit() {
        let session_id = Some("custom-session".to_string());
        let result = session_id.unwrap_or_else(|| "default:x".to_string());
        assert_eq!(result, "custom-session");
    }

    #[test]
    fn test_tool_results_accumulation() {
        let mut results = Vec::new();
        results.push(json!({
            "toolCallId": "tc-1",
            "output": { "data": "result1" },
        }));
        results.push(json!({
            "toolCallId": "tc-2",
            "output": { "error": "denied" },
        }));
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["toolCallId"], "tc-1");
        assert_eq!(results[1]["output"]["error"], "denied");
    }

    #[test]
    fn test_message_building() {
        let mut messages: Vec<Value> = vec![];
        let memories = json!([
            {"role": "user", "content": "previous question"},
            {"role": "assistant", "content": "previous answer"},
        ]);

        if let Some(mems) = memories.as_array() {
            messages.extend(mems.iter().cloned());
        }
        messages.push(json!({"role": "user", "content": "new question"}));

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[2]["content"], "new question");
    }

    #[test]
    fn test_wildcard_tool_filter() {
        let allowed = vec!["*".to_string()];
        assert!(allowed.contains(&"*".to_string()));
    }

    #[test]
    fn test_tool_filter_prefix_match() {
        let allowed = vec!["file::".to_string(), "memory::".to_string()];
        let tool_id = "file::read";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(matches);
    }

    #[test]
    fn test_tool_filter_no_match() {
        let allowed = vec!["file::".to_string()];
        let tool_id = "network::send";
        let matches = allowed.iter().any(|a| tool_id.starts_with(a.as_str()));
        assert!(!matches);
    }

    #[test]
    fn test_risk_score_threshold() {
        let risk_score = 0.51;
        assert!(risk_score > 0.5);

        let risk_score = 0.49;
        assert!(risk_score <= 0.5);
    }

    #[test]
    fn test_iteration_limit() {
        let mut iterations: u32 = 0;
        while iterations < MAX_ITERATIONS {
            iterations += 1;
        }
        assert_eq!(iterations, 50);
    }
}

async fn create_agent(iii: &III, config: AgentConfig) -> Result<Value, IIIError> {
    let agent_id = config.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    iii.trigger("state::set", json!({
        "scope": "agents",
        "key": &agent_id,
        "value": {
            "id": &agent_id,
            "name": &config.name,
            "description": &config.description,
            "model": &config.model,
            "systemPrompt": &config.system_prompt,
            "capabilities": &config.capabilities,
            "resources": &config.resources,
            "tags": &config.tags,
            "createdAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
        },
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    let _ = iii.trigger_void("publish", json!({
        "topic": "agent.lifecycle",
        "data": { "type": "created", "agentId": &agent_id },
    }));

    Ok(json!({ "agentId": agent_id }))
}
