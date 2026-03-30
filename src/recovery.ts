import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";
import { recordMetric } from "./shared/metrics.js";
import { safeCall } from "./shared/errors.js";

const log = createLogger("recovery");
const sdk = registerWorker(ENGINE_URL, { workerName: "recovery", otel: OTEL_CONFIG });
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

const MAX_RECOVERY_ATTEMPTS = 3;

type HealthClass = "healthy" | "degraded" | "dead" | "unrecoverable";

interface ValidationResult {
  agentId: string;
  lifecycle: string | null;
  lastActivity: number | null;
  circuitBreakerOpen: boolean;
  memoryHealthy: boolean;
}

interface ClassificationResult {
  agentId: string;
  classification: HealthClass;
  checks: ValidationResult;
}

registerFunction(
  {
    id: "recovery::scan",
    description: "List all agents and validate each in parallel",
    metadata: { category: "recovery" },
  },
  async () => {
    const agents: any[] = await safeCall(
      () => trigger({ function_id: "state::list", payload: { scope: "agents" } }),
      [],
      { operation: "list_agents_for_scan" },
    );

    const results = await Promise.all(
      agents.map(async (agent) => {
        const agentId = agent.key || agent.value?.id || agent.id;
        if (!agentId) return null;
        return safeCall(
          () =>
            trigger({
              function_id: "recovery::validate",
              payload: { agentId },
            }) as Promise<ValidationResult>,
          {
            agentId,
            lifecycle: null,
            lastActivity: null,
            circuitBreakerOpen: false,
            memoryHealthy: false,
          },
          { agentId, operation: "validate_agent" },
        );
      }),
    );

    const validResults = results.filter(Boolean);
    log.info("Recovery scan complete", { agentCount: validResults.length });
    recordMetric("recovery_scan", validResults.length, {}, "counter");

    return { scannedAt: Date.now(), agents: validResults };
  },
);

registerFunction(
  {
    id: "recovery::validate",
    description: "Check lifecycle state, activity, circuit breaker, and memory health for an agent",
    metadata: { category: "recovery" },
  },
  async (req: any) => {
    const { agentId } = req.body || req;

    if (!agentId) {
      throw Object.assign(new Error("agentId is required"), { statusCode: 400 });
    }

    const lifecycleEntry: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: `lifecycle:${agentId}`, key: "state" },
        }),
      null,
      { agentId, operation: "get_lifecycle" },
    );

    const sessions: any[] = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: `sessions:${agentId}` },
        }),
      [],
      { agentId, operation: "list_sessions" },
    );

    let lastActivity: number | null = null;
    for (const s of sessions) {
      const ts = s.value?.lastActiveAt || s.value?.createdAt || 0;
      if (typeof ts === "number" && (lastActivity === null || ts > lastActivity)) {
        lastActivity = ts;
      }
    }

    const cbEntry: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: "circuit_breakers", key: agentId },
        }),
      null,
      { agentId, operation: "get_circuit_breaker" },
    );
    const circuitBreakerOpen = cbEntry?.state === "open";

    const memEntry: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: `memory:${agentId}`, key: "_health" },
        }),
      null,
      { agentId, operation: "get_memory_health" },
    );
    const memoryHealthy = memEntry?.healthy !== false;

    const result: ValidationResult = {
      agentId,
      lifecycle: lifecycleEntry?.state || null,
      lastActivity,
      circuitBreakerOpen,
      memoryHealthy,
    };

    return result;
  },
);

registerFunction(
  {
    id: "recovery::classify",
    description: "Classify agent health as healthy, degraded, dead, or unrecoverable",
    metadata: { category: "recovery" },
  },
  async (req: any) => {
    const { agentId, checks: providedChecks } = req.body || req;

    if (!agentId) {
      throw Object.assign(new Error("agentId is required"), { statusCode: 400 });
    }

    const checks: ValidationResult = providedChecks ||
      (await trigger({
        function_id: "recovery::validate",
        payload: { agentId },
      }));

    const STALE_THRESHOLD_MS = 30 * 60 * 1000;
    const isStale =
      checks.lastActivity !== null &&
      Date.now() - checks.lastActivity > STALE_THRESHOLD_MS;
    const isTerminal =
      checks.lifecycle === "terminated" || checks.lifecycle === "done";

    let classification: HealthClass;

    if (isTerminal && checks.circuitBreakerOpen) {
      classification = "unrecoverable";
    } else if (
      checks.lifecycle === "failed" &&
      checks.circuitBreakerOpen &&
      !checks.memoryHealthy
    ) {
      classification = "unrecoverable";
    } else if (
      checks.lifecycle === "failed" ||
      (isStale && checks.circuitBreakerOpen)
    ) {
      classification = "dead";
    } else if (
      isStale ||
      checks.circuitBreakerOpen ||
      !checks.memoryHealthy ||
      checks.lifecycle === "blocked"
    ) {
      classification = "degraded";
    } else {
      classification = "healthy";
    }

    const result: ClassificationResult = { agentId, classification, checks };
    return result;
  },
);

