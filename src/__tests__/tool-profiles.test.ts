import { describe, it, expect } from "vitest";
import {
  TOOL_PROFILES,
  matchToolProfile,
  filterToolsByProfile,
} from "../tool-profiles.js";

describe("TOOL_PROFILES", () => {
  it("has chat profile", () => {
    expect(TOOL_PROFILES.chat).toBeDefined();
    expect(TOOL_PROFILES.chat.length).toBeGreaterThan(0);
  });

  it("has code profile", () => {
    expect(TOOL_PROFILES.code).toBeDefined();
    expect(TOOL_PROFILES.code.length).toBeGreaterThan(0);
  });

  it("has research profile", () => {
    expect(TOOL_PROFILES.research).toBeDefined();
    expect(TOOL_PROFILES.research.length).toBeGreaterThan(0);
  });

  it("has ops profile", () => {
    expect(TOOL_PROFILES.ops).toBeDefined();
    expect(TOOL_PROFILES.ops.length).toBeGreaterThan(0);
  });

  it("has data profile", () => {
    expect(TOOL_PROFILES.data).toBeDefined();
    expect(TOOL_PROFILES.data.length).toBeGreaterThan(0);
  });

  it("has full profile", () => {
    expect(TOOL_PROFILES.full).toBeDefined();
    expect(TOOL_PROFILES.full.length).toBeGreaterThan(0);
  });

  it("chat profile includes web_search", () => {
    expect(TOOL_PROFILES.chat).toContain("tool::web_search");
  });

  it("chat profile includes memory", () => {
    expect(TOOL_PROFILES.chat).toContain("memory::recall");
    expect(TOOL_PROFILES.chat).toContain("memory::store");
  });

  it("code profile includes file wildcard", () => {
    expect(TOOL_PROFILES.code.some(p => p.includes("file_*"))).toBe(true);
  });

  it("code profile includes shell_exec", () => {
    expect(TOOL_PROFILES.code).toContain("tool::shell_exec");
  });

  it("research profile includes browser wildcard", () => {
    expect(TOOL_PROFILES.research.some(p => p.includes("browser_*"))).toBe(true);
  });

  it("ops profile includes system wildcard", () => {
    expect(TOOL_PROFILES.ops.some(p => p.includes("system_*"))).toBe(true);
  });

  it("data profile includes json wildcard", () => {
    expect(TOOL_PROFILES.data.some(p => p.includes("json_*"))).toBe(true);
  });

  it("data profile includes csv wildcard", () => {
    expect(TOOL_PROFILES.data.some(p => p.includes("csv_*"))).toBe(true);
  });

  it("full profile includes tool wildcard", () => {
    expect(TOOL_PROFILES.full).toContain("tool::*");
  });

  it("full profile includes memory wildcard", () => {
    expect(TOOL_PROFILES.full).toContain("memory::*");
  });
});

describe("matchToolProfile", () => {
  it("matches exact tool id", () => {
    expect(matchToolProfile("tool::web_search", ["tool::web_search"])).toBe(true);
  });

  it("does not match different tool id", () => {
    expect(matchToolProfile("tool::web_search", ["tool::file_read"])).toBe(false);
  });

  it("matches wildcard pattern", () => {
    expect(matchToolProfile("tool::web_search", ["tool::*"])).toBe(true);
  });

  it("matches partial wildcard", () => {
    expect(matchToolProfile("tool::file_read", ["tool::file_*"])).toBe(true);
  });

  it("does not match partial wildcard for different prefix", () => {
    expect(matchToolProfile("tool::web_search", ["tool::file_*"])).toBe(false);
  });

  it("matches memory wildcard", () => {
    expect(matchToolProfile("memory::recall", ["memory::*"])).toBe(true);
  });

  it("does not match cross-namespace", () => {
    expect(matchToolProfile("tool::file_read", ["memory::*"])).toBe(false);
  });

  it("returns false for empty patterns", () => {
    expect(matchToolProfile("tool::test", [])).toBe(false);
  });

  it("matches when any pattern matches", () => {
    expect(
      matchToolProfile("tool::web_fetch", [
        "tool::file_*",
        "tool::web_*",
      ]),
    ).toBe(true);
  });

  it("handles complex wildcards", () => {
    expect(matchToolProfile("tool::code_analyze", ["tool::code_*"])).toBe(true);
  });

  it("matches exact without wildcard needed", () => {
    expect(matchToolProfile("memory::store", ["memory::store"])).toBe(true);
  });
});

