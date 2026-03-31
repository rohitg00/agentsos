---
name: agentos-orchestrate
description: Quick orchestrate a feature — decompose, plan, and execute
---

Orchestrate a feature:
```bash
curl -s -X POST http://localhost:3111/api/orchestrator/plan -d '{"description": "$ARGUMENTS"}' | jq .
```
