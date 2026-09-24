import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { home, loadConfig, saveConfig } from "./config.ts";
import { Daemon, serveHttp } from "./daemon.ts";
import { Inbox } from "./inbox.ts";
import { InteractivePiHandler, type PiContext, type PiMessage } from "./pi.ts";
import { Relay, profileEvent, secretFromNsec } from "./nostr.ts";

// Structural types keep Pi an optional, locally installed harness rather than a package dependency.
type Context = PiContext & {
  mode: string;
  sessionManager: PiContext["sessionManager"] & {getSessionFile(): string | undefined};
  ui: {notify(text: string, level: "info" | "warning" | "error"): void; setStatus(key: string, text: string | undefined): void};
};
type Pi = {
  sendMessage(message: PiMessage, options: {triggerTurn: boolean}): void;
  on(event: string, fn: (event: {toolName?: string}, ctx: Context) => unknown): void;
  registerTool(tool: {name: string; label: string; description: string; parameters: object;
    execute(id: string, args: unknown): Promise<{content: {type: "text"; text: string}[]; details: undefined}>}): void;
};

export default function cantExtension(pi: Pi): void {
  let daemon: Daemon | undefined;
  let handler: InteractivePiHandler | undefined;
  let stopHttp: (() => void) | undefined;
  let saveTimer: ReturnType<typeof setInterval> | undefined;
  let denyTools = false;
  const connected = () => { if (!daemon) throw new Error("Cant is disconnected"); return daemon; };
  const stop = () => {
    clearInterval(saveTimer);
    stopHttp?.(); stopHttp = undefined;
    if (daemon) { try { saveConfig(daemon.config()); } finally { daemon.stop(); } }
    daemon = undefined; handler = undefined;
  };
  pi.on("session_start", async (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") { ctx.ui.notify("Cant's interactive extension requires Pi's terminal mode.", "error"); return; }
    let relay: Relay | undefined;
    try {
      const config = loadConfig();
      if (config.protocol !== "pi-interactive") throw new Error("Choose Pi in the Cant picker to connect this session.");
      denyTools = config.acp.permissions === "deny";
      handler = new InteractivePiHandler(pi, ctx, config.timeoutMs);
      relay = new Relay(config.relays);
      const current = new Daemon({config, relay, handler, inbox: new Inbox()});
      let ready = false;
      // Claim the identity's port before starting its inbox writer or subscribing to the relay.
      stopHttp = await serveHttp(current, config.port, () => ready);
      daemon = current;
      await current.start();
      ready = true;
      const session = ctx.sessionManager.getSessionFile();
      if (session) fs.writeFileSync(path.join(home(), "pi-session"), session, {mode: 0o600});
      saveTimer = setInterval(() => saveConfig(current.config()), 10_000); saveTimer.unref();
      const secret = secretFromNsec(config.nsec);
      void relay.publish([profileEvent(secret, {name: config.name, about: config.about, capabilities: config.capabilities})])
        .catch(() => ctx.ui.notify("Cant profile could not be published; messages remain available locally.", "warning"));
      ctx.ui.setStatus("sidecar", `cant · ${config.name} · localhost:${config.port}`);
      ctx.ui.notify(`Cant connected. Incoming DMs appear here; only sidecar_reply or sidecar_send transmits text. Viewer: http://localhost:${config.port}`, "info");
    } catch (error) {
      stop(); relay?.close();
      ctx.ui.setStatus("sidecar", undefined);
      ctx.ui.notify(`Cant: ${error instanceof Error ? error.message : error}`, "error");
    }
  });
  pi.on("session_shutdown", (_event, ctx) => { stop(); ctx.ui.setStatus("sidecar", undefined); });
  pi.on("agent_start", () => handler?.started());
  pi.on("agent_settled", () => handler?.settled());
  pi.on("tool_call", event => {
    if (denyTools && handler?.handlingMessage && !["sidecar_reply", "sidecar_inbox", "sidecar_find_agents"].includes(event.toolName ?? "")) {
      return {block: true, reason: "This Cant identity denies tool execution for incoming DMs."};
    }
  });

  const register = (name: string, description: string, properties: Record<string, object>, required: string[], run: (args: unknown) => unknown) => {
    pi.registerTool({name, label: name, description, parameters: {type: "object", properties, required, additionalProperties: false},
      execute: async (_id, args) => ({content: [{type: "text", text: JSON.stringify(await run(args))}], details: undefined}),
    });
  };
  const string = {type: "string"};
  register("sidecar_reply", "Send an explicit reply to the current incoming Cant request. Only this text is shared; Jev verifies it before delivery. Never copy unrelated private session history.",
    {request: string, text: string}, ["request", "text"], args => {
      const reply = z.object({request: z.string().uuid(), text: z.string().min(1).max(100_000)}).parse(args);
      connected(); handler!.reply(reply.request, reply.text);
      return {submitted: true, status: "Awaiting Cant verification and delivery; inspect the viewer for the outcome."};
    });
  register("sidecar_send", "Send text explicitly intended for another agent by npub. Use for owner-requested outreach; reply to incoming requests with sidecar_reply.",
    {to: string, text: string}, ["to", "text"], args => {
      if (handler?.handlingMessage) throw new Error("Use sidecar_reply for the active DM so Cant can verify it before delivery.");
      return connected().send(z.object({to: z.string(), text: z.string().min(1).max(100_000)}).parse(args));
    });
  register("sidecar_inbox", "Read received Cant messages, including items awaiting owner review. This does not approve requests.", {}, [], () => connected().inbox({unread_only: false}));
  register("sidecar_find_agents", "Find agents by name or capability so the owner can choose who to contact.", {query: string}, [], args => connected().findAgents(z.object({query: z.string().optional()}).parse(args).query));
}
