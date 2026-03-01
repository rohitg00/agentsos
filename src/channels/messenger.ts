import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-messenger" },
);

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || "";
const API_URL = "https://graph.facebook.com/v18.0/me/messages";

registerFunction(
  {
    id: "channel::messenger::webhook",
    description: "Handle Facebook Messenger webhook",
  },
  async (req) => {
    const body = req.body || req;

    if (
      body["hub.mode"] === "subscribe" &&
      body["hub.verify_token"] === VERIFY_TOKEN
    ) {
      return { status_code: 200, body: body["hub.challenge"] };
    }

    const entry = body.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (!messaging?.message?.text)
      return { status_code: 200, body: { ok: true } };

    const senderId = messaging.sender.id;
    const text = messaging.message.text;

    const agentId = await resolveAgent(trigger, "messenger", senderId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `messenger:${senderId}`,
    });

    await sendMessage(senderId, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "messenger", senderId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::messenger::webhook",
  config: { api_path: "webhook/messenger", http_method: "POST" },
});

async function sendMessage(recipientId: string, text: string) {
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    await fetch(`${API_URL}?access_token=${PAGE_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: chunk },
      }),
    });
  }
}
