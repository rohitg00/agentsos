import { init } from "iii-sdk";
import { createHmac } from "crypto";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-dingtalk" },
);

const TOKEN = process.env.DINGTALK_TOKEN || "";
const SECRET = process.env.DINGTALK_SECRET || "";
const API_URL = "https://oapi.dingtalk.com/robot/send";

registerFunction(
  {
    id: "channel::dingtalk::webhook",
    description: "Handle DingTalk robot webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { text, conversationId, senderNick, senderId } = body;

    const content = text?.content?.trim();
    if (!content) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "dingtalk", conversationId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: content,
      sessionId: `dingtalk:${conversationId}`,
    });

    await sendMessage(response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "dingtalk", conversationId, senderId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::dingtalk::webhook",
  config: { api_path: "webhook/dingtalk", http_method: "POST" },
});

async function sendMessage(text: string) {
  const timestamp = Date.now();
  const sign = createHmac("sha256", SECRET)
    .update(`${timestamp}\n${SECRET}`)
    .digest("base64");
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(
      `${API_URL}?access_token=${TOKEN}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: chunk } }),
      },
    );
  }
}
