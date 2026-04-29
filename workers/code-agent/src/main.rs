use iii_sdk::error::IIIError;
use iii_sdk::{InitOptions, RegisterFunction, register_worker};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const MAX_TIMEOUT_MS: u64 = 30_000;
const MAX_OUTPUT_LENGTH: usize = 100_000;

/// Truncate `s` to at most `max_bytes` bytes, snapping back to the nearest
/// preceding UTF-8 char boundary so we never panic on non-ASCII output.
fn truncate_to_char_boundary(s: &mut String, max_bytes: usize) {
    if s.len() <= max_bytes {
        return;
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
}

fn detect_code_blocks(response: &str) -> Vec<String> {
    let re = Regex::new(r"(?s)```(?:typescript|javascript|ts|js)\n(.*?)```").unwrap();
    re.captures_iter(response)
        .filter_map(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn truncate_result(value: Value) -> Value {
    let s = serde_json::to_string(&value).unwrap_or_default();
    if s.len() <= MAX_OUTPUT_LENGTH {
        value
    } else {
        let preview: String = s.chars().take(MAX_OUTPUT_LENGTH).collect();
        json!({ "truncated": true, "preview": preview })
    }
}

fn run_sandboxed_js(code: &str, deadline: Instant, cancelled: Arc<AtomicBool>) -> (Value, String) {
    use rquickjs::{Context, Runtime};

    let runtime = match Runtime::new() {
        Ok(r) => r,
        Err(e) => return (json!({ "error": format!("runtime init failed: {e}") }), String::new()),
    };
    runtime.set_memory_limit(64 * 1024 * 1024);

    // Cooperative cancellation: QuickJS calls this every ~10k bytecode ops.
    // Returning true raises an uncatchable exception, so a `while(true){}`
    // payload terminates within milliseconds of the deadline.
    {
        let cancelled = cancelled.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline
        })));
    }

    let ctx = match Context::full(&runtime) {
        Ok(c) => c,
        Err(e) => return (json!({ "error": format!("context init failed: {e}") }), String::new()),
    };

    let wrapped = format!(
        r#"
        (function() {{
            var __out = [];
            var console = {{ log: function() {{
                var parts = [];
                for (var i = 0; i < arguments.length; i++) {{
                    var a = arguments[i];
                    parts.push(typeof a === 'string' ? a : JSON.stringify(a));
                }}
                __out.push(parts.join(' '));
            }}, error: function() {{}}, warn: function() {{}} }};
            var setTimeout, setInterval, process, require, eval, Function;
            var __result = (function(){{
                {code}
            }})();
            return JSON.stringify({{ result: __result, stdout: __out.join('\n') }});
        }})()
        "#
    );

    ctx.with(|c| -> (Value, String) {
        match c.eval::<rquickjs::String, _>(wrapped.as_str()) {
            Ok(s) => match s.to_string() {
                Ok(json_str) => match serde_json::from_str::<Value>(&json_str) {
                    Ok(v) => {
                        let result = v.get("result").cloned().unwrap_or(Value::Null);
                        let stdout = v
                            .get("stdout")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        let mut stdout_trim = stdout;
                        truncate_to_char_boundary(&mut stdout_trim, MAX_OUTPUT_LENGTH);
                        (truncate_result(result), stdout_trim)
                    }
                    Err(e) => (json!({ "error": format!("decode result: {e}") }), String::new()),
                },
                Err(e) => (json!({ "error": format!("to_string: {e}") }), String::new()),
            },
            Err(e) => (json!({ "error": e.to_string() }), String::new()),
        }
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("agent::code_detect", move |input: Value| async move {
            let response = input["response"].as_str().unwrap_or("").to_string();
            if response.is_empty() {
                return Ok::<Value, IIIError>(json!({ "hasCode": false, "blocks": [] }));
            }
            let blocks = detect_code_blocks(&response);
            let has_code = !blocks.is_empty();
            Ok(json!({ "hasCode": has_code, "blocks": blocks }))
        })
        .description("Detect executable code blocks in LLM response"),
    );

    iii.register_function(
        RegisterFunction::new_async("agent::code_execute", move |input: Value| async move {
            let code = input["code"].as_str().unwrap_or("").to_string();
            let agent_id = input["agentId"].as_str().unwrap_or("").to_string();
            let raw_timeout = input["timeout"].as_u64().unwrap_or(DEFAULT_TIMEOUT_MS);
            if code.is_empty() || agent_id.is_empty() {
                return Ok::<Value, IIIError>(json!({
                    "result": { "error": "code and agentId required" },
                    "stdout": "",
                    "executionTimeMs": 0,
                }));
            }
            let timeout_ms = raw_timeout.clamp(1_000, MAX_TIMEOUT_MS);

            let start = Instant::now();
            let deadline = start + Duration::from_millis(timeout_ms);
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancelled_for_task = cancelled.clone();
            let join =
                tokio::task::spawn_blocking(move || run_sandboxed_js(&code, deadline, cancelled_for_task));
            // Outer timeout has a small grace period; the interrupt handler is
            // the real enforcement mechanism.
            let outcome = tokio::time::timeout(Duration::from_millis(timeout_ms + 1_000), join).await;

            match outcome {
                Ok(Ok((result, stdout))) => Ok(json!({
                    "result": result,
                    "stdout": stdout,
                    "executionTimeMs": start.elapsed().as_millis() as u64,
                })),
                Ok(Err(e)) => Ok(json!({
                    "result": { "error": format!("worker join error: {e}") },
                    "stdout": "",
                    "executionTimeMs": start.elapsed().as_millis() as u64,
                })),
                Err(_) => {
                    // Flip the flag so the QuickJS interrupt handler aborts
                    // execution at the next opportunity.
                    cancelled.store(true, Ordering::Relaxed);
                    Ok(json!({
                        "result": { "error": "execution timeout" },
                        "stdout": "",
                        "executionTimeMs": timeout_ms,
                    }))
                }
            }
        })
        .description("Execute agent-written JavaScript in a sandboxed QuickJS context"),
    );

    tracing::info!("code-agent worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_typescript_block() {
        let blocks = detect_code_blocks("```typescript\nlet x = 1;\n```");
        assert_eq!(blocks, vec!["let x = 1;".to_string()]);
    }

    #[test]
    fn ignores_other_languages() {
        let blocks = detect_code_blocks("```python\nprint(1)\n```");
        assert!(blocks.is_empty());
    }

    #[test]
    fn detects_multiple_blocks() {
        let response = "Hello\n```js\nconsole.log(1)\n```\n```ts\nconst x = 2\n```\n";
        let blocks = detect_code_blocks(response);
        assert_eq!(blocks.len(), 2);
    }
}
