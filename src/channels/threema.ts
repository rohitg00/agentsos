import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-threema" },
);

const THREEMA_ID = process.env.THREEMA_ID || "";
const THREEMA_SECRET = process.env.THREEMA_SECRET || "";
const API_URL = "https://msgapi.threema.ch";

registerFunction(
  {
    id: "channel::threema::webhook",
    description: "Handle Threema Gateway webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { from, text, messageId } = body;

    if (!text || !from) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "threema", from);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `threema:${from}`,
    });

    await sendMessage(from, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "threema", from, messageId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::threema::webhook",
  config: { api_path: "webhook/threema", http_method: "POST" },
});

async function sendMessage(to: string, text: string) {
  const chunks = splitMessage(text, 3500);
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      from: THREEMA_ID,
      to,
      text: chunk,
      secret: THREEMA_SECRET,
    });
    await fetch(`${API_URL}/send_simple`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  }
}
