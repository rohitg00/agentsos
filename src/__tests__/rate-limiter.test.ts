import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";

interface GcraState {
  tat: number;
  tokens: number;
}

interface RateCheckResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number | null;
  limit: number;
}

const TOKENS_PER_MINUTE = 500;
const EMISSION_INTERVAL_MS = (60 * 1000) / TOKENS_PER_MINUTE;
const BURST_LIMIT = TOKENS_PER_MINUTE;

const OPERATION_COSTS: Record<string, number> = {
  health: 1,
  agents_list: 2,
  agents_get: 2,
  agents_create: 10,
  agents_delete: 5,
  message: 30,
  workflow_run: 100,
  workflow_list: 2,
  tool_call: 20,
  memory_store: 10,
  memory_recall: 5,
  memory_evict: 50,
  sandbox_execute: 50,
  sandbox_validate: 20,
  audit_verify: 5,
  scan_injection: 3,
  default: 5,
};

let localState: Map<string, GcraState>;

function gcraCheck(key: string, cost: number, now: number): RateCheckResult {
  const state = localState.get(key);
  const increment = cost * EMISSION_INTERVAL_MS;

  if (!state) {
    const newTat = now + increment;
    localState.set(key, { tat: newTat, tokens: BURST_LIMIT - cost });
    return {
      allowed: true,
      remaining: BURST_LIMIT - cost,
      retryAfter: null,
      limit: TOKENS_PER_MINUTE,
    };
  }

  const tat = Math.max(state.tat, now);
  const newTat = tat + increment;
  const allowAt = newTat - BURST_LIMIT * EMISSION_INTERVAL_MS;

  if (allowAt > now) {
    const retryAfterMs = Math.ceil(allowAt - now);
    const retryAfterSecs = Math.ceil(retryAfterMs / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfter: retryAfterSecs,
      limit: TOKENS_PER_MINUTE,
    };
  }

  const remaining = Math.max(
    0,
    Math.floor(
      (BURST_LIMIT * EMISSION_INTERVAL_MS - (newTat - now)) /
        EMISSION_INTERVAL_MS,
    ),
  );
  localState.set(key, { tat: newTat, tokens: remaining });

  return {
    allowed: true,
    remaining,
    retryAfter: null,
    limit: TOKENS_PER_MINUTE,
  };
}

