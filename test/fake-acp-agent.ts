// A real ACP agent over stdio, built with the same SDK, so the client is tested against the protocol.
// Echoes its prompt as one text chunk, or sleeps when the prompt contains SLEEP and honors session/cancel.
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

let n = 0;
let cancelled = false;
const app = agent({ name: "fake" })
  .onRequest("initialize", async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest("session/new", async () => ({ sessionId: `s${++n}` }))
  .onNotification("session/cancel", async () => { cancelled = true; })
  .onRequest("session/prompt", async ({ params, client }) => {
    cancelled = false;
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (text.includes("SLEEP")) {
      for (let i = 0; i < 100 && !cancelled; i++) await new Promise((r) => setTimeout(r, 50));
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    }
    await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } } });
    return { stopReason: "end_turn" };
  });

const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
app.connect(stream);
