---
name: lifecycle
description: Session lifecycle management — transitions, state tracking, reactions
toolScope: [Bash, Read]
effort: normal
---

Manage agent session lifecycle:

- Transition: `curl -X POST http://localhost:3111/api/lifecycle/transition -H 'Content-Type: application/json' -d '{"agentId": "claude-code", "newState": "working"}'`
- Get state: `curl http://localhost:3111/api/lifecycle/state/claude-code`
- Add reaction: `curl -X POST http://localhost:3111/api/lifecycle/reactions -H 'Content-Type: application/json' -d '{"agentId": "claude-code", "from": "blocked", "to": "working", "action": "notify"}'`

States: spawning -> working -> blocked -> pr_open -> review -> merged -> done | failed -> recovering | terminated.
