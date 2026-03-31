---
name: memory
description: Persistent agent memory — store, recall, search across sessions
toolScope: [Bash, Read]
effort: normal
---

Memory operations:

- Store: `curl -X POST http://localhost:3111/api/memory/store -H 'Content-Type: application/json' -d '{"agentId": "claude-code", "content": "<fact>", "role": "system"}'`
- Recall: `curl -X POST http://localhost:3111/api/memory/recall -H 'Content-Type: application/json' -d '{"agentId": "claude-code", "query": "<query>", "limit": 10}'`
- Search sessions: `curl -X POST http://localhost:3111/api/memory/search -H 'Content-Type: application/json' -d '{"agentId": "claude-code", "query": "<query>"}'`
- Profile: `curl http://localhost:3111/api/memory/profile/claude-code`
