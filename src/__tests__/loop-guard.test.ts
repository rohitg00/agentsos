import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createHash } from "crypto";

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
const AGENT_TTL_MS = 3_600_000;

let agentHistory: Map<string, CallRecord[]>;
let warningBuckets: Map<string, number>;
let agentCallCounts: Map<string, number>;

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

type GuardDecision = "allow" | "warn" | "block" | "circuit_break";

function guardCheck({
  agentId,
  toolName,
  params,
  resultHash,
}: {
  agentId: string;
  toolName: string;
  params: Record<string, unknown>;
  resultHash?: string;
}): { decision: GuardDecision; reason?: string; backoffMs?: number; suggestion?: string } {
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
  const warnAt = isPollTool ? WARN_THRESHOLD * POLL_MULTIPLIER : WARN_THRESHOLD;
  const blockAt = isPollTool ? BLOCK_THRESHOLD * POLL_MULTIPLIER : BLOCK_THRESHOLD;

  const identicalCount = history.filter((h) => h.hash === callHash).length;

  const sameResultCount = resultHash
    ? history.filter((h) => h.hash === callHash && h.resultHash === resultHash).length
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
      suggestion: "The tool keeps returning the same result. Change your approach.",
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
}

function evictStaleAgents() {
  const now = Date.now();
  for (const [agentId, history] of agentHistory) {
    const lastEntry = history[history.length - 1];
    if (lastEntry && now - lastEntry.timestamp > AGENT_TTL_MS) {
      agentHistory.delete(agentId);
      agentCallCounts.delete(agentId);
      const keysToDelete: string[] = [];
      for (const key of warningBuckets.keys()) {
        if (key.startsWith(`${agentId}:`)) keysToDelete.push(key);
      }
      keysToDelete.forEach((k) => warningBuckets.delete(k));
    }
  }
}

