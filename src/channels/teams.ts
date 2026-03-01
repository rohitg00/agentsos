import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-teams" },
);

const APP_ID = process.env.TEAMS_APP_ID || "";
const APP_PASSWORD = process.env.TEAMS_APP_PASSWORD || "";
const AUTH_URL =
  "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

registerFunction(
  {
    id: "channel::teams::webhook",
    description: "Handle Microsoft Teams Bot Framework webhook",
  },
  async (req) => {
    const activity = req.body || req;

    if (activity.type !== "message")
      return { status_code: 200, body: { ok: true } };

    const conversationId = activity.conversation?.id;
    const text = activity.text || "";
    const userId = activity.from?.id;
    const serviceUrl = activity.serviceUrl;

    const agentId = await resolveAgent(trigger, "teams", conversationId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `teams:${conversationId}`,
    });

    await sendMessage(
      serviceUrl,
      conversationId,
      activity.id,
      response.content,
    );

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "teams", conversationId, userId },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::teams::webhook",
  config: { api_path: "webhook/teams", http_method: "POST" },
});

async function getToken(): Promise<string> {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${APP_ID}&client_secret=${APP_PASSWORD}&scope=https://api.botframework.com/.default`,
  });
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function sendMessage(
  serviceUrl: string,
  conversationId: string,
  replyToId: string,
  text: string,
) {
  const token = await getToken();
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    await fetch(`${serviceUrl}/v3/conversations/${conversationId}/activities`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "message",
        text: chunk,
        replyToId,
      }),
    });
  }
}
