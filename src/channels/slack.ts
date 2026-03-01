import { init } from "iii-sdk";
import {
  splitMessage,
  resolveAgent,
  verifySlackSignature,
} from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-slack" },
);

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";

registerFunction(
  { id: "channel::slack::events", description: "Handle Slack Events API" },
  async (req) => {
    const event = req.body || req;

    if (event.type === "url_verification") {
      return { status_code: 200, body: { challenge: event.challenge } };
    }

    const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
    if (!signingSecret && event.type !== "url_verification") {
      return {
        status_code: 500,
        body: { error: "SLACK_SIGNING_SECRET not configured" },
      };
    }
    if (signingSecret && event.type !== "url_verification") {
      try {
        verifySlackSignature(req, signingSecret);
      } catch (e: any) {
        return { status_code: 401, body: { error: e.message } };
      }
    }

    if (event.event?.type === "message" && !event.event.bot_id) {
      const msg = event.event;
      const agentId = await resolveAgent(trigger, "slack", msg.channel);

      const response: any = await trigger("agent::chat", {
        agentId,
        message: msg.text,
        sessionId: `slack:${msg.channel}:${msg.thread_ts || msg.ts}`,
      });

      await sendMessage(msg.channel, response.content, msg.thread_ts || msg.ts);
    }

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::slack::events",
  config: { api_path: "webhook/slack/events", http_method: "POST" },
});

async function sendMessage(channel: string, text: string, threadTs?: string) {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text: chunk,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    });
  }
}
