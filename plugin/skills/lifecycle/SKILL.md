---
name: lifecycle
description: Session lifecycle management — transitions, state tracking, reactions
toolScope: [Bash, Read]
effort: normal
---

Manage agent session lifecycle:

- Transition: `curl -X POST http://localhost:3111/api/lifecycle/transition -d '{"agentId": "claude-code", "to": "executing"}'`
- Get state: `curl http://localhost:3111/api/lifecycle/state/claude-code`
- Add reaction: `curl -X POST http://localhost:3111/api/lifecycle/reaction -d '{"agentId": "claude-code", "on": "idle", "action": "reflect"}'`

States: initializing -> planning -> executing -> reflecting -> idle -> terminated.
