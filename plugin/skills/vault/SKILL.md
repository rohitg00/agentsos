---
name: vault
description: Secret management — encrypted storage for API keys, tokens, credentials
toolScope: [Bash, Read]
effort: normal
---

Vault operations:

- Init: `curl -X POST http://localhost:3111/api/vault/init -d '{"agentId": "claude-code"}'`
- Set: `curl -X POST http://localhost:3111/api/vault/set -d '{"agentId": "claude-code", "key": "<name>", "value": "<secret>"}'`
- Get: `curl -X POST http://localhost:3111/api/vault/get -d '{"agentId": "claude-code", "key": "<name>"}'`
- List: `curl http://localhost:3111/api/vault/list?agentId=claude-code`
- Rotate: `curl -X POST http://localhost:3111/api/vault/rotate -d '{"agentId": "claude-code", "key": "<name>"}'`
