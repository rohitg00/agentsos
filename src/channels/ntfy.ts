import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-ntfy" },
);

const TOPIC = process.env.NTFY_TOPIC || "";
const TOKEN = process.env.NTFY_TOKEN || "";
const BASE_URL = process.env.NTFY_URL || "https://ntfy.sh";

registerFunction(
  { id: "channel::ntfy::webhook", description: "Handle ntfy.sh push webhook" },
  async (req) => {
    const body = req.body || req;
    const { topic, message, title, id: msgId } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "ntfy", topic);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: title ? `${title}: ${message}` : message,
      sessionId: `ntfy:${topic}`,
    });

    await sendMessage(response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "ntfy", topic, msgId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::ntfy::webhook",
  config: { api_path: "webhook/ntfy", http_method: "POST" },
});

async function sendMessage(text: string) {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${BASE_URL}/${TOPIC}`, {
      method: "POST",
      headers: {
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        Title: "AgentSOS",
      },
      body: chunk,
    });
  }
}
