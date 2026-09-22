import { execFile } from "node:child_process";
import http from "node:http";
import type { Event } from "nostr-tools/pure";
import type { Config } from "./config.ts";
import { Inbox, type Stored } from "./inbox.ts";
import { pubkeyFromNpub, pubkeyOf, npubOf, secretFromNsec, wrap, unwrap, type Message, type MessageType, type Profile } from "./nostr.ts";
import { triage, scope, verify, route, typesafeAsk, type Ask } from "./decide.ts";

export interface RelayLike {
  publish(events: Event[]): Promise<void>;
  subscribeInbox(pubkey: string, sinceS: number, onEvent: (ev: Event) => void): () => void;
  findAgents(): Promise<Profile[]>;
  close(): void;
}
export interface HandlerLike {
  alive: boolean;
  start(): Promise<void>;
  prompt(thread: string, text: string): Promise<{ text: string; stopReason: string }>;
  cancel(thread: string): Promise<boolean>;
  sessionIds(): Record<string, string>;
  close(): void;
}
export interface Deps {
  config: Config;
  relay: RelayLike;
  handler?: HandlerLike;
  inbox: Inbox;
  ask?: Ask;
  notify?: (text: string) => void;
}

export class Daemon {
  private deps: Deps;
  private secret: Uint8Array;
  private pubkey: string;
  private owner?: string;
  private ask: Ask;
  private notifyFn: (text: string) => void;
  private stopSub?: () => void;
  private running = new Set<string>();
  private queued = new Map<string, Stored[]>();
  private profiles = new Map<string, Profile>();

  constructor(deps: Deps) {
    this.deps = deps;
    this.secret = secretFromNsec(deps.config.nsec);
    this.pubkey = pubkeyOf(this.secret);
    this.owner = deps.config.owner ? pubkeyFromNpub(deps.config.owner) : undefined;
    this.ask = deps.ask ?? typesafeAsk;
    this.notifyFn = deps.notify ?? ((text) => {
      const cmd = deps.config.notify;
      if (!cmd) return;
      execFile("/bin/sh", ["-c", cmd], { env: { ...process.env, MSG: text.slice(0, 200) } }, () => {});
    });
  }

  private get me(): Profile {
    const c = this.deps.config;
    return { pubkey: this.pubkey, name: c.name, about: c.about, capabilities: c.capabilities };
  }

  async start(): Promise<void> {
    if (this.deps.handler) await this.deps.handler.start();
    this.stopSub = this.deps.relay.subscribeInbox(this.pubkey, this.deps.inbox.lastSeen(), (ev) => {
      const m = unwrap(ev, this.secret);
      if (m && m.to === this.pubkey && !this.deps.inbox.has(m.id)) void this.onInbound(m).catch((e) => console.error("inbound failed", e));
    });
  }

  stop(): void {
    this.stopSub?.();
    this.deps.handler?.close();
    this.deps.relay.close();
  }

  // sending

  private async emit(to: string, msg: { text: string; type: MessageType; thread?: string; depth?: number }): Promise<string> {
    const { wraps, id } = wrap(this.secret, to, msg);
    await this.deps.relay.publish(wraps);
    return id;
  }

  /** Outcome to the sender, cc the owner unless the owner is the sender. */
  private async outcome(m: Stored, type: "done" | "cant", text: string): Promise<void> {
    await this.emit(m.from, { text, type, thread: m.thread });
    if (this.owner && m.from !== this.owner) {
      await this.emit(this.owner, { text: `[${type} for ${m.from.slice(0, 8)}] ${text}`, type, thread: m.thread });
      this.notifyFn(`${type}: ${text.slice(0, 80)}`);
    }
  }

  private async escalate(m: Stored, reason: string): Promise<void> {
    if (!this.owner) return;
    await this.emit(this.owner, { text: `${reason}\nfrom ${npubOf(m.from)}\nthread ${m.thread}\n\n${m.text}`, type: "escalate", thread: m.thread });
    this.notifyFn(reason);
  }

  // inbound

  private passesGate(from: string): boolean {
    const { respond_to, allow } = this.deps.config;
    if (from === this.owner) return true;
    if (respond_to === "anyone") return true;
    if (respond_to === "allowlist") return allow.includes(from);
    return false;
  }

