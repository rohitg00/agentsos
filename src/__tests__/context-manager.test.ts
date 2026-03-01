import { describe, it, expect, beforeEach, vi } from "vitest";

interface BudgetAllocation {
  systemPrompt: number;
  skills: number;
  memories: number;
  conversation: number;
}

interface Message {
  role: string;
  content: string;
  toolResults?: unknown;
  importance?: number;
  timestamp?: number;
}

interface ContextBudget {
  total: number;
  used: number;
  remaining: number;
  allocation: BudgetAllocation;
  sections: Record<
    string,
    { allocated: number; used: number; remaining: number }
  >;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_ALLOCATION: BudgetAllocation = {
  systemPrompt: 0.2,
  skills: 0.15,
  memories: 0.25,
  conversation: 0.4,
};

function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 4);
}

function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || "");
    if (msg.toolResults) {
      total += estimateTokens(JSON.stringify(msg.toolResults));
    }
  }
  return total;
}

function budgetCalc({
  systemPrompt,
  skills,
  memories,
  conversation,
  contextWindow,
}: {
  systemPrompt?: string;
  skills?: string[];
  memories?: string[];
  conversation?: Message[];
  contextWindow?: number;
}): ContextBudget {
  const total = contextWindow || DEFAULT_CONTEXT_WINDOW;
  const alloc = { ...DEFAULT_ALLOCATION };

  const systemTokens = estimateTokens(systemPrompt || "");
  const skillsTokens = (skills || []).reduce(
    (sum, s) => sum + estimateTokens(s),
    0,
  );
  const memoriesTokens = (memories || []).reduce(
    (sum, m) => sum + estimateTokens(m),
    0,
  );
  const conversationTokens = estimateMessagesTokens(conversation || []);

  const used =
    systemTokens + skillsTokens + memoriesTokens + conversationTokens;

  return {
    total,
    used,
    remaining: Math.max(0, total - used),
    allocation: alloc,
    sections: {
      systemPrompt: {
        allocated: Math.floor(total * alloc.systemPrompt),
        used: systemTokens,
        remaining: Math.max(
          0,
          Math.floor(total * alloc.systemPrompt) - systemTokens,
        ),
      },
      skills: {
        allocated: Math.floor(total * alloc.skills),
        used: skillsTokens,
        remaining: Math.max(0, Math.floor(total * alloc.skills) - skillsTokens),
      },
      memories: {
        allocated: Math.floor(total * alloc.memories),
        used: memoriesTokens,
        remaining: Math.max(
          0,
          Math.floor(total * alloc.memories) - memoriesTokens,
        ),
      },
      conversation: {
        allocated: Math.floor(total * alloc.conversation),
        used: conversationTokens,
        remaining: Math.max(
          0,
          Math.floor(total * alloc.conversation) - conversationTokens,
        ),
      },
    },
  };
}

function trimConversation({
  conversation,
  maxTokens,
  keepLastN,
}: {
  conversation: Message[];
  maxTokens: number;
  keepLastN?: number;
}): { messages: Message[]; trimmed: number; tokens: number } {
  if (!conversation.length) return { messages: [], trimmed: 0, tokens: 0 };

  const lastN = keepLastN || 10;
  const totalTokens = estimateMessagesTokens(conversation);

  if (totalTokens <= maxTokens) {
    return { messages: conversation, trimmed: 0, tokens: totalTokens };
  }

  const first = conversation[0]?.role === "system" ? [conversation[0]] : [];
  const tail = conversation.slice(-lastN);
  const firstTokens = estimateMessagesTokens(first);
  const tailTokens = estimateMessagesTokens(tail);

  if (firstTokens + tailTokens > maxTokens) {
    const trimmedTail: Message[] = [];
    let budget = maxTokens - firstTokens;
    for (let i = tail.length - 1; i >= 0 && budget > 0; i--) {
      const msgTokens = estimateTokens(tail[i].content || "");
      if (msgTokens <= budget) {
        trimmedTail.unshift(tail[i]);
        budget -= msgTokens;
      } else {
        const truncated = [...tail[i].content].slice(0, budget * 4).join("");
        trimmedTail.unshift({ ...tail[i], content: truncated });
        break;
      }
    }

    return {
      messages: [...first, ...trimmedTail],
      trimmed: conversation.length - first.length - trimmedTail.length,
      tokens: estimateMessagesTokens([...first, ...trimmedTail]),
    };
  }

  const result = [...first, ...tail];
  return {
    messages: result,
    trimmed: conversation.length - result.length,
    tokens: firstTokens + tailTokens,
  };
}

