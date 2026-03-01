import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-google-chat" },
);

const TOKEN = process.env.GOOGLE_CHAT_TOKEN || "";

registerFunction(
  {
    id: "channel::google-chat::webhook",
    description: "Handle Google Chat webhook",
  },
  async (req) => {
    const event = req.body || req;

    if (event.type !== "MESSAGE")
      return { status_code: 200, body: { ok: true } };

    const spaceId = event.space?.name;
    const text = event.message?.text || "";
    const userId = event.user?.name;

    const agentId = await resolveAgent(trigger, "google-chat", spaceId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `google-chat:${spaceId}`,
    });

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "google-chat", spaceId, userId },
    });

    return { status_code: 200, body: { text: response.content } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::google-chat::webhook",
  config: { api_path: "webhook/google-chat", http_method: "POST" },
});
