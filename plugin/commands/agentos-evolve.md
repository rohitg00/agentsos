---
name: agentos-evolve
description: Quick evolve a function — generate, register, and evaluate
---

Evolve a function:
```bash
curl -s -X POST http://localhost:3111/api/evolve/generate -H 'Content-Type: application/json' -d '{"goal": "$ARGUMENTS", "name": "evolved-fn", "agentId": "claude-code"}' | jq .
```
