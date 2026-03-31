---
name: status
description: System status and health checks — dashboard stats, agent health, worker status
toolScope: [Bash, Read]
effort: normal
---

Status checks:

- Dashboard: `curl http://localhost:3111/api/dashboard/stats`
- Health: `curl http://localhost:3111/api/health`
- Agent list: `curl http://localhost:3111/api/agents/list`
- Worker status: `curl http://localhost:3111/api/workers/status`
