import { init } from "iii-sdk";
import type { CostRecord, CostSummary, BudgetStatus } from "./types.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "cost-tracker" },
);

const PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1": { input: 2, output: 8 },
  o3: { input: 10, output: 40 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "deepseek-chat": { input: 0.14, output: 0.28 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "llama-3.3-70b": { input: 0.59, output: 0.79 },
  "grok-2": { input: 2, output: 10 },
  "grok-3": { input: 3, output: 15 },
  "grok-3-mini": { input: 0.3, output: 0.5 },
  "mistral-large": { input: 2, output: 6 },
  "sonar-pro": { input: 3, output: 15 },
  sonar: { input: 1, output: 1 },
  "command-a": { input: 2.5, output: 10 },
  "command-r-plus": { input: 3, output: 15 },
  "command-r": { input: 0.5, output: 1.5 },
  "jamba-1.5-large": { input: 2, output: 8 },
  "jamba-1.5-mini": { input: 0.2, output: 0.4 },
  "cerebras-llama-3.3-70b": { input: 0.6, output: 0.6 },
  "samba-llama-3.1-405b": { input: 5, output: 10 },
  "samba-llama-3.3-70b": { input: 0.6, output: 0.6 },
  "hf-llama-3.3-70b": { input: 0.36, output: 0.36 },
  "hf-mistral-7b": { input: 0, output: 0 },
  "replicate-llama-3.3-70b": { input: 0.65, output: 2.75 },
  "qwen-max": { input: 2.4, output: 9.6 },
  "qwen-plus": { input: 0.5, output: 1.5 },
  "qwen-turbo": { input: 0.05, output: 0.15 },
  "abab7-chat": { input: 1, output: 1 },
  "glm-4-plus": { input: 7, output: 7 },
  "glm-4": { input: 1.4, output: 1.4 },
  "moonshot-v1-128k": { input: 8.5, output: 8.5 },
  "moonshot-v1-32k": { input: 3.3, output: 3.3 },
  "ernie-4.0-turbo": { input: 4.2, output: 8.4 },
  "ernie-3.5-turbo": { input: 0.56, output: 1.12 },
  "bedrock-claude-sonnet": { input: 3, output: 15 },
  "bedrock-nova-pro": { input: 0.8, output: 3.2 },
  "bedrock-llama-3.3-70b": { input: 0.72, output: 0.72 },
  "copilot-gpt-4o": { input: 2.5, output: 10 },
  "together-llama-3.3-70b": { input: 0.88, output: 0.88 },
  "fireworks-llama-3.3-70b": { input: 0.9, output: 0.9 },
};

registerFunction(
  {
    id: "cost::track",
    description: "Calculate and store cost for an LLM call",
    metadata: { category: "cost" },
  },
  async (input: {
    agentId: string;
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): Promise<CostRecord> => {
    const pricing = PRICING[input.model];
    const inputPrice = pricing?.input ?? 0;
    const outputPrice = pricing?.output ?? 0;
    const cacheReadPrice = pricing?.cacheRead ?? inputPrice * 0.1;
    const cacheWritePrice = pricing?.cacheWrite ?? inputPrice * 1.25;

    const cacheRead = input.cacheReadTokens ?? 0;
    const cacheWrite = input.cacheWriteTokens ?? 0;

    const cost =
      (input.inputTokens * inputPrice +
        input.outputTokens * outputPrice +
        cacheRead * cacheReadPrice +
        cacheWrite * cacheWritePrice) /
      1_000_000;

    const now = Date.now();
    const date = new Date(now).toISOString().slice(0, 10);
    const key = `${date}:${input.agentId}:${input.sessionId}:${now}`;

    const record: CostRecord = {
      agentId: input.agentId,
      sessionId: input.sessionId,
      model: input.model,
      provider: pricing ? "known" : "unknown",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cost,
      timestamp: now,
    };

    await trigger("state::set", {
      scope: "cost_records",
      key,
      value: record,
    });

    triggerVoid("state::update", {
      scope: "cost_daily",
      key: `${date}:${input.agentId}`,
      operations: [
        { type: "increment", path: "cost", value: cost },
        { type: "increment", path: "inputTokens", value: input.inputTokens },
        { type: "increment", path: "outputTokens", value: input.outputTokens },
        { type: "increment", path: "calls", value: 1 },
      ],
    });

    triggerVoid("state::update", {
      scope: "cost_daily",
      key: date,
      operations: [
        { type: "increment", path: "totalCost", value: cost },
        { type: "increment", path: "totalCalls", value: 1 },
      ],
    });

    return record;
  },
);

registerFunction(
  {
    id: "cost::summary",
    description: "Aggregate cost data with grouping",
    metadata: { category: "cost" },
  },
  async (input: {
    agentId?: string;
    startDate?: string;
    endDate?: string;
    groupBy?: "day" | "agent" | "model";
  }): Promise<CostSummary> => {
    const now = new Date();
    const start = input.startDate || now.toISOString().slice(0, 10);
    const end = input.endDate || now.toISOString().slice(0, 10);
    const groupBy = input.groupBy || "day";

    const records: CostRecord[] = [];
    const startDate = new Date(start);
    const endDate = new Date(end);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const prefix = input.agentId ? `${dateStr}:${input.agentId}` : dateStr;
      const dayRecords: any = await trigger("state::list", {
        scope: "cost_records",
        prefix,
      }).catch(() => []);

      if (Array.isArray(dayRecords)) {
        for (const r of dayRecords) {
          if (r.value) records.push(r.value);
          else if (r.cost !== undefined) records.push(r);
        }
      }
    }

    const grouped = new Map<string, { cost: number; tokens: number }>();
    let total = 0;

    for (const r of records) {
      let key: string;
      if (groupBy === "day") key = new Date(r.timestamp).toISOString().slice(0, 10);
      else if (groupBy === "agent") key = r.agentId;
      else key = r.model;

      const entry = grouped.get(key) || { cost: 0, tokens: 0 };
      entry.cost += r.cost;
      entry.tokens += r.inputTokens + r.outputTokens;
      grouped.set(key, entry);
      total += r.cost;
    }

    const breakdown = [...grouped.entries()].map(([key, val]) => ({
      key,
      cost: Math.round(val.cost * 1_000_000) / 1_000_000,
      tokens: val.tokens,
    }));

    return {
      total: Math.round(total * 1_000_000) / 1_000_000,
      breakdown,
      period: { start, end },
    };
  },
);

registerFunction(
  {
    id: "cost::budget_check",
    description: "Check agent spend against budget limits",
    metadata: { category: "cost" },
  },
  async ({ agentId }: { agentId: string }): Promise<BudgetStatus> => {
    const config: any = await trigger("state::get", {
      scope: "agents",
      key: agentId,
    }).catch(() => null);

    const dailyBudget = config?.resources?.dailyBudget ?? Infinity;
    const monthlyBudget = config?.resources?.monthlyBudget ?? Infinity;

    const today = new Date().toISOString().slice(0, 10);
    const dailyData: any = await trigger("state::get", {
      scope: "cost_daily",
      key: `${today}:${agentId}`,
    }).catch(() => null);

    const dailySpent = dailyData?.cost ?? 0;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let monthlySpent = 0;

    for (let d = new Date(monthStart); d <= now; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const dayData: any = await trigger("state::get", {
        scope: "cost_daily",
        key: `${dateStr}:${agentId}`,
      }).catch(() => null);
      monthlySpent += dayData?.cost ?? 0;
    }

    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projectedMonthly = dayOfMonth > 0 ? (monthlySpent / dayOfMonth) * daysInMonth : 0;

    const limit = Math.min(dailyBudget, monthlyBudget);
    const spent = dailyBudget <= monthlyBudget ? dailySpent : monthlySpent;
    const withinBudget = dailySpent <= dailyBudget && monthlySpent <= monthlyBudget;

    if (!withinBudget) {
      triggerVoid("security::audit", {
        type: "budget_exceeded",
        agentId,
        dailySpent,
        monthlySpent,
        dailyBudget,
        monthlyBudget,
      });
    }

    return {
      withinBudget,
      spent: Math.round(spent * 1_000_000) / 1_000_000,
      limit: Number.isFinite(limit) ? limit : -1,
      remaining: Number.isFinite(limit) ? Math.round(Math.max(0, limit - spent) * 1_000_000) / 1_000_000 : -1,
      projectedMonthly: Math.round(projectedMonthly * 1_000_000) / 1_000_000,
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "cost::summary",
  config: { api_path: "api/costs/summary", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "cost::budget_check",
  config: { api_path: "api/costs/:agentId/budget", http_method: "GET" },
});