  private async onInbound(m: Message): Promise<void> {
    const s = this.deps.inbox.append(m);
    if (m.type === "cancel") {
      const root = this.deps.inbox.thread(m.thread)[0];
      if (root && root.id !== m.id && (m.from === this.owner || m.from === root.from)) {
        await this.deps.handler?.cancel(m.thread);
        await this.outcome(root, "cant", "cancelled");
      }
      return;
    }
    if (m.type !== "ask") {
      // ack, answer, done, cant, escalate addressed to me: stored for inbox; a human's sidecar gets a notification
      if (!this.deps.handler) this.notifyFn(`${m.type} from ${m.from.slice(0, 8)}: ${m.text.slice(0, 80)}`);
      return;
    }
    if (m.depth >= this.deps.config.depthLimit) {
      await this.emit(m.from, { text: `refused: depth ${m.depth} reached the limit`, type: "cant", thread: m.thread });
      return;
    }
    if (!this.passesGate(m.from)) {
      if (this.deps.config.respond_to !== "allowlist") return;
      const { inScope } = await scope({ message: m, me: this.me }, this.ask).catch(() => ({ inScope: undefined }));
      this.deps.inbox.setTriage(m.id, { action: "escalate", confidence: 0, urgency: 1, inScope: inScope ?? 0, reason: "stranger" });
      this.deps.inbox.park(m.id);
      const verdict = inScope === undefined ? "scope unknown, no TYPESAFE_API_KEY" : `in scope ${inScope.toFixed(2)}`;
      await this.escalate(s, `consent needed: ${verdict}. Reply: relayd allow ${npubOf(m.from)}`);
      return;
    }
    await this.dispatch(s);
  }

  private async dispatch(s: Stored): Promise<void> {
    if (!this.deps.handler) {
      // owner's own sidecar: nothing runs, the inbox is the surface
      this.notifyFn(`ask from ${s.from.slice(0, 8)}: ${s.text.slice(0, 80)}`);
      return;
    }
    let mode: "act" | "ask" = "act";
    if (s.from !== this.owner) {
      const t = await triage(
        { message: s, thread: this.deps.inbox.thread(s.thread), sender: this.profiles.get(s.from), me: this.me, thresholds: this.deps.config.thresholds },
        this.ask,
      ).catch((e) => ({ action: "escalate" as const, confidence: 0, urgency: 1, inScope: 0, reason: `jev failed: ${e instanceof Error ? e.message : e}` }));
      this.deps.inbox.setTriage(s.id, t);
      if (t.action === "escalate") return this.escalate(s, `escalated: ${t.reason}`);
      mode = t.action;
    }
    if (this.running.has(s.thread)) {
      this.queued.set(s.thread, [...(this.queued.get(s.thread) ?? []), s]);
      return;
    }
    await this.run(s, mode);
  }

  private async run(s: Stored, mode: "act" | "ask"): Promise<void> {
    const h = this.deps.handler!;
    this.running.add(s.thread);
    try {
      if (mode === "act") await this.emit(s.from, { text: "accepted, working", type: "ack", thread: s.thread });
      const batch = [s, ...(this.queued.get(s.thread) ?? [])];
      this.queued.delete(s.thread);
      const body = batch.map((m) => `[${m.type} from ${this.profiles.get(m.from)?.name ?? m.from.slice(0, 8)}]\n${m.text}`).join("\n\n");
      const instruction = mode === "act"
        ? "Do what is asked. Reply with the result only."
        : "Do not do the task yet. Reply with exactly one clarifying question.";
      let out: { text: string; stopReason: string };
      try {
        out = await h.prompt(s.thread, `${body}\n\n${instruction}`);
      } catch (e) {
        return this.outcome(s, "cant", `handler failed: ${e instanceof Error ? e.message : e}`);
      }
      this.deps.inbox.saveSessions(h.sessionIds());
      if (out.stopReason !== "end_turn") return this.outcome(s, "cant", `stopped: ${out.stopReason}\n${out.text.slice(-2000)}`);
      if (mode === "ask") { await this.emit(s.from, { text: out.text, type: "answer", thread: s.thread }); return; }
      const v = await verify({ ask: s.text, output: out.text }, this.ask).catch(() => ({ answersAsk: true, p: 1 }));
      await this.outcome(s, v.answersAsk ? "done" : "cant", v.answersAsk ? out.text : `output did not answer the ask (${v.p.toFixed(2)}):\n${out.text.slice(-2000)}`);
    } finally {
      this.running.delete(s.thread);
      const next = this.queued.get(s.thread)?.[0];
      if (next) void this.dispatch(next);
    }
  }

