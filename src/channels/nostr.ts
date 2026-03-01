import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-nostr" },
);

const PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY || "";
const RELAY = process.env.NOSTR_RELAY || "wss://relay.damus.io";
const BRIDGE_URL = process.env.NOSTR_BRIDGE_URL || "http://localhost:7777";

registerFunction(
  {
    id: "channel::nostr::webhook",
    description: "Handle Nostr relay event via HTTP bridge",
  },
  async (req) => {
    const body = req.body || req;
    const { pubkey, content, id, kind } = body;

    if (!content || kind !== 1) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "nostr", pubkey);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: content,
      sessionId: `nostr:${pubkey}`,
    });

    await sendMessage(response.content, id);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "nostr", pubkey },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::nostr::webhook",
  config: { api_path: "webhook/nostr", http_method: "POST" },
});

async function sendMessage(content: string, replyToId?: string) {
  const chunks = splitMessage(content, 4096);
  for (const chunk of chunks) {
    await fetch(`${BRIDGE_URL}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: chunk,
        kind: 1,
        relay: RELAY,
        private_key: PRIVATE_KEY,
        ...(replyToId ? { tags: [["e", replyToId]] } : {}),
      }),
    });
  }
}