describe("filterToolsByProfile", () => {
  const allTools = [
    { function_id: "tool::web_search", description: "Search" },
    { function_id: "tool::web_fetch", description: "Fetch" },
    { function_id: "tool::file_read", description: "Read files" },
    { function_id: "tool::file_write", description: "Write files" },
    { function_id: "tool::shell_exec", description: "Execute shell" },
    { function_id: "tool::code_analyze", description: "Analyze code" },
    { function_id: "tool::json_transform", description: "Transform JSON" },
    { function_id: "tool::csv_parse", description: "Parse CSV" },
    { function_id: "tool::system_info", description: "System info" },
    { function_id: "tool::browser_navigate", description: "Navigate" },
    { function_id: "memory::recall", description: "Recall" },
    { function_id: "memory::store", description: "Store" },
  ];

  it("returns all tools for full profile", () => {
    const result = filterToolsByProfile(allTools, "full");
    expect(result.length).toBe(allTools.length);
  });

  it("returns all tools for unknown profile", () => {
    const result = filterToolsByProfile(allTools, "nonexistent");
    expect(result.length).toBe(allTools.length);
  });

  it("filters chat profile correctly", () => {
    const result = filterToolsByProfile(allTools, "chat");
    expect(result.some(t => t.function_id === "tool::web_search")).toBe(true);
    expect(result.some(t => t.function_id === "tool::web_fetch")).toBe(true);
    expect(result.some(t => t.function_id === "memory::recall")).toBe(true);
    expect(result.some(t => t.function_id === "memory::store")).toBe(true);
    expect(result.some(t => t.function_id === "tool::shell_exec")).toBe(false);
  });

  it("filters code profile correctly", () => {
    const result = filterToolsByProfile(allTools, "code");
    expect(result.some(t => t.function_id === "tool::file_read")).toBe(true);
    expect(result.some(t => t.function_id === "tool::file_write")).toBe(true);
    expect(result.some(t => t.function_id === "tool::shell_exec")).toBe(true);
    expect(result.some(t => t.function_id === "tool::code_analyze")).toBe(true);
    expect(result.some(t => t.function_id === "tool::web_search")).toBe(false);
  });

  it("filters research profile correctly", () => {
    const result = filterToolsByProfile(allTools, "research");
    expect(result.some(t => t.function_id === "tool::web_search")).toBe(true);
    expect(result.some(t => t.function_id === "tool::browser_navigate")).toBe(true);
    expect(result.some(t => t.function_id === "memory::recall")).toBe(true);
  });

  it("filters ops profile correctly", () => {
    const result = filterToolsByProfile(allTools, "ops");
    expect(result.some(t => t.function_id === "tool::shell_exec")).toBe(true);
    expect(result.some(t => t.function_id === "tool::system_info")).toBe(true);
  });

  it("filters data profile correctly", () => {
    const result = filterToolsByProfile(allTools, "data");
    expect(result.some(t => t.function_id === "tool::json_transform")).toBe(true);
    expect(result.some(t => t.function_id === "tool::csv_parse")).toBe(true);
    expect(result.some(t => t.function_id === "tool::file_read")).toBe(true);
  });

  it("handles empty tools array", () => {
    const result = filterToolsByProfile([], "chat");
    expect(result).toEqual([]);
  });

  it("handles tools with id instead of function_id", () => {
    const tools = [{ id: "tool::web_search" }, { id: "memory::recall" }];
    const result = filterToolsByProfile(tools, "chat");
    expect(result.some(t => t.id === "tool::web_search")).toBe(true);
  });
});
