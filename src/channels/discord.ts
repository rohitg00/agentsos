import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-discord" },
);

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_API = "https://discord.com/api/v10";

registerFunction(
  {
    id: "channel::discord::webhook",
    description: "Handle Discord interaction/webhook",
  },
  async (req) => {
    const event = req.body || req;

    if (event.t === "MESSAGE_CREATE") {
      const msg = event.d;
      if (msg.author?.bot) return { status_code: 200, body: { ok: true } };

      const agentId = await resolveAgent(trigger, "discord", msg.channel_id);
      const response: any = await trigger("agent::chat", {
        agentId,
        message: msg.content,
        sessionId: `discord:${msg.channel_id}`,
      });

      await sendMessage(msg.channel_id, response.content);
    }

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::discord::webhook",
  config: { api_path: "webhook/discord", http_method: "POST" },
});

async function sendMessage(channelId: string, content: string) {
  const chunks = splitMessage(content, 2000);
  for (const chunk of chunks) {
    await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: chunk }),
    });
  }
}
