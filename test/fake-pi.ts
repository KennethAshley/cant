// Pi's documented JSONL boundary; no model or network access.
import fs from "node:fs";
if (process.argv.includes("--version")) { console.log("0.84.1"); process.exit(0); }
let buffer = "";
let count = 0;
let active = false;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const cmd = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (cmd.type === "get_state") send({ type: "response", command: cmd.type, id: cmd.id, success: true, data: { sessionId: String(process.pid) } });
    if (cmd.type === "abort") { send({ type: "response", command: "abort", success: true }); if (active) { active = false; send({ type: "agent_settled" }); } }
    if (cmd.type === "prompt") {
      if (cmd.message === "REJECT") { send({ type: "response", command: "prompt", id: cmd.id, success: false, error: "No model configured" }); continue; }
      send({ type: "response", command: "prompt", id: cmd.id, success: true });
      if (cmd.message.startsWith("PREFLIGHT ")) {
        setTimeout(() => {
          fs.writeFileSync(cmd.message.slice(10), "should not execute after cancellation");
          send({ type: "agent_start" }); send({ type: "agent_settled" });
        }, 180);
        continue;
      }
      active = true;
      send({ type: "agent_start" });
      if (cmd.message === "SLEEP") continue;
      if (cmd.message === "EXIT") { process.exit(1); }
      const text = cmd.message === "TOOLS" ? String(process.argv.includes("--no-tools") && process.argv.includes("--no-extensions")) : `${++count}: ${cmd.message}`;
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: cmd.message === "FAIL" ? "error" : "stop", errorMessage: "provider failed" } });
      send({ type: "agent_end", messages: [], willRetry: cmd.message === "RETRY" });
      if (cmd.message === "RETRY") send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "retried successfully" }], stopReason: "stop" } });
      send({ type: "agent_settled" });
      active = false;
    }
  }
});