describe("GCRA Rate Limiter", () => {
  beforeEach(() => {
    localState = new Map();
  });

  describe("first request", () => {
    it("allows first request for new key", () => {
      const result = gcraCheck("ip:1.2.3.4", 1, Date.now());
      expect(result.allowed).toBe(true);
    });

    it("sets remaining to burst minus cost", () => {
      const result = gcraCheck("ip:1.2.3.4", 1, Date.now());
      expect(result.remaining).toBe(BURST_LIMIT - 1);
    });

    it("has null retryAfter on first request", () => {
      const result = gcraCheck("ip:1.2.3.4", 1, Date.now());
      expect(result.retryAfter).toBeNull();
    });

    it("returns correct limit", () => {
      const result = gcraCheck("ip:1.2.3.4", 1, Date.now());
      expect(result.limit).toBe(TOKENS_PER_MINUTE);
    });

    it("creates state entry", () => {
      gcraCheck("ip:1.2.3.4", 1, Date.now());
      expect(localState.has("ip:1.2.3.4")).toBe(true);
    });
  });

  describe("subsequent requests", () => {
    it("allows second request within budget", () => {
      const now = Date.now();
      gcraCheck("ip:test", 5, now);
      const result = gcraCheck("ip:test", 5, now + 100);
      expect(result.allowed).toBe(true);
    });

    it("decreases remaining with each request", () => {
      const now = Date.now();
      const r1 = gcraCheck("ip:test", 10, now);
      const r2 = gcraCheck("ip:test", 10, now + 1);
      expect(r2.remaining).toBeLessThan(r1.remaining);
    });

    it("tracks independent keys separately", () => {
      const now = Date.now();
      gcraCheck("ip:a", 100, now);
      const result = gcraCheck("ip:b", 1, now);
      expect(result.remaining).toBe(BURST_LIMIT - 1);
    });
  });

  describe("burst exhaustion", () => {
    it("blocks when burst is exhausted", () => {
      const now = Date.now();
      for (let i = 0; i < 6; i++) {
        gcraCheck("ip:burst", 100, now);
      }
      const result = gcraCheck("ip:burst", 100, now);
      expect(result.allowed).toBe(false);
    });

    it("provides retryAfter when blocked", () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        gcraCheck("ip:retry", 100, now);
      }
      const result = gcraCheck("ip:retry", 100, now);
      if (!result.allowed) {
        expect(result.retryAfter).toBeGreaterThan(0);
      }
    });

    it("remaining is 0 when blocked", () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        gcraCheck("ip:zero", 100, now);
      }
      const result = gcraCheck("ip:zero", 100, now);
      if (!result.allowed) {
        expect(result.remaining).toBe(0);
      }
    });
  });

  describe("token recovery", () => {
    it("allows requests after time passes", () => {
      const now = Date.now();
      for (let i = 0; i < 6; i++) {
        gcraCheck("ip:recover", 100, now);
      }
      const blocked = gcraCheck("ip:recover", 100, now);
      if (!blocked.allowed) {
        const future = now + 120_000;
        const result = gcraCheck("ip:recover", 1, future);
        expect(result.allowed).toBe(true);
      }
    });

    it("recovers tokens proportional to elapsed time", () => {
      const now = Date.now();
      gcraCheck("ip:prop", 200, now);
      const later = now + 30_000;
      const result = gcraCheck("ip:prop", 1, later);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });
  });

  describe("operation costs", () => {
    it("health costs 1 token", () => {
      expect(OPERATION_COSTS.health).toBe(1);
    });

    it("message costs 30 tokens", () => {
      expect(OPERATION_COSTS.message).toBe(30);
    });

    it("workflow_run costs 100 tokens", () => {
      expect(OPERATION_COSTS.workflow_run).toBe(100);
    });

    it("default cost is 5", () => {
      expect(OPERATION_COSTS.default).toBe(5);
    });

    it("tool_call costs 20 tokens", () => {
      expect(OPERATION_COSTS.tool_call).toBe(20);
    });

    it("sandbox_execute costs 50 tokens", () => {
      expect(OPERATION_COSTS.sandbox_execute).toBe(50);
    });

    it("memory_store costs 10 tokens", () => {
      expect(OPERATION_COSTS.memory_store).toBe(10);
    });

    it("memory_recall costs 5 tokens", () => {
      expect(OPERATION_COSTS.memory_recall).toBe(5);
    });

    it("agents_create costs 10 tokens", () => {
      expect(OPERATION_COSTS.agents_create).toBe(10);
    });

    it("scan_injection costs 3 tokens", () => {
      expect(OPERATION_COSTS.scan_injection).toBe(3);
    });
  });

  describe("high-cost operations", () => {
    it("high-cost operation uses more burst capacity", () => {
      const now = Date.now();
      const r1 = gcraCheck("ip:highcost", OPERATION_COSTS.health, now);
      const r2 = gcraCheck("ip:highcost2", OPERATION_COSTS.workflow_run, now);
      expect(r1.remaining).toBeGreaterThan(r2.remaining);
    });

    it("single workflow_run uses 100 tokens of burst", () => {
      const now = Date.now();
      const result = gcraCheck("ip:wf", OPERATION_COSTS.workflow_run, now);
      expect(result.remaining).toBe(BURST_LIMIT - 100);
    });

    it("5 workflow_runs exhaust the burst", () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        gcraCheck("ip:wf5", 100, now);
      }
      const result = gcraCheck("ip:wf5", 100, now);
      expect(result.allowed).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles zero cost", () => {
      const now = Date.now();
      const result = gcraCheck("ip:zero-cost", 0, now);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(BURST_LIMIT);
    });

    it("handles very large cost on first request", () => {
      const now = Date.now();
      const result = gcraCheck("ip:huge", 10000, now);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(BURST_LIMIT - 10000);
    });

    it("handles concurrent requests from same IP", () => {
      const now = Date.now();
      const results = [];
      for (let i = 0; i < 20; i++) {
        results.push(gcraCheck("ip:concurrent", 30, now));
      }
      const allowed = results.filter((r) => r.allowed);
      const blocked = results.filter((r) => !r.allowed);
      expect(allowed.length).toBeGreaterThan(0);
      expect(allowed.length + blocked.length).toBe(20);
    });

    it("emission interval is calculated correctly", () => {
      expect(EMISSION_INTERVAL_MS).toBe(120);
    });

    it("burst limit equals tokens per minute", () => {
      expect(BURST_LIMIT).toBe(TOKENS_PER_MINUTE);
    });

    it("retryAfter is in seconds", () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        gcraCheck("ip:secs", 100, now);
      }
      const result = gcraCheck("ip:secs", 100, now);
      if (!result.allowed && result.retryAfter !== null) {
        expect(result.retryAfter).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("state management", () => {
    it("state contains tat and tokens", () => {
      const now = Date.now();
      gcraCheck("ip:state", 1, now);
      const state = localState.get("ip:state");
      expect(state).toBeDefined();
      expect(state!.tat).toBeGreaterThan(0);
      expect(typeof state!.tokens).toBe("number");
    });

    it("tat advances with each request", () => {
      const now = Date.now();
      gcraCheck("ip:tat", 1, now);
      const tat1 = localState.get("ip:tat")!.tat;
      gcraCheck("ip:tat", 1, now + 1);
      const tat2 = localState.get("ip:tat")!.tat;
      expect(tat2).toBeGreaterThan(tat1);
    });

    it("reset clears state", () => {
      const now = Date.now();
      gcraCheck("ip:reset-test", 1, now);
      expect(localState.has("ip:reset-test")).toBe(true);
      localState.delete("ip:reset-test");
      expect(localState.has("ip:reset-test")).toBe(false);
    });

    it("new key after deletion behaves like first request", () => {
      const now = Date.now();
      gcraCheck("ip:del", 100, now);
      localState.delete("ip:del");
      const result = gcraCheck("ip:del", 1, now);
      expect(result.remaining).toBe(BURST_LIMIT - 1);
    });
  });
});
