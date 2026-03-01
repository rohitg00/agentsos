import { describe, it, expect } from "vitest";
import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  TokenUsage,
  ToolCall,
} from "../types.js";

describe("AgentConfig type", () => {
  it("accepts minimal config with only name", () => {
    const config: AgentConfig = { name: "Test Agent" };
    expect(config.name).toBe("Test Agent");
    expect(config.id).toBeUndefined();
    expect(config.description).toBeUndefined();
  });

  it("accepts full config with all fields", () => {
    const config: AgentConfig = {
      id: "agent-1",
      name: "Full Agent",
      description: "An agent with all fields",
      model: { provider: "anthropic", model: "claude-opus-4-6", maxTokens: 8192 },
      systemPrompt: "Be helpful",
      toolProfile: "default",
      capabilities: {
        tools: ["*"],
        memoryScopes: ["self"],
        networkHosts: ["example.com"],
      },
      resources: { maxTokensPerHour: 100000 },
      tags: ["test", "full"],
      createdAt: Date.now(),
    };
    expect(config.id).toBe("agent-1");
    expect(config.model?.provider).toBe("anthropic");
    expect(config.capabilities?.tools).toContain("*");
    expect(config.resources?.maxTokensPerHour).toBe(100000);
  });

  it("allows model without all sub-fields", () => {
    const config: AgentConfig = {
      name: "Partial Model",
      model: { provider: "openai" },
    };
    expect(config.model?.model).toBeUndefined();
    expect(config.model?.maxTokens).toBeUndefined();
  });

  it("allows capabilities without optional scopes", () => {
    const config: AgentConfig = {
      name: "Minimal Caps",
      capabilities: { tools: ["file::read"] },
    };
    expect(config.capabilities?.memoryScopes).toBeUndefined();
    expect(config.capabilities?.networkHosts).toBeUndefined();
  });

  it("allows empty tags array", () => {
    const config: AgentConfig = { name: "No Tags", tags: [] };
    expect(config.tags).toHaveLength(0);
  });
});

describe("ChatRequest type", () => {
  it("requires agentId and message", () => {
    const req: ChatRequest = {
      agentId: "agent-1",
      message: "Hello",
    };
    expect(req.agentId).toBe("agent-1");
    expect(req.message).toBe("Hello");
  });

  it("accepts optional sessionId", () => {
    const req: ChatRequest = {
      agentId: "agent-1",
      message: "Hi",
      sessionId: "session-abc",
    };
    expect(req.sessionId).toBe("session-abc");
  });

  it("accepts optional systemPrompt", () => {
    const req: ChatRequest = {
      agentId: "agent-1",
      message: "Test",
      systemPrompt: "Be concise",
    };
    expect(req.systemPrompt).toBe("Be concise");
  });
});

describe("ChatResponse type", () => {
  it("includes content and iterations", () => {
    const res: ChatResponse = {
      content: "Response text",
      iterations: 3,
    };
    expect(res.content).toBe("Response text");
    expect(res.iterations).toBe(3);
  });

  it("includes optional model and usage", () => {
    const res: ChatResponse = {
      content: "Full response",
      model: "claude-opus-4-6",
      usage: { input: 100, output: 50, total: 150 },
      iterations: 1,
    };
    expect(res.model).toBe("claude-opus-4-6");
    expect(res.usage?.total).toBe(150);
  });
});

describe("TokenUsage type", () => {
  it("tracks input, output, and total", () => {
    const usage: TokenUsage = { input: 200, output: 100, total: 300 };
    expect(usage.input + usage.output).toBe(usage.total);
  });

  it("handles zero usage", () => {
    const usage: TokenUsage = { input: 0, output: 0, total: 0 };
    expect(usage.total).toBe(0);
  });
});

describe("ToolCall type", () => {
  it("has callId, id, and arguments", () => {
    const tc: ToolCall = {
      callId: "call-1",
      id: "memory::store",
      arguments: { content: "data", agentId: "a1" },
    };
    expect(tc.callId).toBe("call-1");
    expect(tc.id).toBe("memory::store");
    expect(tc.arguments.content).toBe("data");
  });

  it("handles empty arguments", () => {
    const tc: ToolCall = {
      callId: "call-2",
      id: "agent::list",
      arguments: {},
    };
    expect(Object.keys(tc.arguments)).toHaveLength(0);
  });

  it("handles nested arguments", () => {
    const tc: ToolCall = {
      callId: "call-3",
      id: "tool::complex",
      arguments: {
        config: { nested: true, depth: 2 },
        items: [1, 2, 3],
      },
    };
    expect((tc.arguments.config as any).nested).toBe(true);
  });

  it("extracts capability namespace from id", () => {
    const tc: ToolCall = {
      callId: "call-4",
      id: "security::check_capability",
      arguments: {},
    };
    const namespace = tc.id.split("::")[0];
    expect(namespace).toBe("security");
  });

  it("handles id without namespace separator", () => {
    const tc: ToolCall = {
      callId: "call-5",
      id: "simple_tool",
      arguments: {},
    };
    const namespace = tc.id.split("::")[0];
    expect(namespace).toBe("simple_tool");
  });
});
