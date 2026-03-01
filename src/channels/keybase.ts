import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-keybase" },
);

const USERNAME = process.env.KEYBASE_USERNAME || "";
const PAPERKEY = process.env.KEYBASE_PAPERKEY || "";
const BRIDGE_URL = process.env.KEYBASE_BRIDGE_URL || "http://localhost:8822";

registerFunction(
  {
    id: "channel::keybase::webhook",
    description: "Handle Keybase bot webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { sender, channel, text, conversation_id } = body;

    if (!text || sender === USERNAME)
      return { status_code: 200, body: { ok: true } };

    const channelKey = conversation_id || channel;
    const agentId = await resolveAgent(trigger, "keybase", channelKey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `keybase:${channelKey}`,
    });

    await sendMessage(channelKey, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "keybase", sender, conversationId: channelKey },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::keybase::webhook",
  config: { api_path: "webhook/keybase", http_method: "POST" },
});

async function sendMessage(conversationId: string, text: string) {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${BRIDGE_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: conversationId,
        message: chunk,
      }),
    });
  }
}
