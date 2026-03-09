import { initSDK } from "./shared/config.js";

const { registerFunction, registerTrigger, trigger } = initSDK("cron");

registerFunction(
  {
    id: "cron::cleanup_stale_sessions",
    description: "Clean up sessions inactive for more than 24 hours",
    metadata: { category: "cron" },
  },
  async () => {
    const agents: any[] = await trigger("state::list", { scope: "agents" }).catch(() => []);
    let cleaned = 0;

    for (const agent of agents) {
      const agentId = agent.key || agent.id;
      if (!agentId) continue;

      const sessions: any[] = await trigger("state::list", {
        scope: `sessions:${agentId}`,
      }).catch(() => []);

      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const session of sessions) {
        const lastActive = session.value?.lastActiveAt || session.value?.createdAt || 0;
        if (typeof lastActive === "number" && lastActive < cutoff) {
          await trigger("state::delete", {
            scope: `sessions:${agentId}`,
            key: session.key,
          }).catch(() => {});
          cleaned++;
        }
      }
    }

    return { cleaned, checkedAt: new Date().toISOString() };
  },
);

registerFunction(
  {
    id: "cron::aggregate_daily_costs",
    description: "Aggregate and summarize daily cost data",
    metadata: { category: "cron" },
  },
  async () => {
    const today = new Date().toISOString().slice(0, 10);
    const costs: any = await trigger("state::get", {
      scope: "costs",
      key: today,
    }).catch(() => null);

    if (costs) {
      const metering: any[] = await trigger("state::list", {
        scope: "metering",
      }).catch(() => []);

      let totalTokens = 0;
      for (const entry of metering) {
        totalTokens += entry.value?.totalTokens || 0;
      }

      await trigger("state::update", {
        scope: "costs",
        key: today,
        operations: [
          { type: "set", path: "totalTokens", value: totalTokens },
          { type: "set", path: "aggregatedAt", value: new Date().toISOString() },
        ],
      }).catch(() => {});
    }

    return { date: today, aggregated: true };
  },
);

registerFunction(
  {
    id: "cron::reset_rate_limits",
    description: "Reset expired rate limit windows",
    metadata: { category: "cron" },
  },
  async () => {
    const rates: any[] = await trigger("state::list", { scope: "rates" }).catch(() => []);
    let reset = 0;

    for (const rate of rates) {
      const windowEnd = rate.value?.windowEnd || 0;
      if (typeof windowEnd === "number" && windowEnd < Date.now()) {
        await trigger("state::delete", { scope: "rates", key: rate.key }).catch(() => {});
        reset++;
      }
    }

    return { reset, checkedAt: new Date().toISOString() };
  },
);

registerTrigger({
  type: "cron",
  function_id: "cron::cleanup_stale_sessions",
  config: { schedule: "0 */6 * * *" },
});

registerTrigger({
  type: "cron",
  function_id: "cron::aggregate_daily_costs",
  config: { schedule: "0 * * * *" },
});

registerTrigger({
  type: "cron",
  function_id: "cron::reset_rate_limits",
  config: { schedule: "*/5 * * * *" },
});
