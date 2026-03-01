use iii_sdk::iii::III;
use iii_sdk::error::IIIError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MemoryEntry {
    id: String,
    agent_id: String,
    content: String,
    role: String,
    embedding: Option<Vec<f64>>,
    timestamp: u64,
    session_id: Option<String>,
    importance: f64,
    hash: String,
    confidence: f64,
    access_count: u64,
    last_accessed: u64,
}


#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = III::new("ws://localhost:49134");
    iii.connect().await?;

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::store",
        "Store a memory entry with dedup",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { store_memory(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::recall",
        "Hybrid semantic + keyword + recency search",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { recall_memory(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::kg::add",
        "Add knowledge graph entity with bidirectional relations",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { kg_add(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::kg::query",
        "Traverse knowledge graph from entity",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { kg_query(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::evict",
        "Evict stale and low-importance memories",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { evict_memories(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::consolidate",
        "Decay confidence on unaccessed memories",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { consolidate(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::session::list",
        "List sessions for an agent",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move {
                let agent_id = input["agentId"].as_str().unwrap_or("default");
                iii.trigger("state::list", json!({ "scope": format!("sessions:{}", agent_id) }))
                    .await
                    .map_err(|e| IIIError::Handler(e.to_string()))
            }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::session::compact",
        "Compact session via LLM summarization",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { compact_session(&iii, input).await }
        },
    );

    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "memory::session::repair",
        "7-phase session validation and repair",
        move |input: Value| {
            let iii = iii_ref.clone();
            async move { repair_session(&iii, input).await }
        },
    );

    iii.register_trigger("cron", "memory::consolidate", json!({ "expression": "0 */6 * * *" }))?;

    iii.register_trigger("cron", "memory::evict", json!({ "expression": "0 3 * * *" }))?;

    tracing::info!("memory worker connected");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

async fn store_memory(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let content = input["content"].as_str().unwrap_or("");
    let role = input["role"].as_str().unwrap_or("user");
    let session_id = input["sessionId"].as_str().map(String::from);

    let hash = {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        format!("{:x}", hasher.finalize())
    };

    let existing: Option<Value> = iii
        .trigger("state::get", json!({
            "scope": format!("memory:{}", agent_id),
            "key": &hash,
        }))
        .await
        .ok();

    if existing.is_some() {
        return Ok(json!({ "deduplicated": true }));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();

    let embedding: Option<Vec<f64>> = iii
        .trigger("embedding::generate", json!({ "text": content }))
        .await
        .ok()
        .and_then(|v| {
            v.get("embedding")
                .and_then(|e| serde_json::from_value(e.clone()).ok())
        });

    let importance = estimate_importance(content, role);

    let entry = json!({
        "id": &id,
        "agentId": agent_id,
        "content": content,
        "role": role,
        "embedding": embedding,
        "timestamp": now,
        "sessionId": session_id,
        "importance": importance,
        "hash": &hash,
        "confidence": 1.0,
        "accessCount": 0_u64,
        "lastAccessed": now,
    });

    iii.trigger("state::set", json!({
        "scope": format!("memory:{}", agent_id),
        "key": &id,
        "value": &entry,
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": format!("memory:{}", agent_id),
        "key": &hash,
        "value": { "id": &id, "timestamp": now },
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    if let Some(sid) = &session_id {
        let _ = iii.trigger("state::update", json!({
            "scope": format!("sessions:{}", agent_id),
            "key": sid,
            "operations": [
                { "type": "merge", "path": "messages", "value": [{ "id": &id, "role": role, "timestamp": now }] },
                { "type": "set", "path": "updatedAt", "value": now },
            ],
        })).await;
    }

    Ok(json!({ "id": id, "stored": true }))
}

async fn recall_memory(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let query = input["query"].as_str().unwrap_or("");
    let limit = input["limit"].as_u64().unwrap_or(10) as usize;

    let entries: Value = iii
        .trigger("state::list", json!({ "scope": format!("memory:{}", agent_id) }))
        .await
        .unwrap_or(json!([]));

    let memories: Vec<MemoryEntry> = entries
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|e| {
            let val = e.get("value")?;
            if val.get("content").is_none() || val.get("role").is_none() {
                return None;
            }
            serde_json::from_value(val.clone()).ok()
        })
        .collect();

    if memories.is_empty() {
        return Ok(json!([]));
    }

    let query_embedding: Option<Vec<f64>> = iii
        .trigger("embedding::generate", json!({ "text": query }))
        .await
        .ok()
        .and_then(|v| {
            v.get("embedding")
                .and_then(|e| serde_json::from_value(e.clone()).ok())
        });

    let keywords: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();

    let now = now_ms();
    let mut scored: Vec<(f64, &MemoryEntry)> = memories
        .iter()
        .map(|m| {
            let mut score = 0.0_f64;

            if let (Some(qe), Some(me)) = (&query_embedding, &m.embedding) {
                score += cosine_similarity(qe, me) * 0.5;
            }

            let content_lower = m.content.to_lowercase();
            let hits = keywords.iter().filter(|k| content_lower.contains(k.as_str())).count();
            let keyword_score = hits as f64 / keywords.len().max(1) as f64;
            score += keyword_score * 0.25;

            let age_hours = (now.saturating_sub(m.timestamp)) as f64 / 3_600_000.0;
            let recency = (-age_hours / 168.0_f64).exp();
            score += recency * 0.1;

            score += m.importance * 0.1;

            score += m.confidence * 0.05;

            (score, m)
        })
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let results: Vec<Value> = scored
        .into_iter()
        .take(limit)
        .map(|(score, m)| {
            let _ = iii.trigger_void("state::update", json!({
                "scope": format!("memory:{}", m.agent_id),
                "key": &m.id,
                "operations": [
                    { "type": "increment", "path": "accessCount", "value": 1 },
                    { "type": "set", "path": "lastAccessed", "value": now_ms() },
                ],
            }));

            json!({
                "role": m.role,
                "content": m.content,
                "score": score,
                "timestamp": m.timestamp,
                "id": m.id,
            })
        })
        .collect();

    Ok(json!(results))
}

async fn kg_add(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let entity = &input["entity"];
    let entity_id = entity["id"].as_str().unwrap_or("");

    iii.trigger("state::set", json!({
        "scope": format!("kg:{}", agent_id),
        "key": entity_id,
        "value": entity,
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    if let Some(relations) = entity["relations"].as_array() {
        for rel in relations {
            let target_id = rel["target"].as_str().unwrap_or("");
            let rel_type = rel["type"].as_str().unwrap_or("");

            if let Ok(target) = iii.trigger("state::get", json!({
                "scope": format!("kg:{}", agent_id),
                "key": target_id,
            })).await {
                let mut back_refs: Vec<Value> = target["relations"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();

                let already = back_refs.iter().any(|r| {
                    r["target"].as_str() == Some(entity_id) && r["type"].as_str() == Some(&format!("inverse:{}", rel_type))
                });

                if !already {
                    back_refs.push(json!({ "target": entity_id, "type": format!("inverse:{}", rel_type) }));
                    let _ = iii.trigger("state::update", json!({
                        "scope": format!("kg:{}", agent_id),
                        "key": target_id,
                        "operations": [{ "type": "set", "path": "relations", "value": back_refs }],
                    })).await;
                }
            }
        }
    }

    Ok(json!({ "stored": true, "id": entity_id }))
}

async fn kg_query(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let entity_id = input["entityId"].as_str().unwrap_or("");
    let depth = input["depth"].as_u64().unwrap_or(2);

    let mut visited = std::collections::HashSet::new();
    let mut results = Vec::new();
    let mut queue: Vec<(String, u64)> = vec![(entity_id.to_string(), 0)];

    while let Some((id, d)) = queue.pop() {
        if d >= depth || visited.contains(&id) {
            continue;
        }
        visited.insert(id.clone());

        if let Ok(entity) = iii.trigger("state::get", json!({
            "scope": format!("kg:{}", agent_id),
            "key": &id,
        })).await {
            if let Some(relations) = entity["relations"].as_array() {
                for rel in relations {
                    if let Some(target) = rel["target"].as_str() {
                        queue.push((target.to_string(), d + 1));
                    }
                }
            }
            results.push(entity);
        }
    }

    Ok(json!(results))
}

async fn evict_memories(iii: &III, input: Value) -> Result<Value, IIIError> {
    let max_age_ms = input["maxAge"].as_u64().unwrap_or(30 * 86_400_000);
    let min_importance = input["minImportance"].as_f64().unwrap_or(0.2);
    let cap = input["cap"].as_u64().unwrap_or(10_000) as usize;

    let scopes: Value = iii
        .trigger("state::list_groups", json!({}))
        .await
        .unwrap_or(json!([]));

    let memory_scopes: Vec<String> = scopes
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|s| s.as_str())
        .filter(|s| s.starts_with("memory:"))
        .map(String::from)
        .collect();

    let now = now_ms();
    let mut total_evicted = 0_u64;

    for scope in &memory_scopes {
        let entries: Value = iii
            .trigger("state::list", json!({ "scope": scope }))
            .await
            .unwrap_or(json!([]));

        let memories: Vec<MemoryEntry> = entries
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|e| {
                let val = e.get("value")?;
                serde_json::from_value(val.clone()).ok()
            })
            .collect();

        let mut scope_evicted = 0_u64;

        for m in &memories {
            let age = now.saturating_sub(m.timestamp);
            let is_stale = age > max_age_ms;
            let is_low_value = m.importance < min_importance;
            let is_low_confidence = m.confidence < 0.1;

            if (is_stale && is_low_value) || is_low_confidence {
                let _ = iii.trigger("state::delete", json!({ "scope": scope, "key": &m.id })).await;
                let _ = iii.trigger("state::delete", json!({ "scope": scope, "key": &m.hash })).await;
                scope_evicted += 1;
            }
        }

        let remaining = (memories.len() as u64).saturating_sub(scope_evicted);
        if remaining > cap as u64 {
            let mut sorted: Vec<&MemoryEntry> = memories.iter().collect();
            sorted.sort_by(|a, b| a.importance.partial_cmp(&b.importance).unwrap_or(std::cmp::Ordering::Equal));

            let overflow = (remaining - cap as u64) as usize;
            for m in sorted.into_iter().take(overflow) {
                let _ = iii.trigger("state::delete", json!({ "scope": scope, "key": &m.id })).await;
                scope_evicted += 1;
            }
        }

        total_evicted += scope_evicted;
    }

    Ok(json!({ "evicted": total_evicted }))
}

async fn consolidate(iii: &III, input: Value) -> Result<Value, IIIError> {
    let decay_rate = input["decayRate"].as_f64().unwrap_or(0.05);
    let start = std::time::Instant::now();

    let scopes: Value = iii
        .trigger("state::list_groups", json!({}))
        .await
        .unwrap_or(json!([]));

    let memory_scopes: Vec<String> = scopes
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|s| s.as_str())
        .filter(|s| s.starts_with("memory:"))
        .map(String::from)
        .collect();

    let now = now_ms();
    let seven_days_ms = 7 * 86_400_000_u64;
    let mut decayed = 0_u64;

    for scope in &memory_scopes {
        let entries: Value = iii
            .trigger("state::list", json!({ "scope": scope }))
            .await
            .unwrap_or(json!([]));

        for entry in entries.as_array().unwrap_or(&vec![]) {
            let val = match entry.get("value") {
                Some(v) => v,
                None => continue,
            };

            let last_accessed = val["lastAccessed"].as_u64().unwrap_or(0);
            let confidence = val["confidence"].as_f64().unwrap_or(1.0);
            let id = match val["id"].as_str() {
                Some(id) => id,
                None => continue,
            };

            if now.saturating_sub(last_accessed) > seven_days_ms && confidence > 0.1 {
                let new_confidence = (confidence * (1.0 - decay_rate)).max(0.1);
                let _ = iii.trigger("state::update", json!({
                    "scope": scope,
                    "key": id,
                    "operations": [
                        { "type": "set", "path": "confidence", "value": new_confidence },
                    ],
                })).await;
                decayed += 1;
            }
        }
    }

    Ok(json!({
        "memoriesDecayed": decayed,
        "memoriesMerged": 0,
        "durationMs": start.elapsed().as_millis() as u64,
    }))
}

async fn compact_session(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let session_id = input["sessionId"].as_str().unwrap_or("default");
    let threshold = input["threshold"].as_u64().unwrap_or(30) as usize;
    let keep_recent = input["keepRecent"].as_u64().unwrap_or(10) as usize;

    let session: Value = iii
        .trigger("state::get", json!({
            "scope": format!("sessions:{}", agent_id),
            "key": session_id,
        }))
        .await
        .unwrap_or(json!({}));

    let messages = session["messages"].as_array().cloned().unwrap_or_default();

    if messages.len() < threshold {
        return Ok(json!({ "compacted": false, "reason": "below_threshold" }));
    }

    let to_summarize = &messages[..messages.len().saturating_sub(keep_recent)];
    let to_keep = &messages[messages.len().saturating_sub(keep_recent)..];

    let mut full_messages = Vec::new();
    for msg_ref in to_summarize {
        let msg_id = msg_ref["id"].as_str().unwrap_or("");
        if let Ok(entry) = iii.trigger("state::get", json!({
            "scope": format!("memory:{}", agent_id),
            "key": msg_id,
        })).await {
            full_messages.push(format!(
                "{}: {}",
                entry["role"].as_str().unwrap_or("unknown"),
                entry["content"].as_str().unwrap_or("")
            ));
        }
    }

    let conversation_text = full_messages.join("\n\n");
    let chunks = chunk_text(&conversation_text, 80_000);
    let mut summaries = Vec::new();

    for chunk in &chunks {
        let summary = iii.trigger("llm::complete", json!({
            "model": { "provider": "anthropic", "model": "claude-haiku-4-5", "maxTokens": 1024 },
            "systemPrompt": "Summarize this conversation concisely. Preserve key facts, decisions, and context. Be brief.",
            "messages": [{ "role": "user", "content": chunk }],
        })).await;

        if let Ok(resp) = summary {
            summaries.push(resp["content"].as_str().unwrap_or("").to_string());
        }
    }

    let final_summary = summaries.join("\n\n");

    let summary_id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();

    iii.trigger("state::set", json!({
        "scope": format!("memory:{}", agent_id),
        "key": &summary_id,
        "value": {
            "id": &summary_id,
            "agentId": agent_id,
            "content": &final_summary,
            "role": "system",
            "timestamp": now,
            "sessionId": session_id,
            "importance": 0.9,
            "hash": "",
            "confidence": 1.0,
            "accessCount": 0_u64,
            "lastAccessed": now,
        },
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut new_messages = vec![json!({ "id": summary_id, "role": "system", "timestamp": now })];
    new_messages.extend(to_keep.iter().cloned());

    iii.trigger("state::update", json!({
        "scope": format!("sessions:{}", agent_id),
        "key": session_id,
        "operations": [
            { "type": "set", "path": "messages", "value": new_messages },
            { "type": "set", "path": "compactedAt", "value": now },
        ],
    })).await.map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(json!({
        "compacted": true,
        "summarized": to_summarize.len(),
        "kept": to_keep.len(),
        "summaryId": summary_id,
    }))
}

async fn repair_session(iii: &III, input: Value) -> Result<Value, IIIError> {
    let agent_id = input["agentId"].as_str().unwrap_or("default");
    let session_id = input["sessionId"].as_str().unwrap_or("default");

    let session: Value = iii
        .trigger("state::get", json!({
            "scope": format!("sessions:{}", agent_id),
            "key": session_id,
        }))
        .await
        .unwrap_or(json!({}));

    let messages = session["messages"].as_array().cloned().unwrap_or_default();
    let mut repaired = messages.clone();
    let mut stats = HashMap::new();

    let before = repaired.len();
    repaired.retain(|m| {
        m.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
    });
    stats.insert("emptyRemoved", (before - repaired.len()) as u64);

    let before = repaired.len();
    let mut seen = std::collections::HashSet::new();
    repaired.retain(|m| {
        let id = m["id"].as_str().unwrap_or("").to_string();
        seen.insert(id)
    });
    stats.insert("duplicatesRemoved", (before - repaired.len()) as u64);

    let mut merged = Vec::new();
    let mut merge_count = 0_u64;
    for msg in &repaired {
        let role = msg["role"].as_str().unwrap_or("");
        if let Some(last) = merged.last() {
            let last_role: &str = match last {
                Value::Object(obj) => obj.get("role").and_then(|v| v.as_str()).unwrap_or(""),
                _ => "",
            };
            if last_role == role && role != "system" {
                merge_count += 1;
                continue;
            }
        }
        merged.push(msg.clone());
    }
    repaired = merged;
    stats.insert("consecutiveMerged", merge_count);

    let mut orphaned = 0_u64;
    for msg in &repaired {
        let msg_id = msg["id"].as_str().unwrap_or("");
        let exists = iii.trigger("state::get", json!({
            "scope": format!("memory:{}", agent_id),
            "key": msg_id,
        })).await;
        if exists.is_err() {
            orphaned += 1;
        }
    }
    stats.insert("orphanedRefs", orphaned);

    let mut reordered = 0_u64;
    let mut prev_ts = 0_u64;
    for msg in &mut repaired {
        let ts = msg["timestamp"].as_u64().unwrap_or(0);
        if ts < prev_ts
            && let Some(obj) = msg.as_object_mut()
        {
            obj.insert("timestamp".into(), json!(prev_ts + 1));
            reordered += 1;
        }
        prev_ts = msg["timestamp"].as_u64().unwrap_or(prev_ts);
    }
    stats.insert("reordered", reordered);

    let mut truncated = 0_u64;
    for msg in &repaired {
        let msg_id = msg["id"].as_str().unwrap_or("");
        if let Ok(entry) = iii.trigger("state::get", json!({
            "scope": format!("memory:{}", agent_id),
            "key": msg_id,
        })).await {
            let content_len = entry["content"].as_str().map(|s| s.len()).unwrap_or(0);
            if content_len > 500_000 {
                truncated += 1;
            }
        }
    }
    stats.insert("oversizedDetected", truncated);

    let total_repairs: u64 = stats.values().sum();
    if total_repairs > 0 {
        iii.trigger("state::update", json!({
            "scope": format!("sessions:{}", agent_id),
            "key": session_id,
            "operations": [
                { "type": "set", "path": "messages", "value": repaired },
                { "type": "set", "path": "repairedAt", "value": now_ms() },
                { "type": "set", "path": "repairStats", "value": stats },
            ],
        })).await.map_err(|e| IIIError::Handler(e.to_string()))?;
    }

    Ok(json!({
        "repaired": total_repairs > 0,
        "totalFixes": total_repairs,
        "stats": stats,
    }))
}

fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom > 0.0 { dot / denom } else { 0.0 }
}

fn estimate_importance(content: &str, role: &str) -> f64 {
    let mut score: f64 = 0.5;
    if role == "assistant" { score += 0.1; }
    if content.len() > 500 { score += 0.1; }
    if content.contains("error") || content.contains("bug") || content.contains("fix") || content.contains("critical") {
        score += 0.15;
    }
    if content.contains("```") { score += 0.1; }
    score.min(1.0)
}

fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
    if text.len() <= max_chars {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let end = (start + max_chars).min(text.len());
        let mut split_at = if end < text.len() {
            text[start..end].rfind('\n').map(|p| start + p + 1).unwrap_or(end)
        } else {
            end
        };
        if split_at <= start {
            split_at = end;
        }
        chunks.push(text[start..split_at].to_string());
        start = split_at;
    }
    chunks
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_dedup_same_content_same_hash() {
        let content = "Hello, world!";
        let mut hasher1 = sha2::Digest::new();
        sha2::Digest::update(&mut hasher1, content.as_bytes());
        let h1 = format!("{:x}", <Sha256 as sha2::Digest>::finalize(hasher1));

        let mut hasher2 = sha2::Digest::new();
        sha2::Digest::update(&mut hasher2, content.as_bytes());
        let h2 = format!("{:x}", <Sha256 as sha2::Digest>::finalize(hasher2));

        assert_eq!(h1, h2);
    }

    #[test]
    fn test_sha256_dedup_different_content_different_hash() {
        let mut h1 = Sha256::new();
        h1.update(b"content A");
        let r1 = format!("{:x}", h1.finalize());

        let mut h2 = Sha256::new();
        h2.update(b"content B");
        let r2 = format!("{:x}", h2.finalize());

        assert_ne!(r1, r2);
    }

    #[test]
    fn test_sha256_hash_length() {
        let mut hasher = Sha256::new();
        hasher.update(b"test");
        let hash = format!("{:x}", hasher.finalize());
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn test_cosine_similarity_identical_vectors() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_orthogonal_vectors() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_opposite_vectors() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![-1.0, -2.0, -3.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - (-1.0)).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_different_lengths() {
        let a = vec![1.0, 2.0];
        let b = vec![1.0, 2.0, 3.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    #[test]
    fn test_cosine_similarity_empty_vectors() {
        let a: Vec<f64> = vec![];
        let b: Vec<f64> = vec![];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    #[test]
    fn test_cosine_similarity_zero_vector() {
        let a = vec![0.0, 0.0, 0.0];
        let b = vec![1.0, 2.0, 3.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    #[test]
    fn test_cosine_similarity_proportional_vectors() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![2.0, 4.0, 6.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_single_element() {
        let a = vec![5.0];
        let b = vec![3.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_user_short() {
        let score = estimate_importance("hello", "user");
        assert_eq!(score, 0.5);
    }

    #[test]
    fn test_estimate_importance_assistant_bonus() {
        let score = estimate_importance("hello", "assistant");
        assert!((score - 0.6).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_long_content_bonus() {
        let long = "a".repeat(501);
        let score = estimate_importance(&long, "user");
        assert!((score - 0.6).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_error_keyword() {
        let score = estimate_importance("there was an error in the code", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_bug_keyword() {
        let score = estimate_importance("found a bug in the system", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_fix_keyword() {
        let score = estimate_importance("please fix this issue", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_critical_keyword() {
        let score = estimate_importance("this is critical", "user");
        assert!((score - 0.65).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_code_block_bonus() {
        let score = estimate_importance("here is code ```rust\nfn main() {}```", "user");
        assert!((score - 0.6).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_all_bonuses() {
        let long = "a".repeat(501);
        let content = format!("{} error critical ``` code block ```", long);
        let score = estimate_importance(&content, "assistant");
        assert!(score >= 0.9);
        assert!(score <= 1.0);
    }

    #[test]
    fn test_estimate_importance_capped_at_one() {
        let long = "a".repeat(1000);
        let content = format!("{} error bug fix critical ``` block ```", long);
        let score = estimate_importance(&content, "assistant");
        assert!(score <= 1.0);
    }

    #[test]
    fn test_estimate_importance_system_role() {
        let score = estimate_importance("system message", "system");
        assert_eq!(score, 0.5);
    }

    #[test]
    fn test_chunk_text_short_text() {
        let text = "short text";
        let chunks = chunk_text(text, 100);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "short text");
    }

    #[test]
    fn test_chunk_text_exact_length() {
        let text = "abcde";
        let chunks = chunk_text(text, 5);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "abcde");
    }

    #[test]
    fn test_chunk_text_splits_on_newline() {
        let text = "line one\nline two\nline three\nline four";
        let chunks = chunk_text(text, 20);
        assert!(chunks.len() >= 2);
        for chunk in &chunks {
            assert!(chunk.len() <= 20 || !chunk.contains('\n'));
        }
    }

    #[test]
    fn test_chunk_text_no_newline_splits_at_max() {
        let text = "a".repeat(100);
        let chunks = chunk_text(&text, 30);
        assert!(chunks.len() >= 3);
    }

    #[test]
    fn test_chunk_text_empty() {
        let chunks = chunk_text("", 100);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "");
    }

    #[test]
    fn test_chunk_text_preserves_all_content() {
        let text = "Hello\nWorld\nFoo\nBar\nBaz\nQux";
        let chunks = chunk_text(text, 10);
        let rejoined: String = chunks.join("");
        assert_eq!(rejoined, text);
    }

    #[test]
    fn test_now_ms_returns_nonzero() {
        let ts = now_ms();
        assert!(ts > 0);
    }

    #[test]
    fn test_now_ms_increasing() {
        let t1 = now_ms();
        let t2 = now_ms();
        assert!(t2 >= t1);
    }

    #[test]
    fn test_memory_entry_serialization() {
        let entry = MemoryEntry {
            id: "m-1".to_string(),
            agent_id: "agent-1".to_string(),
            content: "test content".to_string(),
            role: "user".to_string(),
            embedding: Some(vec![0.1, 0.2, 0.3]),
            timestamp: 1000,
            session_id: Some("sess-1".to_string()),
            importance: 0.75,
            hash: "abc123".to_string(),
            confidence: 0.9,
            access_count: 5,
            last_accessed: 2000,
        };
        let val = serde_json::to_value(&entry).unwrap();
        assert_eq!(val["id"], "m-1");
        assert_eq!(val["agent_id"], "agent-1");
        assert_eq!(val["content"], "test content");
        assert_eq!(val["role"], "user");
        assert_eq!(val["importance"], 0.75);
        assert_eq!(val["confidence"], 0.9);
        assert_eq!(val["access_count"], 5);
    }

    #[test]
    fn test_memory_entry_deserialization() {
        let json_val = json!({
            "id": "m-2",
            "agent_id": "agent-2",
            "content": "remembered fact",
            "role": "assistant",
            "embedding": null,
            "timestamp": 5000,
            "session_id": null,
            "importance": 0.5,
            "hash": "def456",
            "confidence": 1.0,
            "access_count": 0,
            "last_accessed": 5000,
        });
        let entry: MemoryEntry = serde_json::from_value(json_val).unwrap();
        assert_eq!(entry.id, "m-2");
        assert_eq!(entry.agent_id, "agent-2");
        assert_eq!(entry.embedding, None);
        assert_eq!(entry.session_id, None);
    }

    #[test]
    fn test_memory_entry_roundtrip() {
        let entry = MemoryEntry {
            id: "rt-1".to_string(),
            agent_id: "agent-rt".to_string(),
            content: "roundtrip test".to_string(),
            role: "system".to_string(),
            embedding: Some(vec![1.0, 2.0]),
            timestamp: 42,
            session_id: Some("s-1".to_string()),
            importance: 0.8,
            hash: "h1".to_string(),
            confidence: 0.95,
            access_count: 10,
            last_accessed: 100,
        };
        let serialized = serde_json::to_string(&entry).unwrap();
        let deserialized: MemoryEntry = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.id, entry.id);
        assert_eq!(deserialized.content, entry.content);
        assert_eq!(deserialized.embedding, entry.embedding);
    }

    #[test]
    fn test_cosine_similarity_known_value() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        let expected = 1.0 / (2.0_f64).sqrt();
        assert!((sim - expected).abs() < 1e-10);
    }

    #[test]
    fn test_estimate_importance_exact_500_chars_no_bonus() {
        let content = "a".repeat(500);
        let score = estimate_importance(&content, "user");
        assert_eq!(score, 0.5);
    }

    #[test]
    fn test_chunk_text_single_char_max() {
        let text = "abc";
        let chunks = chunk_text(text, 1);
        assert_eq!(chunks.len(), 3);
    }

    #[test]
    fn test_chunk_text_large_max() {
        let text = "Hello world";
        let chunks = chunk_text(text, 1000000);
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn test_estimate_importance_empty_content() {
        let score = estimate_importance("", "user");
        assert_eq!(score, 0.5);
    }

    #[test]
    fn test_cosine_similarity_negative_values() {
        let a = vec![-1.0, -2.0, -3.0];
        let b = vec![-1.0, -2.0, -3.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_mixed_values() {
        let a = vec![1.0, -1.0];
        let b = vec![-1.0, 1.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - (-1.0)).abs() < 1e-10);
    }
}
