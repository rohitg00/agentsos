import { init } from "iii-sdk";
import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  ToolCall,
} from "./types.js";
import { filterToolsByProfile } from "./tool-profiles.js";
import { safeCall } from "./shared/errors.js";
import { shutdownManager } from "./shared/shutdown.js";
import { createLogger } from "./shared/logger.js";

const log = createLogger("agent-core");

const {
  registerFunction,
  registerTrigger,
  trigger,
  triggerVoid,
  listFunctions,
} = init("ws://localhost:49134", { workerName: "agent-core" });

const MAX_ITERATIONS = 50;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_CHAT_TIMEOUT_MS = 300_000;
const CONTEXT_HEALTH_CHECK_INTERVAL = 10;
const CONTEXT_HEALTH_THRESHOLD = 60;

function earlyResponse(content: string): ChatResponse {
  return { content, model: undefined, usage: undefined, iterations: 0 };
}

shutdownManager.initShutdown();

function recordMetric(
  name: string,
  value: number,
  labels: Record<string, string>,
  type: "counter" | "histogram" | "gauge" = "counter",
) {
  triggerVoid("telemetry::record", { name, value, labels, type });
}

registerFunction(
  {
    id: "agent::chat",
    description: "Process a message through the agent loop",
    metadata: { category: "agent" },
  },
  async (input: ChatRequest): Promise<ChatResponse> => {
    if (shutdownManager.isShuttingDown()) {
      return earlyResponse("Service is shutting down. Please retry later.");
    }

    const { agentId, message, sessionId, systemPrompt } = input;

    const agentRate: any = await safeCall(
      () => trigger("rate::check_agent", { agentId, operation: "message" }),
      { allowed: false, retryAfter: 60 },
      { agentId, operation: "rate_check_agent" },
    );
    if (!agentRate.allowed) {
      return earlyResponse(
        `Rate limit exceeded for agent ${agentId}. Retry after ${agentRate.retryAfter}s.`,
      );
    }

    const concSlot: any = await safeCall(
      () => trigger("rate::acquire_concurrent", { agentId }),
      { acquired: false, current: 0, limit: 0 },
      { agentId, operation: "acquire_concurrent" },
    );
    if (!concSlot.acquired) {
      return earlyResponse(
        `Agent ${agentId} has too many concurrent requests (${concSlot.current}/${concSlot.limit}).`,
      );
    }

    const operationId = `chat:${agentId}:${Date.now()}`;
    shutdownManager.register(operationId);

    let chatTimeoutId: ReturnType<typeof setTimeout>;
    const chatTimeout = new Promise<never>((_, reject) => {
      chatTimeoutId = setTimeout(
        () => reject(new Error("Chat timeout exceeded")),
        MAX_CHAT_TIMEOUT_MS,
      );
    });

    const chatStart = Date.now();
    recordMetric("active_sessions", 1, { agentId }, "gauge");
    log.info("Chat started", { agentId, sessionId });

    try {
      return await Promise.race([
        (async (): Promise<ChatResponse> => {
          const config: AgentConfig = await trigger("state::get", {
            scope: "agents",
            key: agentId,
          });

          const memories: any = await trigger("memory::recall", {
            agentId,
            query: message,
            limit: 20,
          });

          const tools: any = await trigger("agent::list_tools", { agentId });
          const allowedToolIds = new Set(
            tools.map((t: any) => t.function_id || t.id),
          );

          const model = await trigger("llm::route", {
            message,
            toolCount: tools.length,
            config: config?.model,
          });

          const messages: any[] = [
            ...(memories || []),
            { role: "user", content: message },
          ];

          const injectionScan: any = await safeCall(
            () => trigger("security::scan_injection", { text: message }),
            { riskScore: 1.0, safe: false },
            { agentId, operation: "scan_injection" },
          );
          if (injectionScan.riskScore > 0.5) {
            return earlyResponse(
              "Message rejected: potential injection detected.",
            );
          }

          const budgetStatus: any = await safeCall(
            () => trigger("cost::budget_check", { agentId }),
            { withinBudget: false, spent: 0, limit: 0 },
            { agentId, operation: "budget_check" },
          );
          if (!budgetStatus.withinBudget) {
            log.warn("Agent over budget", {
              agentId,
              spent: budgetStatus.spent,
              limit: budgetStatus.limit,
            });
            return earlyResponse(
              `Agent ${agentId} has exceeded its budget (spent: $${budgetStatus.spent}, limit: $${budgetStatus.limit}). Please contact an administrator.`,
            );
          }

          const replaySessionId = sessionId || `default:${agentId}`;

          const llmStart0 = Date.now();
          let response: any = await trigger("llm::complete", {
            model,
            systemPrompt: systemPrompt || config?.systemPrompt,
            messages,
            tools,
          });

          triggerVoid("replay::record", {
            sessionId: replaySessionId,
            agentId,
            action: "llm_call",
            data: { model: response.model, usage: response.usage },
            durationMs: Date.now() - llmStart0,
            iteration: 0,
          });

          if (response.usage) {
            triggerVoid("cost::track", {
              agentId,
              sessionId: replaySessionId,
              model: response.model || (model as any).model,
              inputTokens: response.usage.input || 0,
              outputTokens: response.usage.output || 0,
              cacheReadTokens: response.usage.cacheRead || 0,
              cacheWriteTokens: response.usage.cacheWrite || 0,
            });
          }

          if (config?.codeAgentMode && response.content) {
            const detectResult: any = await safeCall(
              () =>
                trigger("agent::code_detect", { response: response.content }),
              { hasCode: false, blocks: [] },
              { agentId, operation: "code_detect" },
            );

            if (detectResult.hasCode) {
              for (const block of detectResult.blocks) {
                const codeStart = Date.now();
                const execResult: any = await trigger("agent::code_execute", {
                  code: block,
                  agentId,
                  timeout: 5000,
                }).catch((err: any) => ({
                  result: { error: err?.message },
                  stdout: "",
                  executionTimeMs: 0,
                }));

                triggerVoid("replay::record", {
                  sessionId: replaySessionId,
                  agentId,
                  action: "tool_call",
                  data: {
                    toolId: "code_execute",
                    code: block.slice(0, 500),
                    result: execResult.result,
                  },
                  durationMs: Date.now() - codeStart,
                  iteration: 0,
                });

                messages.push({ role: "assistant", content: response.content });
                messages.push({
                  role: "user",
                  content: `Code execution result:\n${execResult.stdout ? `stdout: ${execResult.stdout}\n` : ""}result: ${JSON.stringify(execResult.result)}`,
                });

                const llmRetry = Date.now();
                response = await trigger("llm::complete", {
                  model,
                  systemPrompt: systemPrompt || config?.systemPrompt,
                  messages,
                  tools,
                });
                triggerVoid("replay::record", {
                  sessionId: replaySessionId,
                  agentId,
                  action: "llm_call",
                  data: {
                    model: response.model,
                    usage: response.usage,
                    afterCodeExec: true,
                  },
                  durationMs: Date.now() - llmRetry,
                  iteration: 0,
                });
              }
            }
          }

          let iterations = 0;
          while (response.toolCalls?.length && iterations < MAX_ITERATIONS) {
            iterations++;

            await triggerVoid("publish", {
              topic: "audit",
              data: {
                type: "tool_execution",
                agentId,
                tools: response.toolCalls.map((tc: ToolCall) => tc.id),
                iteration: iterations,
              },
            });

            const toolResults: { toolCallId: string; output: unknown }[] = [];
            for (const tc of response.toolCalls as ToolCall[]) {
              if (!allowedToolIds.has(tc.id)) {
                toolResults.push({
                  toolCallId: tc.callId,
                  output: {
                    error: `Tool ${tc.id} is not in the allowed tool list`,
                  },
                });
                continue;
              }

              const toolStart = Date.now();
              try {
                const guardResult: any = await safeCall(
                  () => trigger("guard::check", { agentId, toolId: tc.id }),
                  { decision: "block" },
                  { agentId, operation: "guard_check" },
                );
                if (
                  guardResult.decision === "block" ||
                  guardResult.decision === "circuit_break"
                ) {
                  toolResults.push({
                    toolCallId: tc.callId,
                    output: { error: `Tool ${tc.id} blocked by guard` },
                  });
                  continue;
                }

                triggerVoid("hook::fire", {
                  type: "BeforeToolCall",
                  agentId,
                  toolId: tc.id,
                  args: tc.arguments,
                });

                const tierResult: any = await safeCall(
                  () =>
                    trigger("approval::decide_tier", {
                      toolId: tc.id,
                      agentId,
                      args: tc.arguments,
                    }),
                  {
                    approved: false,
                    tier: "sync",
                    reason: "approval service unavailable",
                  },
                  { agentId, operation: "approval_tier" },
                );
                if (!tierResult.approved) {
                  if (
                    tierResult.tier === "async" &&
                    tierResult.status === "pending"
                  ) {
                    toolResults.push({
                      toolCallId: tc.callId,
                      output: {
                        error: `Tool ${tc.id} is awaiting approval (tier: ${tierResult.tier}, approvalId: ${tierResult.approvalId})`,
                      },
                    });
                  } else {
                    toolResults.push({
                      toolCallId: tc.callId,
                      output: {
                        error: `Tool ${tc.id} requires approval: ${tierResult.reason || "not approved"} (tier: ${tierResult.tier})`,
                      },
                    });
                  }
                  continue;
                }

                const policyResult: any = await safeCall(
                  () =>
                    trigger("policy::check", {
                      agentId,
                      resource: tc.id,
                    }),
                  { action: "deny" },
                  { agentId, operation: "policy_check" },
                );
                if (policyResult.action === "approve") {
                  const approval: any = await safeCall(
                    () =>
                      trigger("approval::check", {
                        agentId,
                        toolId: tc.id,
                        arguments: tc.arguments,
                      }),
                    { approved: false, reason: "Approval timeout" },
                    { agentId, operation: "approval_check" },
                  );
                  if (!approval.approved) {
                    toolResults.push({
                      toolCallId: tc.callId,
                      output: {
                        error: `Tool ${tc.id} requires approval: ${approval.reason || "not approved"}`,
                      },
                    });
                    continue;
                  }
                }

                await trigger("security::check_capability", {
                  agentId,
                  capability: tc.id.split("::")[0],
                  resource: tc.id,
                });

                const result = await trigger(
                  tc.id,
                  tc.arguments,
                  TOOL_TIMEOUT_MS,
                );

                triggerVoid("hook::fire", {
                  type: "AfterToolCall",
                  agentId,
                  toolId: tc.id,
                  result,
                });

                toolResults.push({ toolCallId: tc.callId, output: result });
                triggerVoid("replay::record", {
                  sessionId: replaySessionId,
                  agentId,
                  action: "tool_call",
                  data: { toolId: tc.id, args: tc.arguments },
                  durationMs: Date.now() - toolStart,
                  iteration: iterations,
                });
                triggerVoid("replay::record", {
                  sessionId: replaySessionId,
                  agentId,
                  action: "tool_result",
                  data: { toolId: tc.id, output: result },
                  durationMs: 0,
                  iteration: iterations,
                });
                recordMetric("tool_execution_total", 1, {
                  toolId: tc.id,
                  status: "success",
                });
                recordMetric(
                  "function_call_duration_ms",
                  Date.now() - toolStart,
                  { functionId: tc.id, status: "success" },
                  "histogram",
                );
              } catch (err: any) {
                toolResults.push({
                  toolCallId: tc.callId,
                  output: { error: err?.message || String(err) },
                });
                const errType = err?.code || err?.name || "unknown";
                recordMetric("tool_execution_total", 1, {
                  toolId: tc.id,
                  status: "failure",
                });
                recordMetric("function_error_total", 1, {
                  functionId: tc.id,
                  errorType: errType,
                });
                recordMetric(
                  "function_call_duration_ms",
                  Date.now() - toolStart,
                  { functionId: tc.id, status: "error" },
                  "histogram",
                );
                log.warn("Tool execution failed", {
                  agentId,
                  functionId: tc.id,
                  duration: Date.now() - toolStart,
                });
              }
            }

            messages.push({
              role: "assistant",
              content: null,
              tool_calls: response.toolCalls,
            });
            for (const tr of toolResults) {
              messages.push({
                role: "tool",
                tool_call_id: tr.toolCallId,
                content: JSON.stringify(tr.output),
              });
            }

            if (iterations % CONTEXT_HEALTH_CHECK_INTERVAL === 0) {
              const health: any = await safeCall(
                () =>
                  trigger("context::health", {
                    messages,
                    maxTokens: (model as any).maxTokens
                      ? (model as any).maxTokens * 50
                      : 200_000,
                  }),
                { overall: 100 },
                { agentId, operation: "context_health" },
              );

              log.info("Context health check", {
                agentId,
                iteration: iterations,
                healthScore: health.overall,
              });

              if (health.overall < CONTEXT_HEALTH_THRESHOLD) {
                const compressed: any = await safeCall(
                  () =>
                    trigger("context::compress", {
                      messages,
                      targetTokens: Math.floor(
                        ((model as any).maxTokens
                          ? (model as any).maxTokens * 50
                          : 200_000) * 0.7,
                      ),
                    }),
                  null,
                  { agentId, operation: "context_compress" },
                );

                if (compressed?.compressed) {
                  messages.length = 0;
                  messages.push(...compressed.compressed);
                  log.info("Context auto-compressed", {
                    agentId,
                    removedCount: compressed.removedCount,
                    savedTokens: compressed.savedTokens,
                  });
                }
              }
            }

            const llmLoopStart = Date.now();
            response = (await trigger("llm::complete", {
              model,
              systemPrompt: systemPrompt || config?.systemPrompt,
              messages,
              tools,
            })) as any;

            triggerVoid("replay::record", {
              sessionId: replaySessionId,
              agentId,
              action: "llm_call",
              data: { model: response.model, usage: response.usage },
              durationMs: Date.now() - llmLoopStart,
              iteration: iterations,
            });

            if (response.usage) {
              triggerVoid("cost::track", {
                agentId,
                sessionId: replaySessionId,
                model: response.model || (model as any).model,
                inputTokens: response.usage.input || 0,
                outputTokens: response.usage.output || 0,
                cacheReadTokens: response.usage.cacheRead || 0,
                cacheWriteTokens: response.usage.cacheWrite || 0,
              });
            }
          }

          triggerVoid("hook::fire", {
            type: "AgentLoopEnd",
            agentId,
            iterations,
          });
          triggerVoid("guard::reset", { agentId });

          triggerVoid("memory::store", {
            agentId,
            sessionId: replaySessionId,
            role: "user",
            content: message,
          });
          triggerVoid("memory::store", {
            agentId,
            sessionId: replaySessionId,
            role: "assistant",
            content: response.content,
            tokenUsage: response.usage,
          });

          triggerVoid("state::update", {
            scope: "metering",
            key: agentId,
            operations: [
              {
                type: "increment",
                path: "totalTokens",
                value: response.usage?.total || 0,
              },
              { type: "increment", path: "invocations", value: 1 },
            ],
          });

          const hourKey = new Date().toISOString().slice(0, 13);
          triggerVoid("state::update", {
            scope: "metering_hourly",
            key: `${agentId}:${hourKey}`,
            operations: [
              {
                type: "increment",
                path: "tokens",
                value: response.usage?.total || 0,
              },
              { type: "increment", path: "invocations", value: 1 },
            ],
          });

          const chatDuration = Date.now() - chatStart;
          const resolvedModel = response.model || "unknown";
          if (response.usage) {
            recordMetric("tokens_used_total", response.usage.input || 0, {
              model: resolvedModel,
              agent: agentId,
              type: "input",
            });
            recordMetric("tokens_used_total", response.usage.output || 0, {
              model: resolvedModel,
              agent: agentId,
              type: "output",
            });
          }
          recordMetric(
            "function_call_duration_ms",
            chatDuration,
            { functionId: "agent::chat", status: "success" },
            "histogram",
          );
          log.info("Chat completed", {
            agentId,
            sessionId,
            duration: chatDuration,
            iterations,
          });

          return {
            content: response.content,
            model: response.model,
            usage: response.usage,
            iterations,
          };
        })(),
        chatTimeout,
      ]);
    } catch (err: any) {
      const chatDuration = Date.now() - chatStart;
      recordMetric(
        "function_call_duration_ms",
        chatDuration,
        { functionId: "agent::chat", status: "error" },
        "histogram",
      );
      recordMetric("function_error_total", 1, {
        functionId: "agent::chat",
        errorType: err?.code || err?.name || "unknown",
      });
      log.error("Chat failed", { agentId, sessionId, duration: chatDuration });
      throw err;
    } finally {
      clearTimeout(chatTimeoutId!);
      recordMetric("active_sessions", 0, { agentId }, "gauge");
      shutdownManager.complete(operationId);
      triggerVoid("rate::release_concurrent", { agentId });
    }
  },
);

