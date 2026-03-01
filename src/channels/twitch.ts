import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-twitch" },
);

const TOKEN = process.env.TWITCH_TOKEN || "";
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const API_URL = "https://api.twitch.tv/helix";

registerFunction(
  {
    id: "channel::twitch::webhook",
    description: "Handle Twitch EventSub webhook",
  },
  async (req) => {
    const body = req.body || req;

    if (body.challenge) return { status_code: 200, body: body.challenge };

    const event = body.event;
    if (!event?.message?.text) return { status_code: 200, body: { ok: true } };

    const channelId = event.broadcaster_user_id;
    const text = event.message.text;
    const userId = event.user_id;

    const agentId = await resolveAgent(trigger, "twitch", channelId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `twitch:${channelId}`,
    });

    await sendMessage(channelId, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "twitch", channelId, userId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::twitch::webhook",
  config: { api_path: "webhook/twitch", http_method: "POST" },
});

async function sendMessage(broadcasterId: string, text: string) {
  const chunks = splitMessage(text, 500);
  for (const chunk of chunks) {
    await fetch(`${API_URL}/chat/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Client-Id": CLIENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: broadcasterId,
        message: chunk,
      }),
    });
  }
}
