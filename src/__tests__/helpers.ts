import { vi } from "vitest";

interface KvStore {
  [scope: string]: Map<string, unknown>;
}

const kvStore: KvStore = {};

function getScope(scope: string): Map<string, unknown> {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}

export function resetKv(): void {
  for (const key of Object.keys(kvStore)) {
    delete kvStore[key];
  }
}

export const mockTrigger = vi.fn(
  async (fnId: string, data?: any, _timeout?: number): Promise<any> => {
    if (fnId === "state::get") {
      const scope = getScope(data.scope);
      return scope.get(data.key) ?? null;
    }
    if (fnId === "state::set") {
      const scope = getScope(data.scope);
      scope.set(data.key, data.value);
      return { ok: true };
    }
    if (fnId === "state::delete") {
      const scope = getScope(data.scope);
      scope.delete(data.key);
      return { ok: true };
    }
    if (fnId === "state::list") {
      const scope = getScope(data.scope);
      return [...scope.entries()].map(([key, value]) => ({ key, value }));
    }
    if (fnId === "state::update") {
      const scope = getScope(data.scope);
      const current: any = scope.get(data.key) || {};
      for (const op of data.operations || []) {
        if (op.type === "increment") {
          current[op.path] = (current[op.path] || 0) + op.value;
        }
      }
      scope.set(data.key, current);
      return current;
    }
    return null;
  },
);

export const mockTriggerVoid = vi.fn((_fnId: string, _data?: any): void => {});

export const mockRegisterFunction = vi.fn(
  (_config: any, handler: Function) => handler,
);

export const mockRegisterTrigger = vi.fn((_config: any) => {});

export const mockListFunctions = vi.fn(async () => []);

export function createMockInit() {
  return {
    trigger: mockTrigger,
    triggerVoid: mockTriggerVoid,
    registerFunction: mockRegisterFunction,
    registerTrigger: mockRegisterTrigger,
    listFunctions: mockListFunctions,
  };
}

export function seedKv(scope: string, key: string, value: unknown): void {
  getScope(scope).set(key, value);
}

export function getKv(scope: string, key: string): unknown {
  return getScope(scope).get(key);
}

export function makeRequest(overrides: Partial<{
  headers: Record<string, string>;
  body: any;
}> = {}) {
  return {
    headers: overrides.headers || {},
    body: overrides.body || {},
  };
}

export function makeAuthRequest(apiKey: string, body?: any) {
  return makeRequest({
    headers: { authorization: `Bearer ${apiKey}` },
    body,
  });
}
