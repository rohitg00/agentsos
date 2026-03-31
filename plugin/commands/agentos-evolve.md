---
name: agentos-evolve
description: Quick evolve a function — generate, register, and evaluate
---

Evolve a function:
```bash
curl -s -X POST http://localhost:3111/api/evolve/generate -d '{"goal": "$ARGUMENTS", "name": "evolved-fn", "agentId": "claude-code"}' | jq .
```
