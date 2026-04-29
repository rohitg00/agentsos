// @ts-nocheck
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "agent::chat") return { content: "Reply" };
  return null;
});
const mockTriggerVoid = vi.fn();

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: (req: any) =>
      req.action
        ? mockTriggerVoid(req.function_id, req.payload)
        : mockTrigger(req.function_id, req.payload),
    shutdown: vi.fn(),
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("@agentos/shared/utils", () => ({
  httpOk: (req: any, data: any) => data,
  splitMessage: vi.fn((text: string, limit: number) => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += limit)
      chunks.push(text.slice(i, i + limit));
    return chunks.length ? chunks : [text];
  }),
  resolveAgent: vi.fn(async () => "default-agent"),
}));

const mockFetch = vi.fn(async () => ({
  ok: true,
  json: async () => ({ access_token: "test-token", id: "status-1" }),
}));
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(
    async (fnId: string, data?: any): Promise<any> => {
      if (fnId === "agent::chat") return { content: "Reply" };
      return null;
    },
  );
  mockTriggerVoid.mockClear();
  mockFetch.mockClear();
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ access_token: "test-token", id: "status-1" }),
  }));
});

beforeAll(async () => {
  process.env.MASTODON_INSTANCE = "https://mastodon.social";
  process.env.MASTODON_TOKEN = "test-masto-token";
  await import("../channels/mastodon.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

describe("channel::mastodon::webhook", () => {
  it("registers the handler", () => {
    expect(handlers["channel::mastodon::webhook"]).toBeDefined();
  });

  it("ignores messages without status content", async () => {
    const result = await call("channel::mastodon::webhook", {
      body: { account: { acct: "user@masto.social" } },
    });
    expect(result.status_code).toBe(200);
  });

  it("processes valid mention", async () => {
    const result = await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "tester@masto.social" },
        status: { content: "<p>Hello Mastodon</p>", id: "111222" },
      },
    });
    expect(result.status_code).toBe(200);
  });

  it("strips HTML tags from content", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "html@masto.social" },
        status: { content: "<p>Plain <b>text</b> here</p>", id: "333" },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].message).toBe("Plain text here");
  });

  it("routes to agent::chat with mastodon session", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "session@masto.social" },
        status: { content: "<p>Session test</p>", id: "444" },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("mastodon:session@masto.social");
  });

  it("uses account.id as fallback for session", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { id: "12345" },
        status: { content: "<p>ID fallback</p>", id: "555" },
      },
    });
    const chatCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "agent::chat",
    );
    expect(chatCalls[0][1].sessionId).toBe("mastodon:12345");
  });

  it("sends reply as mastodon status", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "reply@masto.social" },
        status: { content: "<p>Reply</p>", id: "666" },
      },
    });
    const statusCalls = mockFetch.mock.calls.filter(
      (c) =>
        (c[0] as string).includes("api/v1/statuses") &&
        (c[1] as any)?.method === "POST",
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("sends reply as reply to original status", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "thread@masto.social" },
        status: { content: "<p>Thread reply</p>", id: "777" },
      },
    });
    const body = JSON.parse(
      mockFetch.mock.calls.find(
        (c) =>
          (c[1] as any)?.method === "POST" &&
          (c[0] as string).includes("statuses"),
      )?.[1]?.body as string,
    );
    expect(body.in_reply_to_id).toBe("777");
  });

  it("emits audit event", async () => {
    await call("channel::mastodon::webhook", {
      body: {
        account: { acct: "audit@masto.social" },
        status: { content: "<p>Audit</p>", id: "888" },
      },
    });
    expect(mockTriggerVoid).toHaveBeenCalledWith(
      "security::audit",
      expect.objectContaining({
        detail: expect.objectContaining({ channel: "mastodon" }),
      }),
    );
  });
});
