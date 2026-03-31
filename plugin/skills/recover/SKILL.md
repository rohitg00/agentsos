---
name: recover
description: Scan agent health and auto-recover stale or dead sessions
toolScope: [Bash, Read]
effort: normal
---

Check agent health and recover:

1. Scan: `curl -X POST http://localhost:3111/api/recovery/scan`
2. Report: `curl -X POST http://localhost:3111/api/recovery/report`
3. Recover specific: `curl -X POST http://localhost:3111/api/recovery/recover -d '{"agentId": "<id>"}'`

Classifications: healthy, degraded (stale), dead (circuit broken), unrecoverable.
