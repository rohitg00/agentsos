import { init } from "iii-sdk";
import { splitMessage, resolveAgent } from "../shared/utils.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  "ws://localhost:49134",
  { workerName: "channel-matrix" },
);

const HOMESERVER = process.env.MATRIX_HOMESERVER || "";
const TOKEN = process.env.MATRIX_TOKEN || "";

registerFunction(
  {
    id: "channel::matrix::webhook",
    description: "Handle Matrix homeserver webhook",
  },
  async (req) => {
    const event = req.body || req;

    if (event.type !== "m.room.message")
      return { status_code: 200, body: { ok: true } };

    const roomId = event.room_id;
    const text = event.content?.body || "";
    const sender = event.sender;

    if (!text) return { status_code: 200, body: { ok: true } };

    const agentId = await resolveAgent(trigger, "matrix", roomId);

    const response: any = await trigger("agent::chat", {
      agentId,
      message: text,
      sessionId: `matrix:${roomId}`,
    });

    await sendMessage(roomId, response.content);

    triggerVoid("security::audit", {
      type: "channel_message",
      agentId,
      detail: { channel: "matrix", roomId, sender },
    });

    return { status_code: 200, body: { ok: true } };
  },
);

registerTrigger({
  type: "http",
  function_id: "channel::matrix::webhook",
  config: { api_path: "webhook/matrix", http_method: "POST" },
});

async function sendMessage(roomId: string, text: string) {
  const txnId = Date.now();
  const chunks = splitMessage(text, 4096);
  for (let i = 0; i < chunks.length; i++) {
    await fetch(
      `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId + i}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msgtype: "m.text",
          body: chunks[i],
        }),
      },
    );
  }
}