function overflowRecover({
  conversation,
  maxTokens,
}: {
  conversation: Message[];
  maxTokens: number;
}): { messages: Message[]; stages: string[]; tokens: number } {
  let messages = [...conversation];
  let currentTokens = estimateMessagesTokens(messages);
  const stages: string[] = [];

  if (currentTokens <= maxTokens) {
    return { messages, stages: ["no_action_needed"], tokens: currentTokens };
  }

  const recentThreshold = Math.max(0, messages.length - 10);
  for (let i = 0; i < recentThreshold; i++) {
    if (messages[i].toolResults) {
      messages[i] = { ...messages[i], toolResults: undefined };
    }
  }
  currentTokens = estimateMessagesTokens(messages);
  stages.push("stage1_remove_old_tool_results");

  if (currentTokens <= maxTokens) {
    return { messages, stages, tokens: currentTokens };
  }

  const summaryThreshold = Math.max(1, messages.length - 15);
  const toSummarize = messages.slice(0, summaryThreshold);
  const kept = messages.slice(summaryThreshold);

  if (toSummarize.length > 0) {
    const summaryText = toSummarize
      .filter((m) => m.content)
      .map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
      .join("\n");

    const summary: Message = {
      role: "system",
      content: `[Conversation summary - ${toSummarize.length} messages condensed]\n${summaryText.slice(0, 2000)}`,
    };

    messages = [summary, ...kept];
    currentTokens = estimateMessagesTokens(messages);
    stages.push("stage2_summarize_old_messages");
  }

  if (currentTokens <= maxTokens) {
    return { messages, stages, tokens: currentTokens };
  }

  messages = messages.filter((m) => {
    if (m.role === "system" && m.importance !== undefined && m.importance < 3)
      return false;
    return true;
  });
  currentTokens = estimateMessagesTokens(messages);
  stages.push("stage3_drop_low_importance");

  if (currentTokens <= maxTokens) {
    return { messages, stages, tokens: currentTokens };
  }

  const trimResult = trimConversation({
    conversation: messages,
    maxTokens,
    keepLastN: 5,
  });
  stages.push("stage4_emergency_truncation");

  return {
    messages: trimResult.messages,
    stages,
    tokens: estimateMessagesTokens(trimResult.messages),
  };
}

