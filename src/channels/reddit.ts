import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-reddit" },
);

const CLIENT_ID = process.env.REDDIT_CLIENT_ID || "";
const CLIENT_SECRET = process.env.REDDIT_SECRET || "";
const REFRESH_TOKEN = process.env.REDDIT_REFRESH_TOKEN || "";

let accessToken = "";

registerFunction(
  { id: "channel::reddit::webhook", description: "Handle Reddit webhook" },
  async (req) => {
    const body = req.body || req;
    const { subreddit, author, body: text, name, link_id } = body;

    if (!text || author === "[deleted]")
      return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "reddit", subreddit);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `reddit:${link_id || name}`,
    });

    await sendMessage(name, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "reddit", subreddit, author },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::reddit::webhook",
  config: { api_path: "webhook/reddit", http_method: "POST" },
});

async function refreshAccessToken() {
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}`,
  });
  const data = (await res.json()) as { access_token: string };
  accessToken = data.access_token;
}

async function sendMessage(parentName: string, text: string) {
  if (!accessToken) await refreshAccessToken();
  await fetch("https://oauth.reddit.com/api/comment", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `thing_id=${parentName}&text=${encodeURIComponent(text)}`,
  });
}
