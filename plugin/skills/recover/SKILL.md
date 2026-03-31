---
name: recover
description: Scan agent health and auto-recover stale or dead sessions
toolScope: [Bash, Read]
effort: normal
---

Check agent health and recover:

1. Scan: `curl -X POST http://localhost:3111/api/recovery/scan -H 'Content-Type: application/json'`
2. Report: `curl -X POST http://localhost:3111/api/recovery/report -H 'Content-Type: application/json'`
3. Recover specific: `curl -X POST http://localhost:3111/api/recovery/recover -H 'Content-Type: application/json' -d '{"agentId": "<id>"}'`

Classifications: healthy, degraded, dead, unrecoverable.
