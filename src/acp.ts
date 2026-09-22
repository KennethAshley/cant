// ACP client: fez src/agent/harness.ts openAcpSession and drivePromptLoop, cut to what relayd uses.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION, type ActiveSession, type ClientContext } from "@agentclientprotocol/sdk";

export interface HandlerOptions {
  permissions: "allow" | "deny";
  timeoutMs: number;
  cwd?: string;
}

export class Handler {
  private command: string;
  private opts: HandlerOptions;
  private child?: ChildProcess;
  private ctx?: ClientContext;
  private sessions = new Map<string, ActiveSession>();
  private release?: () => void;
  private stderrTail = "";
  alive = false;

  constructor(command: string, opts: HandlerOptions) {
    this.command = command;
    this.opts = opts;
  }

  async start(): Promise<void> {
    const [cmd, ...args] = this.command.split(/\s+/);
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: this.opts.cwd, env: process.env });
    child.stderr!.on("data", (b: Buffer) => { this.stderrTail = (this.stderrTail + b.toString()).slice(-2000); });
    const failed = once(child, "error").then(([e]) => { throw e; });
    await Promise.race([once(child, "spawn"), failed]);
    this.child = child;

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const app = client({ name: "relayd" });
    // Permission policy from config: "allow" picks the first allow option, "deny" the first reject option.
    app.onRequest("session/request_permission", async ({ params }) => {
      const want = this.opts.permissions === "allow" ? /^allow/ : /^reject/;
      const opt = params.options.find((o) => want.test(o.kind)) ?? params.options[0];
      return { outcome: { outcome: "selected", optionId: opt.optionId } };
    });

    await new Promise<void>((resolve, reject) => {
      const held = new Promise<void>((r) => (this.release = r));
      app
        .connectWith(stream, async (ctx) => {
          await ctx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "relayd", version: "0.0.1" } });
          this.ctx = ctx;
          this.alive = true;
          resolve();
          await held; // keep the connection open for the handler's lifetime
        })
        .catch((e) => reject(new Error(`${this.command} failed: ${e instanceof Error ? e.message : e} ${this.stderrTail.slice(-200)}`)))
        .finally(() => { this.alive = false; child.kill(); });
      child.on("exit", () => { this.alive = false; this.release?.(); });
    });
  }

  private async session(thread: string): Promise<ActiveSession> {
    let s = this.sessions.get(thread);
    if (s) return s;
    if (!this.ctx) throw new Error("handler not started");
    s = await this.ctx.buildSession(this.opts.cwd ?? process.cwd()).start();
    this.sessions.set(thread, s);
    return s;
  }

  /** Send one prompt on the thread's session and collect the reply text until the turn stops. */
  async prompt(thread: string, text: string): Promise<{ text: string; stopReason: string }> {
    if (!this.alive) throw new Error(`${this.command} is not running`);
    const s = await this.session(thread);
    const deadline = Date.now() + this.opts.timeoutMs;
    const promptFailed = new Promise<never>((_, reject) => { s.prompt(text).catch(reject); });
    promptFailed.catch(() => {});
    let out = "";
    while (true) {
      const left = deadline - Date.now();
      if (left <= 0) {
        await this.cancel(thread);
        throw new Error(`${this.command} timed out after ${this.opts.timeoutMs}ms on thread ${thread}`);
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"tick">((resolve) => { timer = setTimeout(() => resolve("tick"), left); });
      let msg;
      try {
        msg = await Promise.race([s.nextUpdate(), timeout, promptFailed]);
      } finally {
        clearTimeout(timer);
      }
      if (msg === "tick") continue;
      if (msg.kind === "stop") return { text: out.trim(), stopReason: msg.stopReason };
      const u = msg.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") out += u.content.text;
    }
  }

  async cancel(thread: string): Promise<boolean> {
    const s = this.sessions.get(thread);
    if (!s || !this.ctx) return false;
    await this.ctx.notify("session/cancel", { sessionId: s.sessionId });
    return true;
  }

  sessionIds(): Record<string, string> {
    return Object.fromEntries([...this.sessions].map(([t, s]) => [t, s.sessionId]));
  }

  close(): void {
    this.alive = false;
    this.release?.();
    this.child?.kill();
  }
}
