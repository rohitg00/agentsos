---
name: agentos-status
description: Show AgentOS system status — agents, workers, health
---

Check AgentOS status:
```bash
curl -s http://localhost:3111/api/dashboard/stats | jq .
```