registerFunction(
  {
    id: "recovery::recover",
    description: "Attempt recovery based on classification: wake-up, restart, or escalate",
    metadata: { category: "recovery" },
  },
  async (req: any) => {
    const { agentId } = req.body || req;

    if (!agentId) {
      throw Object.assign(new Error("agentId is required"), { statusCode: 400 });
    }

    const attemptsEntry: any = await safeCall(
      () =>
        trigger({
          function_id: "state::get",
          payload: { scope: "recovery_attempts", key: agentId },
        }),
      null,
      { agentId, operation: "get_recovery_attempts" },
    );
    const attempts = attemptsEntry?.count || 0;

    if (attempts >= MAX_RECOVERY_ATTEMPTS) {
      triggerVoid("hook::fire", {
        type: "RecoveryExhausted",
        agentId,
        attempts,
      });
      log.warn("Recovery attempts exhausted", { agentId, attempts });
      return { agentId, action: "exhausted", attempts };
    }

    await trigger({
      function_id: "state::set",
      payload: {
        scope: "recovery_attempts",
        key: agentId,
        value: { count: attempts + 1, lastAttempt: Date.now() },
      },
    });

    const classified: ClassificationResult = await trigger({
      function_id: "recovery::classify",
      payload: { agentId },
    });

    let action: string;

    if (classified.classification === "healthy") {
      action = "none";
    } else if (classified.classification === "degraded") {
      triggerVoid("tool::agent_send", {
        targetAgentId: agentId,
        message: "Health check: your session appears stale. Resuming activity.",
      });
      triggerVoid("lifecycle::transition", {
        agentId,
        newState: "working",
        reason: "Recovery wake-up",
      });
      action = "wake_up";
    } else if (classified.classification === "dead") {
      if (classified.checks.circuitBreakerOpen) {
        triggerVoid("tool::agent_send", {
          targetAgentId: agentId,
          message:
            "Circuit breaker open. Resetting and restarting.",
        });
        await safeCall(
          () =>
            trigger({
              function_id: "state::set",
              payload: {
                scope: "circuit_breakers",
                key: agentId,
                value: { state: "closed", resetAt: Date.now() },
              },
            }),
          undefined,
          { agentId, operation: "reset_circuit_breaker" },
        );
      }
      triggerVoid("lifecycle::transition", {
        agentId,
        newState: "recovering",
        reason: "Recovery restart",
      });
      action = "restart";
    } else {
      triggerVoid("hook::fire", {
        type: "RecoveryEscalation",
        agentId,
        classification: classified.classification,
        checks: classified.checks,
      });
      action = "escalate";
    }

    log.info("Recovery action taken", { agentId, action, attempt: attempts + 1 });
    recordMetric("recovery_action", 1, { action }, "counter");

    return { agentId, action, attempt: attempts + 1, classification: classified.classification };
  },
);

registerFunction(
  {
    id: "recovery::report",
    description: "Scan all agents and auto-recover unhealthy ones in parallel",
    metadata: { category: "recovery" },
  },
  async () => {
    const scanResult: any = await trigger({
      function_id: "recovery::scan",
      payload: {},
    });

    const agents: ValidationResult[] = scanResult?.agents || [];

    const [classifications, recoveries] = await Promise.all([
      Promise.all(
        agents.map((a) =>
          safeCall(
            () =>
              trigger({
                function_id: "recovery::classify",
                payload: { agentId: a.agentId, checks: a },
              }) as Promise<ClassificationResult>,
            { agentId: a.agentId, classification: "healthy" as HealthClass, checks: a },
            { agentId: a.agentId, operation: "classify" },
          ),
        ),
      ),
      Promise.all(
        agents
          .filter(
            (a) =>
              a.lifecycle === "failed" ||
              a.lifecycle === "blocked" ||
              a.circuitBreakerOpen ||
              !a.memoryHealthy,
          )
          .map((a) =>
            safeCall(
              () =>
                trigger({
                  function_id: "recovery::recover",
                  payload: { agentId: a.agentId },
                }),
              { agentId: a.agentId, action: "failed", error: "recovery failed" },
              { agentId: a.agentId, operation: "auto_recover" },
            ),
          ),
      ),
    ]);

    const summary = {
      healthy: classifications.filter((c) => c.classification === "healthy").length,
      degraded: classifications.filter((c) => c.classification === "degraded").length,
      dead: classifications.filter((c) => c.classification === "dead").length,
      unrecoverable: classifications.filter((c) => c.classification === "unrecoverable").length,
    };

    log.info("Recovery report complete", summary);
    recordMetric("recovery_report", 1, {}, "counter");

    return {
      reportedAt: Date.now(),
      totalAgents: agents.length,
      summary,
      classifications,
      recoveryActions: recoveries,
    };
  },
);

registerTrigger({
  type: "cron",
  function_id: "recovery::report",
  config: { expression: "*/10 * * * *" },
});
