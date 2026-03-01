import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-zulip" },
);

const EMAIL = process.env.ZULIP_EMAIL || "";
const API_KEY = process.env.ZULIP_API_KEY || "";
const SITE = process.env.ZULIP_SITE || "";

registerFunction(
  { id: "channel::zulip::webhook", description: "Handle Zulip bot webhook" },
  async (req) => {
    const body = req.body || req;
    const { message } = body;

    if (!message?.content) return { status_code: 200, body: { ok: true } };

    const streamId = message.stream_id || message.sender_id;
    const text = message.content;
    const topic = message.subject || "";

    const agentId = await resolveAgent(trigger, "zulip", String(streamId));

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `zulip:${streamId}:${topic}`,
    });

    await sendMessage(message.type, streamId, topic, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "zulip", streamId, senderId: message.sender_id },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::zulip::webhook",
  config: { api_path: "webhook/zulip", http_method: "POST" },
});

async function sendMessage(
  type: string,
  to: number,
  topic: string,
  content: string,
) {
  const auth = Buffer.from(`${EMAIL}:${API_KEY}`).toString("base64");
  const chunks = splitMessage(content, 10000);
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      type: type === "private" ? "private" : "stream",
      to: String(to),
      topic,
      content: chunk,
    });
    await fetch(`${SITE}/api/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  }
}
