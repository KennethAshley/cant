import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { HandlerOptions } from "./acp.ts";

type Reply = { text: string; stopReason: string };
type Turn = { id: string; started: boolean; cancelled: boolean; text: string; error?: string; finish: (error?: Error) => void };
type Session = { child: ChildProcessWithoutNullStreams; id: string; turn?: Turn };

/** Pi already exposes JSONL RPC. One process per thread keeps its model context isolated. */
export class PiHandler {
  private command: string[];
  private opts: HandlerOptions;
  private sessions = new Map<string, Session>();
  alive = false;

  constructor(command: string[], opts: HandlerOptions) { this.command = command; this.opts = opts; }

  async start(): Promise<void> {
    const { stdout } = await promisify(execFile)(this.command[0], [...this.command.slice(1), "--version"], { timeout: 10_000 });
    const version = stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!version || (Number(version[1]) === 0 && (Number(version[2]) < 84 || (Number(version[2]) === 84 && Number(version[3]) < 1)))) {
      throw new Error("Pi 0.84.1 or newer is required. Update Pi, then start this agent again.");
    }
    this.alive = true;
  }

  private session(thread: string): Session {
    const existing = this.sessions.get(thread);
    if (existing) return existing;
    const args = [...this.command.slice(1), "--mode", "rpc", "--no-session"];
    // Pi has no permission callbacks: deny must disable tools and extension code at launch.
    if (this.opts.permissions === "deny") args.push("--no-tools", "--no-extensions");
    const child = spawn(this.command[0], args, { cwd: this.opts.cwd, stdio: "pipe" });
    const session: Session = { child, id: `pi-${child.pid}` };
    this.sessions.set(thread, session);
    const fail = (error: Error) => {
      session.turn?.finish(session.turn.cancelled ? undefined : error);
      if (this.sessions.get(thread) === session) this.sessions.delete(thread);
      child.kill();
    };
    child.on("error", fail);
    child.on("exit", () => fail(new Error("Pi process exited")));
    child.stdin.on("error", fail);
    child.stderr.resume();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return fail(new Error("Pi response exceeded 16 MB"));
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "response" && event.command === "get_state" && event.success) session.id = event.data.sessionId;
          const turn = session.turn;
          if (!turn) continue;
          if (event.type === "agent_start") turn.started = true;
          if (event.type === "response" && event.id === turn.id && event.success === false) turn.finish(new Error(event.error || "Pi rejected the prompt"));
          if (event.type === "message_end" && event.message?.role === "assistant") {
            turn.text = (event.message.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
            turn.error = event.message.stopReason === "error" ? event.message.errorMessage || "Pi provider failed" : undefined;
          }
          // agent_end can be followed by automatic retries; only agent_settled is final.
          if (event.type === "agent_settled") turn.finish(turn.error && !turn.cancelled ? new Error(turn.error) : undefined);
          if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method)) {
            child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n");
          }
        } catch { fail(new Error("Invalid Pi RPC response")); return; }
      }
    });
    child.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
    return session;
  }

  async prompt(thread: string, text: string): Promise<Reply> {
    if (!this.alive) throw new Error("Pi is not running");
    const session = this.session(thread);
    if (session.turn) throw new Error("Pi already has an active turn on this thread");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.turn?.finish(new Error(`Pi timed out after ${this.opts.timeoutMs}ms`));
        this.sessions.delete(thread);
        session.child.kill();
      }, this.opts.timeoutMs);
      const turn: Turn = {
        id: randomUUID(), started: false, cancelled: false, text: "",
        finish: error => {
          clearTimeout(timer);
          session.turn = undefined;
          if (error) reject(error);
          else resolve({ text: turn.cancelled ? "" : turn.text.trim(), stopReason: turn.cancelled ? "cancelled" : "end_turn" });
        },
      };
      session.turn = turn;
      session.child.stdin.write(JSON.stringify({ type: "prompt", id: turn.id, message: text }) + "\n");
    });
  }

  async cancel(thread: string): Promise<boolean> {
    const session = this.sessions.get(thread);
    if (!session?.turn) return false;
    session.turn.cancelled = true;
    if (session.turn.started) session.child.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
    // abort cannot stop Pi's asynchronous prompt preparation. Wait for process exit instead.
    else session.child.kill();
    return true;
  }

  sessionIds(): Record<string, string> { return Object.fromEntries([...this.sessions].map(([t, s]) => [t, s.id])); }

  close(): void {
    this.alive = false;
    for (const s of this.sessions.values()) { s.turn?.finish(new Error("Pi stopped")); s.child.kill(); }
    this.sessions.clear();
  }
}
