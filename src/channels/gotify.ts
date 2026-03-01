import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-gotify" },
);

const BASE_URL = process.env.GOTIFY_URL || "";
const TOKEN = process.env.GOTIFY_TOKEN || "";

registerFunction(
  { id: "channel::gotify::webhook", description: "Handle Gotify push webhook" },
  async (req) => {
    const body = req.body || req;
    const { appid, message, title, extras } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const channelKey = String(appid);
    const agentId = await resolveAgent(trigger, "gotify", channelKey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: title ? `${title}: ${message}` : message,
      sessionId: `gotify:${channelKey}`,
    });

    await sendMessage(response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "gotify", appid },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::gotify::webhook",
  config: { api_path: "webhook/gotify", http_method: "POST" },
});

async function sendMessage(text: string) {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${BASE_URL}/message?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "AgentSOS",
        message: chunk,
        priority: 5,
      }),
    });
  }
}
