use iii_sdk::iii::III;
use iii_sdk::error::IIIError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRule {
    pub pattern: String,
    pub action: PolicyAction,
    pub scope: PolicyScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PolicyAction {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PolicyScope {
    Agent,
    Global,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyConfig {
    pub rules: Vec<PolicyRule>,
    #[serde(rename = "maxSubagentDepth")]
    pub max_subagent_depth: Option<u32>,
    #[serde(rename = "maxConcurrency")]
    pub max_concurrency: Option<u32>,
}

fn glob_matches(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();

    if parts.len() == 1 {
        return pattern == name;
    }

    let mut pos = 0usize;

    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }

        match name[pos..].find(part) {
            Some(found) => {
                if i == 0 && found != 0 {
                    return false;
                }
                pos += found + part.len();
            }
            None => return false,
        }
    }

    if let Some(last) = parts.last()
        && !last.is_empty() && !name.ends_with(last)
    {
        return false;
    }

    true
}

fn evaluate_rules(rules: &[PolicyRule], tool_name: &str) -> Option<PolicyAction> {
    for rule in rules {
        if glob_matches(&rule.pattern, tool_name) {
            return Some(rule.action);
        }
    }
    None
}

pub fn check_policy(
    agent_rules: &[PolicyRule],
    global_rules: &[PolicyRule],
    tool_name: &str,
) -> PolicyAction {
    if let Some(action) = evaluate_rules(agent_rules, tool_name) {
        return action;
    }

    if let Some(action) = evaluate_rules(global_rules, tool_name) {
        return action;
    }

    PolicyAction::Deny
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow_rule(pattern: &str) -> PolicyRule {
        PolicyRule {
            pattern: pattern.to_string(),
            action: PolicyAction::Allow,
            scope: PolicyScope::Agent,
        }
    }

    fn deny_rule(pattern: &str) -> PolicyRule {
        PolicyRule {
            pattern: pattern.to_string(),
            action: PolicyAction::Deny,
            scope: PolicyScope::Global,
        }
    }

    #[test]
    fn test_glob_matches_exact() {
        assert!(glob_matches("file::read", "file::read"));
        assert!(!glob_matches("file::read", "file::write"));
    }

    #[test]
    fn test_glob_matches_wildcard_suffix() {
        assert!(glob_matches("file::*", "file::read"));
        assert!(glob_matches("file::*", "file::write"));
        assert!(!glob_matches("file::*", "network::send"));
    }

    #[test]
    fn test_glob_matches_wildcard_prefix() {
        assert!(glob_matches("*::read", "file::read"));
        assert!(glob_matches("*::read", "network::read"));
        assert!(!glob_matches("*::read", "file::write"));
    }

    #[test]
    fn test_glob_matches_wildcard_middle() {
        assert!(glob_matches("file::*::v2", "file::read::v2"));
        assert!(!glob_matches("file::*::v2", "file::read::v3"));
    }

    #[test]
    fn test_glob_matches_star_only() {
        assert!(glob_matches("*", "anything"));
        assert!(glob_matches("*", "file::read"));
    }

    #[test]
    fn test_glob_matches_no_wildcard_mismatch() {
        assert!(!glob_matches("file::read", "file::write"));
    }

    #[test]
    fn test_glob_matches_empty_pattern_empty_name() {
        assert!(glob_matches("", ""));
    }

    #[test]
    fn test_glob_matches_pattern_must_match_start() {
        assert!(!glob_matches("file*", "myfile"));
    }

    #[test]
    fn test_glob_matches_pattern_must_match_end() {
        assert!(!glob_matches("*read", "read_more"));
    }

    #[test]
    fn test_evaluate_rules_first_match_wins() {
        let rules = vec![
            allow_rule("file::*"),
            deny_rule("file::delete"),
        ];
        assert_eq!(evaluate_rules(&rules, "file::delete"), Some(PolicyAction::Allow));
    }

    #[test]
    fn test_evaluate_rules_no_match() {
        let rules = vec![allow_rule("file::*")];
        assert_eq!(evaluate_rules(&rules, "network::send"), None);
    }

    #[test]
    fn test_evaluate_rules_empty_rules() {
        let rules: Vec<PolicyRule> = vec![];
        assert_eq!(evaluate_rules(&rules, "anything"), None);
    }

    #[test]
    fn test_evaluate_rules_deny_match() {
        let rules = vec![deny_rule("network::*")];
        assert_eq!(evaluate_rules(&rules, "network::send"), Some(PolicyAction::Deny));
    }

    #[test]
    fn test_check_policy_agent_rules_take_precedence() {
        let agent_rules = vec![allow_rule("file::read")];
        let global_rules = vec![deny_rule("file::*")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::read"), PolicyAction::Allow);
    }

    #[test]
    fn test_check_policy_falls_through_to_global() {
        let agent_rules = vec![allow_rule("memory::*")];
        let global_rules = vec![allow_rule("file::read")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::read"), PolicyAction::Allow);
    }

    #[test]
    fn test_check_policy_default_deny() {
        let agent_rules: Vec<PolicyRule> = vec![];
        let global_rules: Vec<PolicyRule> = vec![];
        assert_eq!(check_policy(&agent_rules, &global_rules, "anything"), PolicyAction::Deny);
    }

    #[test]
    fn test_check_policy_global_deny() {
        let agent_rules: Vec<PolicyRule> = vec![];
        let global_rules = vec![deny_rule("*")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::read"), PolicyAction::Deny);
    }

    #[test]
    fn test_check_policy_global_allow_all() {
        let agent_rules: Vec<PolicyRule> = vec![];
        let global_rules = vec![allow_rule("*")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "anything"), PolicyAction::Allow);
    }

    #[test]
    fn test_check_policy_agent_deny_overrides_global_allow() {
        let agent_rules = vec![deny_rule("file::delete")];
        let global_rules = vec![allow_rule("file::*")];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::delete"), PolicyAction::Deny);
    }

    #[test]
    fn test_policy_config_serialization() {
        let config = PolicyConfig {
            rules: vec![allow_rule("file::*")],
            max_subagent_depth: Some(3),
            max_concurrency: Some(5),
        };
        let serialized = serde_json::to_value(&config).unwrap();
        assert_eq!(serialized["maxSubagentDepth"], 3);
        assert_eq!(serialized["maxConcurrency"], 5);
        assert_eq!(serialized["rules"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_policy_config_deserialization() {
        let json_val = json!({
            "rules": [{"pattern": "test::*", "action": "Allow", "scope": "Agent"}],
            "maxSubagentDepth": 10,
            "maxConcurrency": 20,
        });
        let config: PolicyConfig = serde_json::from_value(json_val).unwrap();
        assert_eq!(config.max_subagent_depth, Some(10));
        assert_eq!(config.max_concurrency, Some(20));
        assert_eq!(config.rules.len(), 1);
        assert_eq!(config.rules[0].pattern, "test::*");
    }

    #[test]
    fn test_policy_config_optional_fields() {
        let json_val = json!({"rules": []});
        let config: PolicyConfig = serde_json::from_value(json_val).unwrap();
        assert_eq!(config.max_subagent_depth, None);
        assert_eq!(config.max_concurrency, None);
    }

    #[test]
    fn test_policy_action_equality() {
        assert_eq!(PolicyAction::Allow, PolicyAction::Allow);
        assert_eq!(PolicyAction::Deny, PolicyAction::Deny);
        assert_ne!(PolicyAction::Allow, PolicyAction::Deny);
    }

    #[test]
    fn test_policy_scope_equality() {
        assert_eq!(PolicyScope::Agent, PolicyScope::Agent);
        assert_eq!(PolicyScope::Global, PolicyScope::Global);
        assert_ne!(PolicyScope::Agent, PolicyScope::Global);
    }

    #[test]
    fn test_policy_rule_serialization_roundtrip() {
        let rule = allow_rule("tool::*");
        let serialized = serde_json::to_string(&rule).unwrap();
        let deserialized: PolicyRule = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.pattern, "tool::*");
    }

    #[test]
    fn test_glob_matches_double_star() {
        assert!(glob_matches("**", "anything::at::all"));
    }

    #[test]
    fn test_check_policy_multiple_agent_rules() {
        let agent_rules = vec![
            deny_rule("file::delete"),
            allow_rule("file::*"),
        ];
        let global_rules: Vec<PolicyRule> = vec![];
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::delete"), PolicyAction::Deny);
        assert_eq!(check_policy(&agent_rules, &global_rules, "file::read"), PolicyAction::Allow);
    }
}

pub fn register(iii: &III) {
    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "policy::check",
        "Check if a tool invocation is allowed by policy",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("");
                let tool_name = input["tool"].as_str().unwrap_or("");
                let subagent_depth = input["subagentDepth"].as_u64().unwrap_or(0) as u32;
                let current_concurrency = input["currentConcurrency"].as_u64().unwrap_or(0) as u32;

                let agent_policy: Option<PolicyConfig> = iii
                    .trigger("state::get", json!({
                        "scope": "policies",
                        "key": agent_id,
                    }))
                    .await
                    .ok()
                    .and_then(|v| serde_json::from_value(v).ok());

                let global_policy: Option<PolicyConfig> = iii
                    .trigger("state::get", json!({
                        "scope": "policies",
                        "key": "__global",
                    }))
                    .await
                    .ok()
                    .and_then(|v| serde_json::from_value(v).ok());

                let agent_rules = agent_policy.as_ref()
                    .map(|p| p.rules.as_slice())
                    .unwrap_or(&[]);

                let global_rules = global_policy.as_ref()
                    .map(|p| p.rules.as_slice())
                    .unwrap_or(&[]);

                let action = check_policy(agent_rules, global_rules, tool_name);

                let max_depth = agent_policy.as_ref()
                    .and_then(|p| p.max_subagent_depth)
                    .or(global_policy.as_ref().and_then(|p| p.max_subagent_depth))
                    .unwrap_or(5);

                if subagent_depth > max_depth {
                    return Ok(json!({
                        "allowed": false,
                        "reason": "subagent_depth_exceeded",
                        "maxDepth": max_depth,
                        "currentDepth": subagent_depth,
                    }));
                }

                let max_concurrency = agent_policy.as_ref()
                    .and_then(|p| p.max_concurrency)
                    .or(global_policy.as_ref().and_then(|p| p.max_concurrency))
                    .unwrap_or(10);

                if current_concurrency >= max_concurrency {
                    return Ok(json!({
                        "allowed": false,
                        "reason": "concurrency_limit_exceeded",
                        "maxConcurrency": max_concurrency,
                        "currentConcurrency": current_concurrency,
                    }));
                }

                let allowed = action == PolicyAction::Allow;

                Ok(json!({
                    "allowed": allowed,
                    "action": action,
                    "tool": tool_name,
                    "agentId": agent_id,
                }))
            }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "policy::set_rules",
        "Set policy rules for an agent or globally",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let key = input["agentId"]
                    .as_str()
                    .unwrap_or("__global")
                    .to_string();

                let policy: PolicyConfig = serde_json::from_value(
                    input.get("policy").cloned().unwrap_or(json!({ "rules": [] }))
                ).map_err(|e| IIIError::Handler(e.to_string()))?;

                iii.trigger("state::set", json!({
                    "scope": "policies",
                    "key": &key,
                    "value": &policy,
                })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

                iii.trigger_void("security::audit", json!({
                    "type": "policy_updated",
                    "agentId": &key,
                    "detail": { "ruleCount": policy.rules.len() },
                }))?;

                Ok(json!({ "updated": true, "key": key, "ruleCount": policy.rules.len() }))
            }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "policy::get_rules",
        "Get policy rules for an agent or globally",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let key = input["agentId"]
                    .as_str()
                    .unwrap_or("__global");

                let policy: Value = iii
                    .trigger("state::get", json!({
                        "scope": "policies",
                        "key": key,
                    }))
                    .await
                    .unwrap_or(json!({ "rules": [], "maxSubagentDepth": 5, "maxConcurrency": 10 }));

                Ok(json!({
                    "key": key,
                    "policy": policy,
                }))
            }
        },
    );
}
