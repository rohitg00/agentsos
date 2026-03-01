import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-mattermost" },
);

const BASE_URL = process.env.MATTERMOST_URL || "";
const TOKEN = process.env.MATTERMOST_TOKEN || "";

registerFunction(
  {
    id: "channel::mattermost::webhook",
    description: "Handle Mattermost outgoing webhook",
  },
  async (req) => {
    const body = req.body || req;
    const { channel_id, user_id, text, post_id } = body;

    if (!text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "mattermost", channel_id);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `mattermost:${channel_id}`,
    });

    await sendMessage(channel_id, response.content, post_id);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "mattermost", channelId: channel_id, userId: user_id },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::mattermost::webhook",
  config: { api_path: "webhook/mattermost", http_method: "POST" },
});

async function sendMessage(channelId: string, text: string, rootId?: string) {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    await fetch(`${BASE_URL}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: channelId,
        message: chunk,
        ...(rootId ? { root_id: rootId } : {}),
      }),
    });
  }
}
