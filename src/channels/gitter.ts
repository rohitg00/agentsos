import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-gitter" },
);

const TOKEN = process.env.GITTER_TOKEN || "";
const API_URL = "https://api.gitter.im/v1";

registerFunction(
  { id: "channel::gitter::webhook", description: "Handle Gitter webhook" },
  async (req) => {
    const body = req.body || req;
    const { model } = body;

    if (!model?.text) return { status_code: 200, body: { ok: true } };

    const roomId = model.roomId || body.roomId;
    const text = model.text;
    const userId = model.fromUser?.id;

    const agentId = await resolveAgent(trigger, "gitter", roomId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `gitter:${roomId}`,
    });

    await sendMessage(roomId, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "gitter", roomId, userId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::gitter::webhook",
  config: { api_path: "webhook/gitter", http_method: "POST" },
});

async function sendMessage(roomId: string, text: string) {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${API_URL}/rooms/${roomId}/chatMessages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: chunk }),
    });
  }
}
