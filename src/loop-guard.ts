import { init } from "iii-sdk";
import { createHash } from "crypto";

const { registerFunction } = init("ws://localhost:49134", {
  workerName: "loop-guard",
});

interface CallRecord {
  hash: string;
  resultHash: string;
  toolName: string;
  timestamp: number;
}

const HISTORY_SIZE = 30;
const WARN_THRESHOLD = 3;
const BLOCK_THRESHOLD = 5;
const PER_AGENT_CIRCUIT_BREAKER = 100;
const POLL_TOOLS = new Set(["tool::shell_exec", "tool::web_fetch"]);
const POLL_MULTIPLIER = 3;
const BACKOFF_SCHEDULE = [5000, 10000, 30000, 60000];

const agentHistory = new Map<string, CallRecord[]>();
const warningBuckets = new Map<string, number>();
const agentCallCounts = new Map<string, number>();

const AGENT_TTL_MS = 3_600_000;

function clearWarningBuckets(agentId: string): void {
  const prefix = `${agentId}:`;
  for (const key of warningBuckets.keys()) {
    if (key.startsWith(prefix)) warningBuckets.delete(key);
  }
}

function evictStaleAgents() {
  const now = Date.now();
  for (const [agentId, history] of agentHistory) {
    const lastEntry = history[history.length - 1];
    if (lastEntry && now - lastEntry.timestamp > AGENT_TTL_MS) {
      agentHistory.delete(agentId);
      agentCallCounts.delete(agentId);
      clearWarningBuckets(agentId);
    }
  }
}

setInterval(evictStaleAgents, 600_000);

type GuardDecision = "allow" | "warn" | "block" | "circuit_break";

registerFunction(
  {
    id: "guard::check",
    description: "Loop guard: check for repeated tool calls",
  },
  async ({
    agentId,
    toolName,
    params,
    resultHash,
  }: {
    agentId: string;
    toolName: string;
    params: Record<string, unknown>;
    resultHash?: string;
  }) => {
    const agentCalls = (agentCallCounts.get(agentId) || 0) + 1;
    agentCallCounts.set(agentId, agentCalls);

    if (agentCalls > PER_AGENT_CIRCUIT_BREAKER) {
      return {
        decision: "circuit_break",
        reason: `Per-agent circuit breaker: ${agentCalls} calls for ${agentId}`,
      };
    }

    const callHash = hashCall(toolName, params);
    const history = agentHistory.get(agentId) || [];

    const record: CallRecord = {
      hash: callHash,
      resultHash: resultHash || "",
      toolName,
      timestamp: Date.now(),
    };

    history.push(record);
    if (history.length > HISTORY_SIZE) history.shift();
    agentHistory.set(agentId, history);

    const isPollTool = POLL_TOOLS.has(toolName);
    const warnAt = isPollTool
      ? WARN_THRESHOLD * POLL_MULTIPLIER
      : WARN_THRESHOLD;
    const blockAt = isPollTool
      ? BLOCK_THRESHOLD * POLL_MULTIPLIER
      : BLOCK_THRESHOLD;

    const identicalCount = history.filter((h) => h.hash === callHash).length;

    const sameResultCount = resultHash
      ? history.filter(
          (h) => h.hash === callHash && h.resultHash === resultHash,
        ).length
      : 0;

    const pingPong = detectPingPong(history);

    if (sameResultCount >= blockAt || pingPong.detected) {
      return {
        decision: "block",
        reason: pingPong.detected
          ? `Ping-pong pattern: ${pingPong.pattern}`
          : `Identical call+result repeated ${sameResultCount} times`,
        suggestion: "Break the loop — try a different approach",
      };
    }

    if (identicalCount >= blockAt) {
      return {
        decision: "block",
        reason: `Tool ${toolName} called ${identicalCount} times with same params`,
        suggestion:
          "The tool keeps returning the same result. Change your approach.",
      };
    }

    if (identicalCount >= warnAt) {
      const bucketKey = `${agentId}:${callHash}`;
      const warnings = (warningBuckets.get(bucketKey) || 0) + 1;
      warningBuckets.set(bucketKey, warnings);

      if (warnings >= 3) {
        return {
          decision: "block",
          reason: `Repeated warnings escalated to block after ${warnings} warnings`,
        };
      }

      const backoffIdx = Math.min(warnings - 1, BACKOFF_SCHEDULE.length - 1);
      return {
        decision: "warn",
        reason: `Tool ${toolName} called ${identicalCount} times with same params`,
        backoffMs: BACKOFF_SCHEDULE[backoffIdx],
      };
    }

    return { decision: "allow" };
  },
);

registerFunction(
  { id: "guard::reset", description: "Reset loop guard state for an agent" },
  async ({ agentId }: { agentId: string }) => {
    agentHistory.delete(agentId);
    clearWarningBuckets(agentId);
    agentCallCounts.delete(agentId);
    return { reset: true };
  },
);

registerFunction(
  { id: "guard::stats", description: "Get loop guard statistics" },
  async ({ agentId }: { agentId: string }) => {
    const history = agentHistory.get(agentId) || [];
    const callCounts = new Map<string, number>();

    for (const h of history) {
      callCounts.set(h.toolName, (callCounts.get(h.toolName) || 0) + 1);
    }

    return {
      historySize: history.length,
      agentCalls: agentCallCounts.get(agentId) || 0,
      toolCounts: Object.fromEntries(callCounts),
      warningBuckets: Object.fromEntries(
        [...warningBuckets.entries()].filter(([k]) =>
          k.startsWith(`${agentId}:`),
        ),
      ),
    };
  },
);

function hashCall(toolName: string, params: Record<string, unknown>): string {
  const data = JSON.stringify({ toolName, params });
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function detectPingPong(history: CallRecord[]): {
  detected: boolean;
  pattern?: string;
} {
  if (history.length < 6) return { detected: false };

  const recent = history.slice(-10).map((h) => h.hash);

  for (let patternLen = 2; patternLen <= 4; patternLen++) {
    if (recent.length < patternLen * 3) continue;

    const pattern = recent.slice(-patternLen);
    let repeats = 0;

    for (let i = recent.length - patternLen * 2; i >= 0; i -= patternLen) {
      const chunk = recent.slice(i, i + patternLen);
      if (chunk.every((h, idx) => h === pattern[idx])) {
        repeats++;
      } else {
        break;
      }
    }

    if (repeats >= 2) {
      const toolNames = history
        .slice(-patternLen)
        .map((h) => h.toolName.split("::").pop());
      return {
        detected: true,
        pattern: toolNames.join(" → ") + " (×" + (repeats + 1) + ")",
      };
    }
  }

  return { detected: false };
}
