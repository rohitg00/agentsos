---
name: vault
description: Secret management — encrypted storage for API keys, tokens, credentials
toolScope: [Bash, Read]
effort: normal
---

Vault operations:

- Init: `curl -X POST http://localhost:3111/api/vault/init -H 'Content-Type: application/json' -d '{"password": "<master-password>"}'`
- Set: `curl -X POST http://localhost:3111/api/vault/set -H 'Content-Type: application/json' -d '{"key": "<name>", "value": "<secret>"}'`
- Get: `curl -X POST http://localhost:3111/api/vault/get -H 'Content-Type: application/json' -d '{"key": "<name>"}'`
- List: `curl http://localhost:3111/api/vault/list`
- Rotate: `curl -X POST http://localhost:3111/api/vault/rotate -H 'Content-Type: application/json' -d '{"currentPassword": "<current>", "newPassword": "<new>"}'`
