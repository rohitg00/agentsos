import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";
import { createRecordMetric } from "./shared/metrics.js";
import { requireAuth } from "./shared/utils.js";
import { safeCall } from "./shared/errors.js";
import type { FeedbackPolicy, ReviewResult } from "./types.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "feedback" },
);

const log = createLogger("feedback");
const recordMetric = createRecordMetric(triggerVoid);

const MAX_IMPROVE_DEPTH = 3;

const DEFAULT_POLICY: FeedbackPolicy = {
  minScoreToKeep: 0.5,
  minEvalsToPromote: 5,
  maxFailuresToKill: 3,
  autoReviewIntervalMs: 6 * 60 * 60 * 1000,
};

type Decision = "keep" | "improve" | "kill";

function generateId(): string {
  return `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function numOrDefault<K extends keyof FeedbackPolicy>(
  stored: any,
  key: K,
): FeedbackPolicy[K] {
  return typeof stored?.[key] === "number" ? stored[key] : DEFAULT_POLICY[key];
}

async function getPolicy(): Promise<FeedbackPolicy> {
  const stored: any = await safeCall(
    () =>
      trigger("state::get", { scope: "feedback_policy", key: "default" }),
    null,
    { operation: "get_policy" },
  );
  if (!stored) return { ...DEFAULT_POLICY };
  return {
    minScoreToKeep: numOrDefault(stored, "minScoreToKeep"),
    minEvalsToPromote: numOrDefault(stored, "minEvalsToPromote"),
    maxFailuresToKill: numOrDefault(stored, "maxFailuresToKill"),
    autoReviewIntervalMs: numOrDefault(stored, "autoReviewIntervalMs"),
  };
}

async function getRecentEvals(
  functionId: string,
  limit: number,
): Promise<any[]> {
  const all: any[] = await safeCall(
    () => trigger("state::list", { scope: "eval_results" }),
    [],
    { operation: "recent_evals" },
  );

  return (Array.isArray(all) ? all : [])
    .map((e: any) => e.value || e)
    .filter((r: any) => r.functionId === functionId)
    .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);
}

registerFunction(
  {
    id: "feedback::review",
    description: "Analyze evals and decide keep/improve/kill",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const policy = await getPolicy();
    const recent = await getRecentEvals(functionId, 5);

    if (recent.length === 0) {
      const result: ReviewResult = {
        decisionId: generateId(),
        functionId,
        decision: "keep",
        reason: "No eval data yet",
        avgOverall: 0,
        recentFailures: 0,
        evalCount: 0,
        timestamp: Date.now(),
      };
      await trigger("state::set", {
        scope: "feedback_decisions",
        key: `${functionId}:${result.decisionId}`,
        value: result,
      });
      return result;
    }

    const recentFailures = recent.filter(
      (r: any) =>
        r.scores?.correctness !== null && r.scores?.correctness < 0.5,
    ).length;

    const avgOverall =
      recent.reduce((s: number, r: any) => s + (r.scores?.overall || 0), 0) /
      recent.length;

    let decision: Decision;
    let reason: string;

    if (recentFailures >= policy.maxFailuresToKill) {
      decision = "kill";
      reason = `${recentFailures} failures in last ${recent.length} evals (threshold: ${policy.maxFailuresToKill})`;
    } else if (avgOverall < policy.minScoreToKeep) {
      decision = "improve";
      reason = `Average overall score ${avgOverall.toFixed(3)} below threshold ${policy.minScoreToKeep}`;
    } else {
      decision = "keep";
      reason = `Passing: avg overall ${avgOverall.toFixed(3)}, ${recentFailures} failures`;
    }

    const result: ReviewResult = {
      decisionId: generateId(),
      functionId,
      decision,
      reason,
      avgOverall,
      recentFailures,
      evalCount: recent.length,
      timestamp: Date.now(),
    };

    await trigger("state::set", {
      scope: "feedback_decisions",
      key: `${functionId}:${result.decisionId}`,
      value: result,
    });

    if (decision === "kill") {
      const fn: any = await safeCall(
        () =>
          trigger("state::get", {
            scope: "evolved_functions",
            key: functionId,
          }),
        null,
        { operation: "auto_kill_get" },
      );
      if (fn) {
        fn.status = "killed";
        fn.updatedAt = Date.now();
        await trigger("state::set", {
          scope: "evolved_functions",
          key: functionId,
          value: fn,
        });
      }
      log.warn("Auto-killed function", { functionId, reason });
    } else if (decision === "improve") {
      triggerVoid("feedback::improve", {
        headers: { authorization: "Bearer internal" },
        body: { functionId, depth: 0 },
        functionId,
        depth: 0,
      });
      log.info("Triggered improvement", { functionId, reason });
    }

    recordMetric(
      "feedback_review",
      1,
      { functionId, decision },
      "counter",
    );

    return result;
  },
);

registerFunction(
  {
    id: "feedback::improve",
    description:
      "Call evolve::generate with eval feedback, re-eval. Auto-recurses up to 3x.",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId, depth: rawDepth, suiteId } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const depth = typeof rawDepth === "number" ? rawDepth : 0;
    if (depth >= MAX_IMPROVE_DEPTH) {
      log.warn("Max improve depth reached", { functionId, depth });
      return {
        improved: false,
        reason: `Max improvement depth ${MAX_IMPROVE_DEPTH} reached`,
        depth,
      };
    }

    const fn: any = await trigger("state::get", {
      scope: "evolved_functions",
      key: functionId,
    });
    if (!fn) {
      throw Object.assign(new Error("Function not found"), {
        statusCode: 404,
      });
    }

    const recentEvals = await getRecentEvals(functionId, 5);
    const failureDescriptions = recentEvals
      .filter(
        (r: any) =>
          r.scores?.correctness !== null && r.scores?.correctness < 0.5,
      )
      .map(
        (r: any) =>
          `Input: ${JSON.stringify(r.input)?.slice(0, 200)}, Expected: ${JSON.stringify(r.expected)?.slice(0, 200)}, Got: ${JSON.stringify(r.output)?.slice(0, 200)}`,
      )
      .slice(0, 3);

    const feedbackSpec = `Previous version failed on these cases:\n${failureDescriptions.join("\n")}\n\nPrevious code:\n${fn.code}\n\nFix the issues and improve correctness.`;

    const nameParts = fn.functionId.match(/^evolved::(.+)_v\d+$/);
    const baseName = nameParts ? nameParts[1] : fn.functionId.replace("evolved::", "");

    const newFn: any = await trigger("evolve::generate", {
      headers: { authorization: "Bearer internal" },
      body: {
        goal: fn.description,
        spec: feedbackSpec,
        name: baseName,
        agentId: fn.authorAgentId,
        metadata: { ...fn.metadata, improvedFrom: functionId, depth: depth + 1 },
      },
      goal: fn.description,
      spec: feedbackSpec,
      name: baseName,
      agentId: fn.authorAgentId,
      metadata: { ...fn.metadata, improvedFrom: functionId, depth: depth + 1 },
    });

    if (!newFn?.functionId) {
      return { improved: false, reason: "Generation failed", depth };
    }

    await trigger("evolve::register", {
      headers: { authorization: "Bearer internal" },
      body: { functionId: newFn.functionId },
      functionId: newFn.functionId,
    });

    let newScore = 0;
    if (suiteId) {
      const suiteResult: any = await safeCall(
        () =>
          trigger("eval::suite", {
            headers: { authorization: "Bearer internal" },
            body: { suiteId },
            suiteId,
          }),
        null,
        { operation: "improve_eval" },
      );
      newScore = suiteResult?.aggregate?.correctness ?? 0;
    }

    const policy = await getPolicy();
    if (suiteId && newScore < policy.minScoreToKeep && depth + 1 < MAX_IMPROVE_DEPTH) {
      log.info("Recursing improvement", {
        functionId: newFn.functionId,
        depth: depth + 1,
        score: newScore,
      });
      return trigger("feedback::improve", {
        headers: { authorization: "Bearer internal" },
        body: {
          functionId: newFn.functionId,
          depth: depth + 1,
          suiteId,
        },
        functionId: newFn.functionId,
        depth: depth + 1,
        suiteId,
      });
    }

    recordMetric("feedback_improve", 1, { functionId, depth: String(depth) }, "counter");

    return {
      improved: true,
      newFunctionId: newFn.functionId,
      depth: depth + 1,
      score: newScore,
    };
  },
);

registerFunction(
  {
    id: "feedback::promote",
    description: "draft->staging or staging->production",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const fn: any = await trigger("state::get", {
      scope: "evolved_functions",
      key: functionId,
    });
    if (!fn) {
      throw Object.assign(new Error("Function not found"), {
        statusCode: 404,
      });
    }

    if (fn.status === "killed" || fn.status === "deprecated") {
      throw Object.assign(
        new Error(`Cannot promote from ${fn.status}`),
        { statusCode: 400 },
      );
    }

    const policy = await getPolicy();
    const recentEvals = await getRecentEvals(functionId, 10);

    if (recentEvals.length < policy.minEvalsToPromote) {
      return {
        promoted: false,
        reason: `Need ${policy.minEvalsToPromote} evals, have ${recentEvals.length}`,
      };
    }

    const avgOverall =
      recentEvals.reduce(
        (s: number, r: any) => s + (r.scores?.overall || 0),
        0,
      ) / recentEvals.length;

    if (avgOverall < policy.minScoreToKeep) {
      return {
        promoted: false,
        reason: `Average score ${avgOverall.toFixed(3)} below threshold ${policy.minScoreToKeep}`,
      };
    }

    if (fn.status === "draft") {
      fn.status = "staging";
    } else if (fn.status === "staging") {
      const minSafety = Math.min(
        ...recentEvals.map((r: any) => r.scores?.safety ?? 1),
      );
      if (minSafety < 0.8) {
        return {
          promoted: false,
          reason: `Safety score ${minSafety.toFixed(3)} below 0.8 threshold for production`,
        };
      }
      fn.status = "production";
    } else if (fn.status === "production") {
      return { promoted: false, reason: "Already in production" };
    }

    fn.updatedAt = Date.now();
    await trigger("state::set", {
      scope: "evolved_functions",
      key: functionId,
      value: fn,
    });

    log.info("Promoted function", { functionId, status: fn.status });
    recordMetric("feedback_promote", 1, { functionId, status: fn.status }, "counter");

    return { promoted: true, functionId, newStatus: fn.status };
  },
);

registerFunction(
  {
    id: "feedback::demote",
    description: "Downgrade or kill",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { functionId, kill } = req.body || req;
    if (!functionId) {
      throw Object.assign(new Error("functionId is required"), {
        statusCode: 400,
      });
    }

    const fn: any = await trigger("state::get", {
      scope: "evolved_functions",
      key: functionId,
    });
    if (!fn) {
      throw Object.assign(new Error("Function not found"), {
        statusCode: 404,
      });
    }

    if (kill) {
      fn.status = "killed";
    } else if (fn.status === "production") {
      fn.status = "staging";
    } else if (fn.status === "staging") {
      fn.status = "draft";
    } else {
      fn.status = "deprecated";
    }

    fn.updatedAt = Date.now();
    await trigger("state::set", {
      scope: "evolved_functions",
      key: functionId,
      value: fn,
    });

    log.info("Demoted function", { functionId, status: fn.status });
    return { demoted: true, functionId, newStatus: fn.status };
  },
);

registerFunction(
  {
    id: "feedback::leaderboard",
    description: "Rank evolved functions by score",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const { status, limit: rawLimit } = req.query || req.body || req;

    const all: any[] = await safeCall(
      () => trigger("state::list", { scope: "evolved_functions" }),
      [],
      { operation: "leaderboard" },
    );

    let functions = (Array.isArray(all) ? all : [])
      .map((e: any) => e.value || e)
      .filter((f: any) => f.status !== "killed");

    if (status) {
      functions = functions.filter((f: any) => f.status === status);
    }

    functions.sort(
      (a: any, b: any) =>
        (b.evalScores?.overall || 0) - (a.evalScores?.overall || 0),
    );

    const limit = Math.min(Number(rawLimit) || 50, 100);
    return functions.slice(0, limit).map((f: any, i: number) => ({
      rank: i + 1,
      functionId: f.functionId,
      description: f.description,
      status: f.status,
      version: f.version,
      overall: f.evalScores?.overall ?? null,
      correctness: f.evalScores?.correctness ?? null,
      safety: f.evalScores?.safety ?? null,
      authorAgentId: f.authorAgentId,
    }));
  },
);

registerFunction(
  {
    id: "feedback::policy",
    description: "Get/set threshold policy",
    metadata: { category: "feedback" },
  },
  async (req: any) => {
    requireAuth(req);
    const body = req.body || req;

    const policyKeys: (keyof FeedbackPolicy)[] = [
      "minScoreToKeep",
      "minEvalsToPromote",
      "maxFailuresToKill",
      "autoReviewIntervalMs",
    ];
    const hasUpdate = policyKeys.some((k) => body[k] !== undefined);

    if (!hasUpdate) return getPolicy();

    const current = await getPolicy();
    const updated: FeedbackPolicy = { ...current };
    for (const k of policyKeys) {
      if (typeof body[k] === "number") {
        (updated as any)[k] = body[k];
      }
    }
    await trigger("state::set", {
      scope: "feedback_policy",
      key: "default",
      value: updated,
    });
    log.info("Updated feedback policy", updated as any);
    return updated;
  },
);

registerFunction(
  {
    id: "feedback::auto_review",
    description: "Auto-review all staging+production functions",
    metadata: { category: "feedback", cron: true },
  },
  async () => {
    const all: any[] = await safeCall(
      () => trigger("state::list", { scope: "evolved_functions" }),
      [],
      { operation: "auto_review" },
    );

    const reviewable = (Array.isArray(all) ? all : [])
      .map((e: any) => e.value || e)
      .filter(
        (f: any) => f.status === "staging" || f.status === "production",
      );

    const results: ReviewResult[] = [];
    for (const fn of reviewable) {
      const result: any = await safeCall(
        () =>
          trigger("feedback::review", {
            headers: { authorization: "Bearer internal" },
            body: { functionId: fn.functionId },
            functionId: fn.functionId,
          }),
        null,
        { operation: "auto_review_single", functionId: fn.functionId },
      );
      if (result) results.push(result);
    }

    log.info(`Auto-review completed: ${results.length} functions reviewed`);
    recordMetric("feedback_auto_review", results.length, {}, "counter");

    return { reviewed: results.length, results };
  },
);

registerTrigger({
  type: "http",
  function_id: "feedback::review",
  config: { api_path: "api/feedback/review", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::improve",
  config: { api_path: "api/feedback/improve", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::promote",
  config: { api_path: "api/feedback/promote", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::demote",
  config: { api_path: "api/feedback/demote", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::leaderboard",
  config: { api_path: "api/feedback/leaderboard", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "feedback::policy",
  config: { api_path: "api/feedback/policy", http_method: "POST" },
});
registerTrigger({
  type: "cron",
  function_id: "feedback::auto_review",
  config: { interval: "6h" },
});