registerFunction(
  {
    id: "agent::list_tools",
    description: "List tools available to an agent",
    metadata: { category: "agent" },
  },
  async ({ agentId }: { agentId: string }) => {
    const config: AgentConfig = await trigger("state::get", {
      scope: "agents",
      key: agentId,
    });

    const allowedCapabilities = config?.capabilities?.tools || ["*"];
    const allFunctions = await listFunctions();

    const filtered = allowedCapabilities.includes("*")
      ? allFunctions
      : allFunctions.filter((fn) =>
          allowedCapabilities.some((cap: string) =>
            fn.function_id.startsWith(cap),
          ),
        );

    return filterToolsByProfile(filtered, config?.toolProfile || "full");
  },
);

registerFunction(
  {
    id: "agent::create",
    description: "Register a new agent",
    metadata: { category: "agent" },
  },
  async (config: AgentConfig) => {
    const agentId = config.id || crypto.randomUUID();
    await trigger("state::set", {
      scope: "agents",
      key: agentId,
      value: { ...config, id: agentId, createdAt: Date.now() },
    });
    triggerVoid("publish", {
      topic: "agent.lifecycle",
      data: { type: "created", agentId },
    });
    triggerVoid("a2a::generate_card", { agentId });
    return { agentId };
  },
);

registerFunction(
  {
    id: "agent::list",
    description: "List all agents",
    metadata: { category: "agent" },
  },
  async () => {
    return trigger("state::list", { scope: "agents" });
  },
);

registerFunction(
  {
    id: "agent::delete",
    description: "Remove an agent",
    metadata: { category: "agent" },
  },
  async ({ agentId }: { agentId: string }) => {
    await trigger("state::delete", { scope: "agents", key: agentId });
    triggerVoid("publish", {
      topic: "agent.lifecycle",
      data: { type: "deleted", agentId },
    });
    return { deleted: true };
  },
);

registerTrigger({
  type: "queue",
  function_id: "agent::chat",
  config: { topic: "agent.inbox" },
});
