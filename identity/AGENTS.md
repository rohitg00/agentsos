# Multi-Agent Coordination Rules

## Agent Registry

All agents are registered under `agents/*/agent.toml`. Each agent has a unique name, model configuration, capability set, and system prompt.

## Communication Protocol

### Direct Messages
- Agents communicate via the orchestrator's message bus
- Messages are JSON objects with `from`, `to`, `type`, `payload`, and `timestamp` fields
- Supported message types: `request`, `response`, `broadcast`, `error`, `handoff`

### Handoff Protocol
1. Sending agent creates a handoff message with full context summary
2. Orchestrator validates the receiving agent exists and has required capabilities
3. Receiving agent acknowledges with its understanding of the task
4. Sending agent confirms or clarifies before transfer completes

## Delegation Rules

### When to Delegate
- The current task requires tools the active agent does not have
- The task domain falls outside the active agent's expertise tags
- The user explicitly requests a different agent
- Task complexity exceeds the active agent's configured max_iterations

### Delegation Hierarchy
1. **Orchestrator** coordinates all multi-agent workflows
2. **Specialist agents** handle domain-specific tasks
3. **Assistant** serves as the default fallback for unmatched requests

### Conflict Resolution
- When agents disagree on an approach, the orchestrator mediates
- Each agent provides its recommendation with a confidence score (0.0-1.0)
- The orchestrator selects the highest-confidence response unless overridden by the user
- Ties are broken by agent priority: user-assigned priority > domain match > alphabetical

## Shared State

### Memory Scopes
- `self.*` - Private to the individual agent, persists across sessions
- `shared.*` - Readable and writable by all agents in the workspace
- `session.*` - Scoped to the current session, cleared on end
- `user.*` - User profile data, read-only for agents

### Locking
- Agents must acquire a write lock before modifying shared state
- Locks have a 30-second TTL to prevent deadlocks
- Read operations do not require locks

## Safety Constraints

- No agent may execute a tool marked as `destructive` without user approval
- Agents must not bypass the approval system by delegating to other agents
- All inter-agent messages are logged to the audit trail
- An agent that fails 3 consecutive tasks is automatically paused for review
- Resource limits (tokens per hour) are enforced per-agent, not shared

## Session Management

- Each user conversation creates a session with a unique ID
- Sessions track the active agent, message history, and tool invocations
- Sessions can be transferred between agents via the handoff protocol
- Idle sessions expire after 30 minutes of inactivity