  // tools

  async send(args: { to?: string; text: string; type?: MessageType; thread?: string }): Promise<{ thread: string; id: string } | { candidates: Profile[] }> {
    let to = args.to ? pubkeyFromNpub(args.to) : undefined;
    if (!to) {
      const candidates = await this.findAgents();
      const r = await route({ request: args.text, candidates, threshold: this.deps.config.thresholds.route }, this.ask).catch(() => ({ pubkey: undefined, confidence: 0 }));
      if (!r.pubkey) return { candidates };
      to = r.pubkey;
    }
    const id = await this.emit(to, { text: args.text, type: args.type ?? "ask", thread: args.thread });
    return { thread: args.thread ?? id, id };
  }

  inbox(args: { unread_only?: boolean; waiting_on_me?: boolean } = {}): Stored[] {
    const box = this.deps.inbox;
    let items = args.unread_only === false ? box.all() : box.unread();
    if (args.waiting_on_me) items = items.filter((s) => s.parked || s.type === "escalate");
    box.markRead(items.map((s) => s.id));
    return items;
  }

  async reply(args: { thread: string; text: string; type?: MessageType }): Promise<{ id: string }> {
    const root = this.deps.inbox.thread(args.thread)[0];
    if (!root) throw new Error(`unknown thread ${args.thread}`);
    const to = root.from === this.pubkey ? root.to : root.from;
    return { id: await this.emit(to, { text: args.text, type: args.type ?? "answer", thread: args.thread }) };
  }

  async allow(npub: string): Promise<{ allowed: true; resumed: number }> {
    const pk = pubkeyFromNpub(npub);
    if (!this.deps.config.allow.includes(pk)) this.deps.config.allow.push(pk);
    const resumed = this.deps.inbox.unpark(pk);
    for (const s of resumed) await this.dispatch(s);
    return { allowed: true, resumed: resumed.length };
  }

  async cancel(thread: string): Promise<{ cancelled: boolean }> {
    const root = this.deps.inbox.thread(thread)[0];
    const cancelled = (await this.deps.handler?.cancel(thread)) ?? false;
    if (root && root.from !== this.pubkey) await this.outcome(root, "cant", "cancelled by owner");
    return { cancelled };
  }

  async findAgents(query?: string): Promise<Profile[]> {
    const all = await this.deps.relay.findAgents();
    for (const p of all) this.profiles.set(p.pubkey, p);
    const q = query?.toLowerCase();
    return all.filter((p) => p.pubkey !== this.pubkey && (!q || `${p.name} ${p.about} ${p.capabilities.join(" ")}`.toLowerCase().includes(q)));
  }

  whoami(): { npub: string; name: string; capabilities: string[] } {
    return { npub: npubOf(this.pubkey), name: this.deps.config.name, capabilities: this.deps.config.capabilities };
  }

  /** The live config, so the CLI can persist changes made through tools (allow). */
  config(): Config { return this.deps.config; }
}

// localhost HTTP endpoint

export type Rpc = "send" | "inbox" | "reply" | "allow" | "cancel" | "find_agents" | "whoami";

export function serveHttp(daemon: Daemon, port: number): Promise<() => void> {
  const server = http.createServer(async (req, res) => {
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/health") return json(200, { ok: true, ...daemon.whoami() });
    if (req.method !== "POST" || req.url !== "/rpc") return json(404, { error: "not found" });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const { method, args = {} } = JSON.parse(raw) as { method: Rpc; args?: Record<string, unknown> };
      const calls: Record<Rpc, () => unknown> = {
        send: () => daemon.send(args as never),
        inbox: () => daemon.inbox(args as never),
        reply: () => daemon.reply(args as never),
        allow: () => daemon.allow(String(args.npub)),
        cancel: () => daemon.cancel(String(args.thread)),
        find_agents: () => daemon.findAgents(args.query as string | undefined),
        whoami: () => daemon.whoami(),
      };
      const call = calls[method];
      if (!call) throw new Error(`unknown method ${method}`);
      json(200, { result: await call() });
    } catch (e) {
      json(400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(() => server.close()));
  });
}
