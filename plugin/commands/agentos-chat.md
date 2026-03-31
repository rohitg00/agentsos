---
name: agentos-chat
description: Send a message to an AgentOS agent
---

Send message to agent:
```bash
curl -s -X POST http://localhost:3111/api/agents/default/message -d '{"agentId": "default", "message": "$ARGUMENTS"}' | jq .content
```
