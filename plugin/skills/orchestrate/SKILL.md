---
name: orchestrate
description: Plan and execute multi-agent work — decompose features, spawn workers, monitor progress
toolScope: [Bash, Read, Write, Agent]
effort: extended
---

Use AgentOS orchestrator to break down complex tasks:

1. Plan: `curl -X POST http://localhost:3111/api/orchestrator/plan -d '{"description": "<task>"}'`
2. Execute: `curl -X POST http://localhost:3111/api/orchestrator/execute -d '{"planId": "<id>"}'`
3. Status: `curl -X POST http://localhost:3111/api/orchestrator/status -d '{"planId": "<id>"}'`

The orchestrator decomposes tasks into subtasks with hierarchical IDs, spawns workers for each leaf task, and monitors progress with lifecycle reactions.
