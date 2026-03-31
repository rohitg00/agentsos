---
name: security
description: Security scanning — injection detection, capability checks, audit trails
toolScope: [Bash, Read]
effort: normal
---

Security operations:

- Scan injection: `curl -X POST http://localhost:3111/api/security/scan -d '{"input": "<text>", "checks": ["injection", "traversal", "command"]}'`
- Check capability: `curl -X POST http://localhost:3111/api/security/capability -d '{"agentId": "claude-code", "action": "write", "resource": "/path"}'`
- Audit: `curl http://localhost:3111/api/security/audit?agentId=claude-code&limit=50`
