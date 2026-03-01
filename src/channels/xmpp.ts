import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-xmpp" },
);

const JID = process.env.XMPP_JID || "";
const PASSWORD = process.env.XMPP_PASSWORD || "";
const BRIDGE_URL = process.env.XMPP_BRIDGE_URL || "http://localhost:5280";

registerFunction(
  {
    id: "channel::xmpp::webhook",
    description: "Handle XMPP message via HTTP bridge",
  },
  async (req) => {
    const body = req.body || req;
    const { from, to, body: text, type } = body;

    if (!text || from === JID) return { status_code: 200, body: { ok: true } };

    const channelKey = type === "groupchat" ? to : from;
    const agentId = await resolveAgent(trigger, "xmpp", channelKey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `xmpp:${channelKey}`,
    });

    await sendMessage(channelKey, response.content, type);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "xmpp", from, chatType: type },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::xmpp::webhook",
  config: { api_path: "webhook/xmpp", http_method: "POST" },
});

async function sendMessage(to: string, text: string, type: string) {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${BRIDGE_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: JID,
        to,
        body: chunk,
        type: type || "chat",
      }),
    });
  }
}
