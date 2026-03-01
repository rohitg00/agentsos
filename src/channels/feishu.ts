import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-feishu" },
);

const APP_ID = process.env.FEISHU_APP_ID || "";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const API_URL = "https://open.feishu.cn/open-apis";

let tenantToken = "";

registerFunction(
  {
    id: "channel::feishu::webhook",
    description: "Handle Feishu/Lark event callback",
  },
  async (req) => {
    const body = req.body || req;

    if (body.challenge)
      return { status_code: 200, body: { challenge: body.challenge } };

    const event = body.event;
    if (!event?.message?.content)
      return { status_code: 200, body: { ok: true } };

    const chatId = event.message.chat_id;
    const content = JSON.parse(event.message.content);
    const text = content.text || "";
    const userId = event.sender?.sender_id?.user_id;

    const agentId = await resolveAgent(trigger, "feishu", chatId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `feishu:${chatId}`,
    });

    await sendMessage(chatId, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "feishu", chatId, userId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::feishu::webhook",
  config: { api_path: "webhook/feishu", http_method: "POST" },
});

async function getTenantToken(): Promise<string> {
  if (tenantToken) return tenantToken;
  const res = await fetch(`${API_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = (await res.json()) as { tenant_access_token: string };
  tenantToken = data.tenant_access_token;
  return tenantToken;
}

async function sendMessage(chatId: string, text: string) {
  const token = await getTenantToken();
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${API_URL}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: chunk }),
      }),
    });
  }
}
