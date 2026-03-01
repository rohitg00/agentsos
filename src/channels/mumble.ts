import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-mumble" },
);

const SERVER = process.env.MUMBLE_SERVER || "";
const PASSWORD = process.env.MUMBLE_PASSWORD || "";
const BRIDGE_URL = process.env.MUMBLE_BRIDGE_URL || "http://localhost:6502";

registerFunction(
  {
    id: "channel::mumble::webhook",
    description: "Handle Mumble text channel via HTTP bridge",
  },
  async (req) => {
    const body = req.body || req;
    const { channel, user, message } = body;

    if (!message) return { status_code: 200, body: { ok: true } };

    const channelKey = channel || "root";
    const agentId = await resolveAgent(trigger, "mumble", channelKey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message,
      sessionId: `mumble:${channelKey}`,
    });

    await sendMessage(channelKey, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "mumble", mumbleChannel: channelKey, user },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::mumble::webhook",
  config: { api_path: "webhook/mumble", http_method: "POST" },
});

async function sendMessage(channel: string, text: string) {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${BRIDGE_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, message: chunk }),
    });
  }
}
