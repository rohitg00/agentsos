---
name: evolve
description: Create, test, and improve functions at runtime — agents write their own code
toolScope: [Bash, Read]
effort: extended
---

Self-evolving functions:

1. Generate: `curl -X POST http://localhost:3111/api/evolve/generate -d '{"goal": "<what>", "name": "<name>", "agentId": "claude-code"}'`
2. Register: `curl -X POST http://localhost:3111/api/evolve/register -d '{"functionId": "<id>"}'`
3. Evaluate: `curl -X POST http://localhost:3111/api/eval/run -d '{"functionId": "<id>", "input": {...}, "expected": {...}}'`
4. Improve: `curl -X POST http://localhost:3111/api/feedback/review -d '{"functionId": "<id>"}'`

Functions evolve through: draft -> staging -> production. The feedback loop auto-improves underperforming functions.
