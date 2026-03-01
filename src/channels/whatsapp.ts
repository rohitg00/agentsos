import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-whatsapp" },
);

const TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const API_URL = `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`;

registerFunction(
  {
    id: "channel::whatsapp::webhook",
    description: "Handle WhatsApp Business API webhook",
  },
  async (req) => {
    const body = req.body || req;

    if (body.object !== "whatsapp_business_account")
      return { status_code: 200, body: { ok: true } };

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message?.text?.body) return { status_code: 200, body: { ok: true } };

    const from = message.from;
    const text = message.text.body;
    const agentId = await resolveAgent(trigger, "whatsapp", from);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `whatsapp:${from}`,
    });

    await sendMessage(from, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "whatsapp", from },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::whatsapp::webhook",
  config: { api_path: "webhook/whatsapp", http_method: "POST" },
});

async function sendMessage(to: string, text: string) {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: chunk },
      }),
    });
  }
}
