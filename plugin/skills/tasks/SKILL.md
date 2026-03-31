---
name: tasks
description: Task decomposition — break features into subtasks, assign workers, track progress
toolScope: [Bash, Read, Write]
effort: normal
---

Task management:

- Decompose: `curl -X POST http://localhost:3111/api/tasks/decompose -d '{"description": "<feature>", "maxDepth": 3}'`
- List: `curl http://localhost:3111/api/tasks/list?agentId=claude-code`
- Update: `curl -X POST http://localhost:3111/api/tasks/update -d '{"taskId": "<id>", "status": "completed"}'`
- Spawn workers: `curl -X POST http://localhost:3111/api/tasks/spawn -d '{"taskId": "<id>"}'`
