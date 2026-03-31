---
name: swarm
description: Multi-agent swarm coordination — create swarms, broadcast tasks, reach consensus
toolScope: [Bash, Read]
effort: extended
---

Swarm coordination:

1. Create: `curl -X POST http://localhost:3111/api/swarm/create -H 'Content-Type: application/json' -d '{"goal": "<goal>", "agents": ["agent1", "agent2"], "strategy": "consensus"}'`
2. Broadcast: `curl -X POST http://localhost:3111/api/swarm/broadcast -H 'Content-Type: application/json' -d '{"swarmId": "<id>", "agentId": "claude-code", "type": "proposal", "content": "<proposal>"}'`
3. Collect: `curl -X POST http://localhost:3111/api/swarm/collect -H 'Content-Type: application/json' -d '{"swarmId": "<id>"}'`
4. Consensus: `curl -X POST http://localhost:3111/api/swarm/consensus -H 'Content-Type: application/json' -d '{"swarmId": "<id>"}'`
