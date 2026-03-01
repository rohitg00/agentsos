export const TOOL_PROFILES: Record<string, string[]> = {
  chat: [
    "tool::web_search",
    "tool::web_fetch",
    "memory::recall",
    "memory::store",
  ],
  code: [
    "tool::file_*",
    "tool::shell_exec",
    "tool::code_*",
    "tool::apply_patch",
  ],
  research: ["tool::web_*", "tool::browser_*", "memory::*"],
  ops: [
    "tool::shell_exec",
    "tool::system_*",
    "tool::process_*",
    "tool::disk_*",
    "tool::network_*",
  ],
  data: [
    "tool::json_*",
    "tool::csv_*",
    "tool::yaml_*",
    "tool::regex_*",
    "tool::file_*",
  ],
  full: ["tool::*", "memory::*"],
};

export function matchToolProfile(
  toolId: string,
  patterns: string[],
): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes("*")) return toolId === pattern;
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, ".*") + "$",
    );
    return regex.test(toolId);
  });
}

export function filterToolsByProfile(
  tools: any[],
  profileName: string,
): any[] {
  const patterns = TOOL_PROFILES[profileName];
  if (!patterns) return tools;
  return tools.filter((t) => {
    const id = t.function_id || t.id || "";
    return matchToolProfile(id, patterns);
  });
}