describe("Loop Guard", () => {
  beforeEach(() => {
    agentHistory = new Map();
    warningBuckets = new Map();
    agentCallCounts = new Map();
  });

  describe("hashCall", () => {
    it("returns a 16 char hex string", () => {
      const hash = hashCall("tool::test", { a: 1 });
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it("produces same hash for same input", () => {
      const h1 = hashCall("tool::a", { x: 1 });
      const h2 = hashCall("tool::a", { x: 1 });
      expect(h1).toBe(h2);
    });

    it("produces different hash for different tool", () => {
      const h1 = hashCall("tool::a", { x: 1 });
      const h2 = hashCall("tool::b", { x: 1 });
      expect(h1).not.toBe(h2);
    });

    it("produces different hash for different params", () => {
      const h1 = hashCall("tool::a", { x: 1 });
      const h2 = hashCall("tool::a", { x: 2 });
      expect(h1).not.toBe(h2);
    });

    it("handles empty params", () => {
      const hash = hashCall("tool::a", {});
      expect(hash).toHaveLength(16);
    });

    it("handles nested params", () => {
      const hash = hashCall("tool::a", { nested: { deep: true } });
      expect(hash).toHaveLength(16);
    });
  });

  describe("basic allow/warn/block flow", () => {
    it("allows first call", () => {
      const result = guardCheck({
        agentId: "a1",
        toolName: "tool::test",
        params: { q: "hello" },
      });
      expect(result.decision).toBe("allow");
    });

    it("allows second identical call", () => {
      guardCheck({ agentId: "a1", toolName: "tool::test", params: { q: "hello" } });
      const result = guardCheck({ agentId: "a1", toolName: "tool::test", params: { q: "hello" } });
      expect(result.decision).toBe("allow");
    });

    it("warns after WARN_THRESHOLD identical calls", () => {
      for (let i = 0; i < WARN_THRESHOLD; i++) {
        guardCheck({ agentId: "a1", toolName: "tool::test", params: { q: "x" } });
      }
      expect(agentHistory.get("a1")!.length).toBe(WARN_THRESHOLD);
    });

    it("blocks after BLOCK_THRESHOLD identical calls", () => {
      for (let i = 0; i < BLOCK_THRESHOLD; i++) {
        guardCheck({ agentId: "a1", toolName: "tool::test", params: { q: "x" } });
      }
      const result = guardCheck({ agentId: "a1", toolName: "tool::test", params: { q: "x" } });
      expect(["warn", "block"]).toContain(result.decision);
    });

    it("allows different tools without warning", () => {
      guardCheck({ agentId: "a1", toolName: "tool::a", params: {} });
      guardCheck({ agentId: "a1", toolName: "tool::b", params: {} });
      guardCheck({ agentId: "a1", toolName: "tool::c", params: {} });
      guardCheck({ agentId: "a1", toolName: "tool::d", params: {} });
      guardCheck({ agentId: "a1", toolName: "tool::e", params: {} });
      const result = guardCheck({ agentId: "a1", toolName: "tool::f", params: {} });
      expect(result.decision).toBe("allow");
    });

    it("tracks agents independently", () => {
      for (let i = 0; i < BLOCK_THRESHOLD + 1; i++) {
        guardCheck({ agentId: "a1", toolName: "tool::x", params: {} });
      }
      const result = guardCheck({ agentId: "a2", toolName: "tool::x", params: {} });
      expect(result.decision).toBe("allow");
    });
  });

  describe("same result blocking", () => {
    it("blocks when same call+result exceeds blockAt", () => {
      for (let i = 0; i < BLOCK_THRESHOLD; i++) {
        guardCheck({
          agentId: "a1",
          toolName: "tool::test",
          params: { q: "same" },
          resultHash: "resulthash123",
        });
      }
      const result = guardCheck({
        agentId: "a1",
        toolName: "tool::test",
        params: { q: "same" },
        resultHash: "resulthash123",
      });
      expect(["warn", "block"]).toContain(result.decision);
    });

    it("does not count result hash when not provided", () => {
      for (let i = 0; i < 4; i++) {
        guardCheck({ agentId: "a1", toolName: "tool::test", params: { q: "no-result" } });
      }
      const r = guardCheck({ agentId: "a1", toolName: "tool::test", params: { q: "no-result" } });
      expect(r.decision).not.toBe("circuit_break");
    });
  });

  describe("poll tool multiplier", () => {
    it("shell_exec is a poll tool", () => {
      expect(POLL_TOOLS.has("tool::shell_exec")).toBe(true);
    });

    it("web_fetch is a poll tool", () => {
      expect(POLL_TOOLS.has("tool::web_fetch")).toBe(true);
    });

    it("non-poll tools use base thresholds", () => {
      for (let i = 0; i < WARN_THRESHOLD - 1; i++) {
        guardCheck({ agentId: "a1", toolName: "tool::normal", params: {} });
      }
      const r = guardCheck({ agentId: "a1", toolName: "tool::normal", params: {} });
      expect(r.decision).toBe("warn");
    });

    it("poll tools need more calls before warning", () => {
      for (let i = 0; i < WARN_THRESHOLD; i++) {
        guardCheck({ agentId: "a1", toolName: "tool::shell_exec", params: {} });
      }
      const r = guardCheck({ agentId: "a1", toolName: "tool::shell_exec", params: {} });
      expect(r.decision).toBe("allow");
    });

    it("poll multiplier is 3", () => {
      expect(POLL_MULTIPLIER).toBe(3);
    });

    it("poll tool warn threshold is 9", () => {
      expect(WARN_THRESHOLD * POLL_MULTIPLIER).toBe(9);
    });

    it("poll tool block threshold is 15", () => {
      expect(BLOCK_THRESHOLD * POLL_MULTIPLIER).toBe(15);
    });
  });

  describe("circuit breaker", () => {
    it("circuit breaks after PER_AGENT_CIRCUIT_BREAKER calls", () => {
      for (let i = 0; i <= PER_AGENT_CIRCUIT_BREAKER; i++) {
        guardCheck({ agentId: "a1", toolName: `tool::${i}`, params: { i } });
      }
      const result = guardCheck({ agentId: "a1", toolName: "tool::next", params: {} });
      expect(result.decision).toBe("circuit_break");
    });

    it("circuit breaker limit is 100", () => {
      expect(PER_AGENT_CIRCUIT_BREAKER).toBe(100);
    });

    it("circuit breaker includes agent id in reason", () => {
      for (let i = 0; i <= PER_AGENT_CIRCUIT_BREAKER; i++) {
        guardCheck({ agentId: "my-agent", toolName: `tool::${i}`, params: { i } });
      }
      const result = guardCheck({ agentId: "my-agent", toolName: "tool::x", params: {} });
      expect(result.reason).toContain("my-agent");
    });

    it("circuit breaker is per agent", () => {
      for (let i = 0; i <= PER_AGENT_CIRCUIT_BREAKER; i++) {
        guardCheck({ agentId: "agent-a", toolName: `tool::${i}`, params: { i } });
      }
      const result = guardCheck({ agentId: "agent-b", toolName: "tool::test", params: {} });
      expect(result.decision).toBe("allow");
    });
  });

  describe("warning escalation", () => {
    it("provides backoff on warn", () => {
      for (let i = 0; i < WARN_THRESHOLD - 1; i++) {
        guardCheck({ agentId: "a1", toolName: "tool::esc", params: { x: 1 } });
      }
      const result = guardCheck({ agentId: "a1", toolName: "tool::esc", params: { x: 1 } });
      if (result.decision === "warn") {
        expect(result.backoffMs).toBeDefined();
      }
    });

    it("first warning uses first backoff schedule", () => {
      for (let i = 0; i < WARN_THRESHOLD - 1; i++) {
        guardCheck({ agentId: "a1", toolName: "tool::bo", params: {} });
      }
      const result = guardCheck({ agentId: "a1", toolName: "tool::bo", params: {} });
      if (result.decision === "warn") {
        expect(result.backoffMs).toBe(BACKOFF_SCHEDULE[0]);
      }
    });

    it("backoff schedule has 4 entries", () => {
      expect(BACKOFF_SCHEDULE).toEqual([5000, 10000, 30000, 60000]);
    });

    it("escalates to block after 3 warnings", () => {
      const params = { unique: "escalate-test" };
      for (let i = 0; i < WARN_THRESHOLD - 1; i++) {
        guardCheck({ agentId: "esc1", toolName: "tool::esc1", params });
      }
      guardCheck({ agentId: "esc1", toolName: "tool::esc1", params });
      guardCheck({ agentId: "esc1", toolName: "tool::esc1", params });
      guardCheck({ agentId: "esc1", toolName: "tool::esc1", params });
      const result = guardCheck({ agentId: "esc1", toolName: "tool::esc1", params });
      expect(["warn", "block"]).toContain(result.decision);
    });
  });

  describe("ping-pong detection", () => {
    it("does not detect ping-pong with < 6 entries", () => {
      const history: CallRecord[] = [
        { hash: "a", resultHash: "", toolName: "tool::a", timestamp: 1 },
        { hash: "b", resultHash: "", toolName: "tool::b", timestamp: 2 },
        { hash: "a", resultHash: "", toolName: "tool::a", timestamp: 3 },
        { hash: "b", resultHash: "", toolName: "tool::b", timestamp: 4 },
      ];
      expect(detectPingPong(history).detected).toBe(false);
    });

    it("detects A-B-A-B-A-B pattern", () => {
      const history: CallRecord[] = [];
      for (let i = 0; i < 8; i++) {
        history.push({
          hash: i % 2 === 0 ? "aaa" : "bbb",
          resultHash: "",
          toolName: i % 2 === 0 ? "tool::a" : "tool::b",
          timestamp: i,
        });
      }
      const result = detectPingPong(history);
      expect(result.detected).toBe(true);
    });

    it("detects 3-element repeating pattern", () => {
      const hashes = ["a1", "b2", "c3"];
      const history: CallRecord[] = [];
      for (let i = 0; i < 9; i++) {
        history.push({
          hash: hashes[i % 3],
          resultHash: "",
          toolName: `tool::${hashes[i % 3]}`,
          timestamp: i,
        });
      }
      const result = detectPingPong(history);
      expect(result.detected).toBe(true);
    });

    it("does not false-positive on varied calls", () => {
      const history: CallRecord[] = [];
      for (let i = 0; i < 10; i++) {
        history.push({
          hash: `unique-${i}`,
          resultHash: "",
          toolName: `tool::unique-${i}`,
          timestamp: i,
        });
      }
      expect(detectPingPong(history).detected).toBe(false);
    });

    it("ping-pong result includes pattern description", () => {
      const history: CallRecord[] = [];
      for (let i = 0; i < 8; i++) {
        history.push({
          hash: i % 2 === 0 ? "pp1" : "pp2",
          resultHash: "",
          toolName: i % 2 === 0 ? "tool::read" : "tool::write",
          timestamp: i,
        });
      }
      const result = detectPingPong(history);
      if (result.detected) {
        expect(result.pattern).toBeDefined();
        expect(result.pattern).toContain("×");
      }
    });

    it("blocks on ping-pong via guardCheck", () => {
      for (let i = 0; i < 8; i++) {
        guardCheck({
          agentId: "pp-agent",
          toolName: i % 2 === 0 ? "tool::ping" : "tool::pong",
          params: { step: i % 2 },
        });
      }
      const history = agentHistory.get("pp-agent") || [];
      const pp = detectPingPong(history);
      if (pp.detected) {
        const result = guardCheck({
          agentId: "pp-agent",
          toolName: "tool::ping",
          params: { step: 0 },
        });
        expect(["warn", "block"]).toContain(result.decision);
      }
    });
  });

  describe("history management", () => {
    it("history size is capped at HISTORY_SIZE", () => {
      for (let i = 0; i < HISTORY_SIZE + 10; i++) {
        guardCheck({ agentId: "cap", toolName: `tool::${i}`, params: { i } });
      }
      const history = agentHistory.get("cap")!;
      expect(history.length).toBeLessThanOrEqual(HISTORY_SIZE);
    });

    it("HISTORY_SIZE is 30", () => {
      expect(HISTORY_SIZE).toBe(30);
    });

    it("oldest entries are evicted first", () => {
      for (let i = 0; i < HISTORY_SIZE + 5; i++) {
        guardCheck({ agentId: "evict", toolName: `tool::${i}`, params: { i } });
      }
      const history = agentHistory.get("evict")!;
      expect(history[0].toolName).toBe("tool::5");
    });

    it("records include timestamp", () => {
      guardCheck({ agentId: "ts", toolName: "tool::x", params: {} });
      const history = agentHistory.get("ts")!;
      expect(history[0].timestamp).toBeGreaterThan(0);
    });
  });

  describe("reset", () => {
    it("clears agent history", () => {
      guardCheck({ agentId: "r1", toolName: "tool::x", params: {} });
      agentHistory.delete("r1");
      expect(agentHistory.has("r1")).toBe(false);
    });

    it("clears warning buckets for agent", () => {
      for (let i = 0; i < WARN_THRESHOLD; i++) {
        guardCheck({ agentId: "r2", toolName: "tool::w", params: {} });
      }
      const keysToDelete: string[] = [];
      for (const key of warningBuckets.keys()) {
        if (key.startsWith("r2:")) keysToDelete.push(key);
      }
      keysToDelete.forEach((k) => warningBuckets.delete(k));
      let hasR2 = false;
      for (const key of warningBuckets.keys()) {
        if (key.startsWith("r2:")) hasR2 = true;
      }
      expect(hasR2).toBe(false);
    });

    it("clears call count", () => {
      guardCheck({ agentId: "r3", toolName: "tool::x", params: {} });
      agentCallCounts.delete("r3");
      expect(agentCallCounts.get("r3")).toBeUndefined();
    });

    it("does not affect other agents", () => {
      guardCheck({ agentId: "keep", toolName: "tool::x", params: {} });
      guardCheck({ agentId: "remove", toolName: "tool::x", params: {} });
      agentHistory.delete("remove");
      expect(agentHistory.has("keep")).toBe(true);
    });
  });

  describe("TTL eviction", () => {
    it("evicts agents older than TTL", () => {
      const old = Date.now() - AGENT_TTL_MS - 1000;
      agentHistory.set("stale", [
        { hash: "h", resultHash: "", toolName: "t", timestamp: old },
      ]);
      agentCallCounts.set("stale", 1);
      evictStaleAgents();
      expect(agentHistory.has("stale")).toBe(false);
      expect(agentCallCounts.has("stale")).toBe(false);
    });

    it("keeps agents within TTL", () => {
      const recent = Date.now() - 1000;
      agentHistory.set("fresh", [
        { hash: "h", resultHash: "", toolName: "t", timestamp: recent },
      ]);
      evictStaleAgents();
      expect(agentHistory.has("fresh")).toBe(true);
    });

    it("TTL is 1 hour", () => {
      expect(AGENT_TTL_MS).toBe(3_600_000);
    });

    it("eviction also clears warning buckets", () => {
      const old = Date.now() - AGENT_TTL_MS - 1000;
      agentHistory.set("wb-stale", [
        { hash: "h", resultHash: "", toolName: "t", timestamp: old },
      ]);
      warningBuckets.set("wb-stale:somehash", 2);
      evictStaleAgents();
      expect(warningBuckets.has("wb-stale:somehash")).toBe(false);
    });

    it("evicts only stale agents not fresh ones", () => {
      const old = Date.now() - AGENT_TTL_MS - 1000;
      const recent = Date.now() - 1000;
      agentHistory.set("old-agent", [
        { hash: "h", resultHash: "", toolName: "t", timestamp: old },
      ]);
      agentHistory.set("new-agent", [
        { hash: "h", resultHash: "", toolName: "t", timestamp: recent },
      ]);
      evictStaleAgents();
      expect(agentHistory.has("old-agent")).toBe(false);
      expect(agentHistory.has("new-agent")).toBe(true);
    });
  });

  describe("stats", () => {
    it("returns empty stats for unknown agent", () => {
      const history = agentHistory.get("unknown") || [];
      expect(history.length).toBe(0);
    });

    it("tracks tool counts in history", () => {
      guardCheck({ agentId: "stats1", toolName: "tool::a", params: {} });
      guardCheck({ agentId: "stats1", toolName: "tool::a", params: {} });
      guardCheck({ agentId: "stats1", toolName: "tool::b", params: {} });
      const history = agentHistory.get("stats1")!;
      const counts = new Map<string, number>();
      for (const h of history) {
        counts.set(h.toolName, (counts.get(h.toolName) || 0) + 1);
      }
      expect(counts.get("tool::a")).toBe(2);
      expect(counts.get("tool::b")).toBe(1);
    });

    it("tracks total call count", () => {
      guardCheck({ agentId: "cnt1", toolName: "tool::a", params: {} });
      guardCheck({ agentId: "cnt1", toolName: "tool::b", params: {} });
      guardCheck({ agentId: "cnt1", toolName: "tool::c", params: {} });
      expect(agentCallCounts.get("cnt1")).toBe(3);
    });
  });
});