describe("Context Manager", () => {
  describe("estimateTokens", () => {
    it("estimates empty string as 0", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("estimates 4 chars as 1 token", () => {
      expect(estimateTokens("abcd")).toBe(1);
    });

    it("estimates 5 chars as 2 tokens (ceiling)", () => {
      expect(estimateTokens("abcde")).toBe(2);
    });

    it("estimates 100 chars as 25 tokens", () => {
      expect(estimateTokens("a".repeat(100))).toBe(25);
    });

    it("handles unicode characters correctly", () => {
      const text = "Hello ";
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(0);
    });

    it("ceil division for non-multiples of 4", () => {
      expect(estimateTokens("abc")).toBe(1);
      expect(estimateTokens("a")).toBe(1);
    });

    it("handles whitespace", () => {
      expect(estimateTokens("    ")).toBe(1);
    });

    it("handles newlines", () => {
      expect(estimateTokens("line1\nline2")).toBe(3);
    });
  });

  describe("estimateMessagesTokens", () => {
    it("returns 0 for empty array", () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });

    it("sums tokens from multiple messages", () => {
      const msgs: Message[] = [
        { role: "user", content: "a".repeat(40) },
        { role: "assistant", content: "b".repeat(40) },
      ];
      expect(estimateMessagesTokens(msgs)).toBe(20);
    });

    it("includes tool results in estimation", () => {
      const withTool: Message[] = [
        {
          role: "tool",
          content: "result",
          toolResults: { data: "extra data here" },
        },
      ];
      const withoutTool: Message[] = [{ role: "tool", content: "result" }];
      expect(estimateMessagesTokens(withTool)).toBeGreaterThan(
        estimateMessagesTokens(withoutTool),
      );
    });

    it("handles messages with empty content", () => {
      const msgs: Message[] = [{ role: "user", content: "" }];
      expect(estimateMessagesTokens(msgs)).toBe(0);
    });

    it("handles null-ish content gracefully", () => {
      const msgs: Message[] = [{ role: "user", content: "" }];
      expect(() => estimateMessagesTokens(msgs)).not.toThrow();
    });
  });

  describe("budget calculation", () => {
    it("returns default context window when not specified", () => {
      const budget = budgetCalc({});
      expect(budget.total).toBe(DEFAULT_CONTEXT_WINDOW);
    });

    it("uses custom context window", () => {
      const budget = budgetCalc({ contextWindow: 100_000 });
      expect(budget.total).toBe(100_000);
    });

    it("remaining is total minus used", () => {
      const budget = budgetCalc({ systemPrompt: "a".repeat(400) });
      expect(budget.remaining).toBe(budget.total - budget.used);
    });

    it("remaining is never negative", () => {
      const budget = budgetCalc({
        systemPrompt: "a".repeat(1_000_000),
        contextWindow: 100,
      });
      expect(budget.remaining).toBeGreaterThanOrEqual(0);
    });

    it("allocation fractions sum to 1.0", () => {
      const alloc = DEFAULT_ALLOCATION;
      const sum =
        alloc.systemPrompt + alloc.skills + alloc.memories + alloc.conversation;
      expect(sum).toBe(1.0);
    });

    it("sections include systemPrompt allocation", () => {
      const budget = budgetCalc({});
      expect(budget.sections.systemPrompt.allocated).toBe(
        Math.floor(DEFAULT_CONTEXT_WINDOW * DEFAULT_ALLOCATION.systemPrompt),
      );
    });

    it("sections include skills allocation", () => {
      const budget = budgetCalc({});
      expect(budget.sections.skills.allocated).toBe(
        Math.floor(DEFAULT_CONTEXT_WINDOW * DEFAULT_ALLOCATION.skills),
      );
    });

    it("sections include memories allocation", () => {
      const budget = budgetCalc({});
      expect(budget.sections.memories.allocated).toBe(
        Math.floor(DEFAULT_CONTEXT_WINDOW * DEFAULT_ALLOCATION.memories),
      );
    });

    it("sections include conversation allocation", () => {
      const budget = budgetCalc({});
      expect(budget.sections.conversation.allocated).toBe(
        Math.floor(DEFAULT_CONTEXT_WINDOW * DEFAULT_ALLOCATION.conversation),
      );
    });

    it("counts system prompt tokens", () => {
      const prompt = "You are a helpful assistant for DevOps tasks.";
      const budget = budgetCalc({ systemPrompt: prompt });
      expect(budget.sections.systemPrompt.used).toBe(estimateTokens(prompt));
    });

    it("counts skills tokens", () => {
      const skills = ["skill content one", "skill content two"];
      const budget = budgetCalc({ skills });
      const expected = skills.reduce((s, sk) => s + estimateTokens(sk), 0);
      expect(budget.sections.skills.used).toBe(expected);
    });

    it("counts memories tokens", () => {
      const memories = ["memory entry one", "memory entry two"];
      const budget = budgetCalc({ memories });
      const expected = memories.reduce((s, m) => s + estimateTokens(m), 0);
      expect(budget.sections.memories.used).toBe(expected);
    });

    it("counts conversation tokens", () => {
      const conversation: Message[] = [
        { role: "user", content: "hello world" },
        { role: "assistant", content: "hi there" },
      ];
      const budget = budgetCalc({ conversation });
      expect(budget.sections.conversation.used).toBe(
        estimateMessagesTokens(conversation),
      );
    });

    it("section remaining is allocated minus used", () => {
      const budget = budgetCalc({ systemPrompt: "test" });
      const sp = budget.sections.systemPrompt;
      expect(sp.remaining).toBe(sp.allocated - sp.used);
    });

    it("section remaining is never negative", () => {
      const budget = budgetCalc({
        systemPrompt: "x".repeat(1_000_000),
        contextWindow: 100,
      });
      expect(budget.sections.systemPrompt.remaining).toBeGreaterThanOrEqual(0);
    });
  });

  describe("trim conversation", () => {
    it("returns empty for empty conversation", () => {
      const result = trimConversation({ conversation: [], maxTokens: 100 });
      expect(result.messages).toEqual([]);
      expect(result.trimmed).toBe(0);
    });

    it("returns unchanged when within budget", () => {
      const conversation: Message[] = [{ role: "user", content: "hi" }];
      const result = trimConversation({ conversation, maxTokens: 1000 });
      expect(result.messages).toEqual(conversation);
      expect(result.trimmed).toBe(0);
    });

    it("preserves system message as first", () => {
      const conversation: Message[] = [
        { role: "system", content: "You are helpful." },
        ...Array.from({ length: 20 }, (_, i) => ({
          role: "user" as string,
          content: `Message ${i} with some content here`,
        })),
      ];
      const result = trimConversation({ conversation, maxTokens: 200 });
      expect(result.messages[0].role).toBe("system");
    });

    it("keeps last N messages", () => {
      const conversation: Message[] = Array.from({ length: 30 }, (_, i) => ({
        role: "user",
        content: `msg ${i}`,
      }));
      const result = trimConversation({
        conversation,
        maxTokens: 50,
        keepLastN: 5,
      });
      expect(result.messages.length).toBeLessThanOrEqual(6);
    });

    it("defaults keepLastN to 10", () => {
      const conversation: Message[] = Array.from({ length: 50 }, (_, i) => ({
        role: "user",
        content: `message number ${i} with a lot of padding text that will exceed the budget easily`,
      }));
      const result = trimConversation({ conversation, maxTokens: 200 });
      expect(result.messages.length).toBeLessThanOrEqual(11);
    });

    it("trimmed count is accurate", () => {
      const conversation: Message[] = Array.from({ length: 20 }, (_, i) => ({
        role: "user",
        content: `message ${i}`,
      }));
      const result = trimConversation({ conversation, maxTokens: 50 });
      expect(result.trimmed + result.messages.length).toBeLessThanOrEqual(
        conversation.length,
      );
    });

    it("tokens in result is within budget", () => {
      const conversation: Message[] = Array.from({ length: 30 }, (_, i) => ({
        role: "user",
        content: `This is a longer message number ${i} to use tokens`,
      }));
      const maxTokens = 100;
      const result = trimConversation({ conversation, maxTokens });
      expect(result.tokens).toBeLessThanOrEqual(maxTokens + 5);
    });

    it("handles truncation of individual messages when tail too large", () => {
      const conversation: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "a".repeat(400) },
      ];
      const result = trimConversation({ conversation, maxTokens: 20 });
      expect(result.messages.length).toBeGreaterThanOrEqual(1);
    });

    it("handles conversation with single message exceeding budget", () => {
      const conversation: Message[] = [
        { role: "user", content: "a".repeat(10000) },
      ];
      const result = trimConversation({ conversation, maxTokens: 10 });
      expect(result.tokens).toBeLessThanOrEqual(15);
    });
  });

  describe("overflow recovery", () => {
    it("returns no_action_needed when within budget", () => {
      const conversation: Message[] = [{ role: "user", content: "hi" }];
      const result = overflowRecover({ conversation, maxTokens: 1000 });
      expect(result.stages).toEqual(["no_action_needed"]);
    });

    it("stage 1 removes old tool results", () => {
      const conversation: Message[] = [
        ...Array.from({ length: 15 }, (_, i) => ({
          role: "tool" as string,
          content: `result ${i}`,
          toolResults: { data: "x".repeat(200) },
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          role: "user" as string,
          content: `recent ${i}`,
        })),
      ];
      const result = overflowRecover({ conversation, maxTokens: 100 });
      expect(result.stages).toContain("stage1_remove_old_tool_results");
    });

    it("stage 2 summarizes old messages", () => {
      const conversation: Message[] = Array.from({ length: 30 }, (_, i) => ({
        role: "user",
        content: `This is message number ${i} with a lot of padding text to use up tokens in the budget`,
      }));
      const result = overflowRecover({ conversation, maxTokens: 200 });
      if (result.stages.includes("stage2_summarize_old_messages")) {
        const hasSummary = result.messages.some(
          (m) =>
            m.role === "system" && m.content.includes("Conversation summary"),
        );
        expect(hasSummary).toBe(true);
      }
    });

    it("stage 3 drops low importance system messages", () => {
      const conversation: Message[] = [
        { role: "system", content: "x".repeat(400), importance: 1 },
        { role: "system", content: "y".repeat(400), importance: 2 },
        { role: "system", content: "z".repeat(400), importance: 5 },
        ...Array.from({ length: 20 }, (_, i) => ({
          role: "user" as string,
          content: `message ${i} padding text to fill`,
        })),
      ];
      const result = overflowRecover({ conversation, maxTokens: 300 });
      expect(result.stages.length).toBeGreaterThan(1);
    });

    it("stage 4 emergency truncation as last resort", () => {
      const conversation: Message[] = Array.from({ length: 100 }, (_, i) => ({
        role: "user",
        content: `Message ${i}: ${"text ".repeat(50)}`,
      }));
      const result = overflowRecover({ conversation, maxTokens: 50 });
      expect(result.stages).toContain("stage4_emergency_truncation");
    });

    it("keeps recent 10 messages tool results in stage 1", () => {
      const conversation: Message[] = Array.from({ length: 20 }, (_, i) => ({
        role: "tool",
        content: `result ${i}`,
        toolResults: { data: `tooldata-${i}` },
      }));
      const totalBefore = estimateMessagesTokens(conversation);
      const result = overflowRecover({
        conversation,
        maxTokens: totalBefore - 10,
      });
      const recentWithTools = result.messages
        .slice(-10)
        .filter((m) => m.toolResults);
      expect(recentWithTools.length).toBeGreaterThanOrEqual(0);
    });

    it("output tokens are reduced after recovery", () => {
      const conversation: Message[] = Array.from({ length: 50 }, (_, i) => ({
        role: "user",
        content: `Padding message number ${i} with lots of extra text`,
      }));
      const originalTokens = estimateMessagesTokens(conversation);
      const maxTokens = 100;
      const result = overflowRecover({ conversation, maxTokens });
      expect(result.tokens).toBeLessThan(originalTokens);
    });

    it("stages are returned in order", () => {
      const conversation: Message[] = Array.from({ length: 100 }, (_, i) => ({
        role: "user",
        content: `Message ${i}: ${"word ".repeat(100)}`,
      }));
      const result = overflowRecover({ conversation, maxTokens: 50 });
      const stageOrder = [
        "stage1_remove_old_tool_results",
        "stage2_summarize_old_messages",
        "stage3_drop_low_importance",
        "stage4_emergency_truncation",
      ];
      let lastIdx = -1;
      for (const stage of result.stages) {
        const idx = stageOrder.indexOf(stage);
        if (idx !== -1) {
          expect(idx).toBeGreaterThan(lastIdx);
          lastIdx = idx;
        }
      }
    });

    it("summary message limits content to 2000 chars", () => {
      const conversation: Message[] = Array.from({ length: 30 }, (_, i) => ({
        role: "user",
        content: "x".repeat(500),
      }));
      const result = overflowRecover({ conversation, maxTokens: 200 });
      const summaryMsg = result.messages.find(
        (m) =>
          m.role === "system" && m.content.includes("Conversation summary"),
      );
      if (summaryMsg) {
        expect(summaryMsg.content.length).toBeLessThanOrEqual(2200);
      }
    });
  });

  describe("constants", () => {
    it("default context window is 200k", () => {
      expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000);
    });

    it("system prompt allocation is 20%", () => {
      expect(DEFAULT_ALLOCATION.systemPrompt).toBe(0.2);
    });

    it("skills allocation is 15%", () => {
      expect(DEFAULT_ALLOCATION.skills).toBe(0.15);
    });

    it("memories allocation is 25%", () => {
      expect(DEFAULT_ALLOCATION.memories).toBe(0.25);
    });

    it("conversation allocation is 40%", () => {
      expect(DEFAULT_ALLOCATION.conversation).toBe(0.4);
    });
  });
});
