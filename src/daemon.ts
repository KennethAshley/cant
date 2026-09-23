import { execFile } from "node:child_process";
import http from "node:http";
import type { Event } from "nostr-tools/pure";
import type { Config } from "./config.ts";
import { Inbox, type Stored } from "./inbox.ts";
import { pubkeyFromNpub, pubkeyOf, npubOf, secretFromNsec, wrap, unwrap, type Message, type MessageType, type Profile, type Outgoing, type Verification, type Attention } from "./nostr.ts";
import { triage, steer, scope, verify, attention, route, typesafeAsk, type Ask, type Steering } from "./decide.ts";
import { projectTimeline, attentionOf } from "./activity.ts";
import { uiHtml, uiCss, uiJs } from "./ui.ts";

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
  private running = new Map<string, { message: Stored; thread: Message[]; judging: Promise<void> }>();
  private cancelled = new Set<string>();
  private queued = new Map<string, Stored[]>();
  private profiles = new Map<string, Profile>();

  constructor(deps: Deps) {
    this.deps = deps;
    this.secret = secretFromNsec(deps.config.nsec);
    this.pubkey = pubkeyOf(this.secret);
    this.owner = deps.config.owner ? pubkeyFromNpub(deps.config.owner) : undefined;
    this.ask = deps.ask ?? ((state, questions) => typesafeAsk(state, questions, deps.config.judge));
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
      if (!m || this.deps.inbox.has(m.id)) return;
      if (m.to === this.pubkey) void this.onInbound(m).catch((e) => console.error("inbound failed", e));
      else if (m.from === this.pubkey && m.type !== "activity") this.deps.inbox.append(m, { read: true });
    });
  }

  stop(): void {
    for (const thread of this.running.keys()) this.cancelled.add(thread);
    this.queued.clear();
    this.stopSub?.();
    this.deps.handler?.close();
    this.deps.relay.close();
  }

  // sending

  private async emit(to: string, msg: Outgoing): Promise<string> {
    if (!msg.attention && ["answer", "done"].includes(msg.type)) {
      const thread = msg.thread ? this.deps.inbox.thread(msg.thread).filter(m =>
        (m.from === to && m.to === this.pubkey) || (m.from === this.pubkey && m.to === to)) : [];
      msg = {...msg, attention: await attention({ask: thread.find(m => m.type === "ask")?.text ?? "", output: msg.text, thread}, this.ask)};
    }
    msg = {...msg, attention: attentionOf({...msg, attention: msg.attention ?? (msg.type === "ask" && to !== this.owner ? "none" : undefined)})};
    const { wraps, id, message } = wrap(this.secret, to, msg);
    await this.deps.relay.publish(wraps);
    if (!this.deps.inbox.has(id)) this.deps.inbox.append(message, { read: true });
    await this.shareActivity(message);
    if (this.owner && this.owner !== this.pubkey && to !== this.owner && msg.attention === "now") this.notifyFn(`${msg.type}: ${msg.text.slice(0, 80)}`);
    return id;
  }

  private async shareActivity(message: Message | Stored): Promise<void> {
    if (!this.deps.config.share_activity || !this.owner || this.owner === this.pubkey || message.type === "activity" || message.to === this.owner) return;
    if (message.from === this.owner && !("triage" in message && message.triage) && !("steering" in message && message.steering)) return;
    const { wraps } = wrap(this.secret, this.owner, {
      type: "activity", thread: message.thread,
      text: JSON.stringify({ version: 1, updatedAt: Date.now(), message }),
    });
    await this.deps.relay.publish(wraps).catch(() => console.error("owner activity copy could not be delivered"));
  }

  /** Outcome to the sender, cc the owner unless the owner is the sender. */
  private async outcome(m: Stored, type: "done" | "cant", text: string, verification?: Verification, attention: Attention = "now"): Promise<void> {
    attention = attentionOf({type, verification, attention});
    await this.emit(m.from, { text, type, thread: m.thread, depth: m.depth + 1, verification, attention });
    if (this.owner && m.from !== this.owner) {
      if (!this.deps.config.share_activity) await this.emit(this.owner, { text: `[${type} for ${m.from.slice(0, 8)}] ${text}`, type, thread: m.thread, depth: m.depth + 1, verification, attention });
    }
  }

  private async escalate(m: Stored, reason: string): Promise<void> {
    if (!this.owner) return;
    await this.emit(this.owner, { text: `${reason}\nfrom ${npubOf(m.from)}\nthread ${m.thread}\n\n${m.text}`, type: "escalate", thread: m.thread, depth: m.depth + 1 });
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
    const s = this.deps.inbox.append(m, m.type === "activity" ? { read: true } : {});
    if (m.type === "activity") return;
    // Observation delivery must not delay admission/cancellation of the actual message.
    void this.shareActivity(s).catch(() => console.error("owner activity copy could not be delivered"));
    if (m.type === "cancel") {
      const root = this.deps.inbox.thread(m.thread)[0];
      if (root && root.id !== m.id && (m.from === this.owner || m.from === root.from)) {
        await this.cancelThread(m.thread);
        await this.outcome(root, "cant", "cancelled");
      }
      return;
    }
    if (!["ask", "answer", "done", "cant", "escalate"].includes(m.type)) {
      // Acknowledgments and reactions are feedback, never another agent turn.
      return;
    }
    if (m.depth >= this.deps.config.depthLimit) {
      if (m.type === "ask") await this.emit(m.from, { text: `refused: depth ${m.depth} reached the limit`, type: "cant", thread: m.thread, depth: m.depth + 1 });
      return;
    }
    if (!this.passesGate(m.from)) {
      if (this.deps.config.respond_to !== "allowlist") return;
      const { inScope } = await scope({ message: m, me: this.me }, this.ask).catch(() => ({ inScope: undefined }));
      this.deps.inbox.setTriage(m.id, { action: "escalate", confidence: 0, urgency: 1, inScope: inScope ?? 0, reason: "stranger" });
      await this.shareActivity(s);
      this.deps.inbox.park(m.id);
      const verdict = inScope === undefined ? "scope unknown, Jev unavailable" : `in scope ${inScope.toFixed(2)}`;
      await this.escalate(s, `consent needed: ${verdict}. Reply: sidecar allow ${npubOf(m.from)}`);
      return;
    }
    await this.dispatch(s);
  }

  private async dispatch(s: Stored): Promise<void> {
    if (!this.deps.handler) {
      // owner's own sidecar: nothing runs, the inbox is the surface
      if (attentionOf(s) === "now") this.notifyFn(`${s.type} from ${s.from.slice(0, 8)}: ${s.text.slice(0, 80)}`);
      return;
    }
    const active = this.running.get(s.thread);
    if (active) {
      this.queued.set(s.thread, [...(this.queued.get(s.thread) ?? []), s]);
      // Sharing a thread id does not let another peer redirect someone else's work.
      if (active.message.from !== s.from) return;
      // Judge in arrival order so a slow verdict cannot apply an older correction last.
      const judgment = active.judging.catch(() => {}).then(async () => {
        const ended: Steering = { action: "queue", reason: "original turn ended or was cancelled before the decision" };
        let decision = this.running.get(s.thread) === active && !this.cancelled.has(s.thread)
          ? await steer({ inFlight: active.message.text, message: s.text, thread: active.thread }, this.ask) : ended;
        const queue = this.queued.get(s.thread);
        if (this.running.get(s.thread) !== active || this.cancelled.has(s.thread) || !queue?.includes(s)) {
          decision = ended;
        } else if (decision.action === "interrupt") {
          this.cancelled.add(s.thread); // Suppress the superseded result, keeping the remaining queue.
          queue.splice(queue.indexOf(s), 1);
          queue.unshift(s);
        }
        this.deps.inbox.setSteering(s.id, decision);
        void this.shareActivity(s).catch(() => console.error("owner activity copy could not be delivered"));
        if (decision.action === "interrupt") {
          await this.deps.handler!.cancel(s.thread).catch(() => console.error("interrupt failed; waiting for the current turn to stop"));
        }
      });
      active.judging = judgment;
      await judgment;
      return;
    }
    const turn = { message: s, thread: [] as Message[], judging: Promise.resolve() };
    this.running.set(s.thread, turn); // Reserve before judging or running.
    try {
      const queued = new Set((this.queued.get(s.thread) ?? []).map(m => m.id));
      const thread = this.deps.inbox.thread(s.thread).filter(m => !queued.has(m.id) &&
        ["ask", "answer", "done", "cant", "escalate", "cancel"].includes(m.type) &&
        ((m.from === s.from && m.to === this.pubkey) || (m.from === this.pubkey && m.to === s.from)));
      turn.thread = thread;
      const t = await triage(
        { message: s, thread, sender: this.profiles.get(s.from), me: this.me, owner: s.from === this.owner, thresholds: this.deps.config.thresholds },
        this.ask,
      ).catch((e) => ({ action: "escalate" as const, confidence: 0, urgency: 1, inScope: 0, reason: `jev failed: ${e instanceof Error ? e.message : e}` }));
      if (this.cancelled.has(s.thread)) return;
      this.deps.inbox.setTriage(s.id, t);
      await this.shareActivity(s);
      if (this.cancelled.has(s.thread)) return;
      if (t.action === "ignore") return;
      if (t.action === "escalate") return this.escalate(s, `escalated: ${t.reason}`);
      await this.run(s, t.action, thread);
    } finally {
      this.running.delete(s.thread);
      this.cancelled.delete(s.thread);
      const queue = this.queued.get(s.thread);
      const next = queue?.shift();
      if (!queue?.length) this.queued.delete(s.thread);
      if (next) void this.dispatch(next).catch(e => console.error("queued message failed", e));
    }
  }

  private async run(s: Stored, mode: "act" | "ask", thread: Message[]): Promise<void> {
    const h = this.deps.handler!;
    if (mode === "act") await this.emit(s.from, { text: "accepted, working", type: "ack", thread: s.thread, depth: s.depth + 1 });
    if (this.cancelled.has(s.thread)) return;
    const body = [...thread.filter(m => m.id !== s.id).slice(-19), s]
      .map((m) => `[${m.type} from ${m.from === this.pubkey ? "me" : "them"}${m.id === s.id ? ", respond to this message" : ""}]\n${m.text}`).join("\n\n");
    const instruction = mode === "act"
      ? "Respond to the marked message using this conversation as context. Continue unfinished work when a reply supplies a missing detail. Do not repeat finished work. Reply with the result only."
      : "Do not do the task yet. Reply with exactly one clarifying question.";
    let out: { text: string; stopReason: string };
    try {
      out = await h.prompt(s.thread, `${body}\n\n${instruction}`);
    } catch (e) {
      if (this.cancelled.has(s.thread)) return;
      return this.outcome(s, "cant", `handler failed: ${e instanceof Error ? e.message : e}`);
    }
    if (this.cancelled.has(s.thread)) return;
    this.deps.inbox.saveSessions(h.sessionIds());
    if (out.stopReason !== "end_turn") return this.outcome(s, "cant", `stopped: ${out.stopReason}\n${out.text.slice(-2000)}`);
    // A clarifying question blocks progress and always needs attention.
    if (mode === "ask") { await this.emit(s.from, { text: out.text, type: "answer", thread: s.thread, depth: s.depth + 1, attention: "now" }); return; }
    let v;
    try { v = await verify({ ask: s.text, output: out.text, thread }, this.ask); }
    catch {
      if (this.cancelled.has(s.thread)) return;
      return this.outcome(s, "cant", `Jev verification unavailable; result needs review:\n${out.text}`, { status: "unavailable" });
    }
    if (this.cancelled.has(s.thread)) return;
    const verification: Verification = v.p === undefined ? { status: "skipped" } : { status: v.answersAsk ? "passed" : "failed", probability: v.p };
    await this.outcome(s, v.answersAsk ? "done" : "cant", v.answersAsk ? out.text : `output did not answer the ask (${v.p?.toFixed(2)}):\n${out.text.slice(-2000)}`, verification, v.attention);
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
    items = items.filter(s => s.to === this.pubkey && s.type !== "activity");
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
    const cancelled = await this.cancelThread(thread);
    if (root && root.from !== this.pubkey) await this.outcome(root, "cant", "cancelled by owner");
    return { cancelled };
  }

  private async cancelThread(thread: string): Promise<boolean> {
    const pending = this.running.has(thread);
    if (pending) this.cancelled.add(thread);
    this.queued.delete(thread);
    return (await this.deps.handler?.cancel(thread)) || pending;
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

  timeline() {
    return {
      me: { ...this.me, npub: npubOf(this.pubkey) }, profiles: [...this.profiles.values()].filter(p => p.pubkey !== this.pubkey),
      messages: projectTimeline(this.deps.inbox.all()).map(m => ({...m, attention: attentionOf(m)})), relays: this.deps.config.relays,
      sharing: { enabled: !!this.deps.config.share_activity, owner: this.deps.config.owner },
    };
  }

  async react(args: { id: string; text: string }): Promise<{ id: string }> {
    const target = this.timeline().messages.find(m => m.id === args.id && m.type !== "reaction");
    if (!target) throw new Error("unknown message");
    if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 32) throw new Error("reaction must be 1–32 characters");
    const to = target.from === this.pubkey ? target.to : target.from;
    const id = await this.emit(to, { type: "reaction", text: args.text.trim(), thread: target.thread, reactionTo: target.id });
    return { id };
  }

  /** The live config, so the CLI can persist changes made through tools (allow). */
  config(): Config { return this.deps.config; }
}

// localhost HTTP endpoint

export type Rpc = "send" | "inbox" | "reply" | "allow" | "cancel" | "find_agents" | "whoami" | "timeline" | "react";

export function serveHttp(daemon: Daemon, port: number): Promise<() => void> {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const address = server.address();
    const actualPort = address && typeof address !== "string" ? address.port : port;
    const host = req.headers.host ?? "";
    if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(host) ||
      (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) ||
      (req.headers["sec-fetch-site"] !== undefined && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))) return json(403, { error: "local, same-origin requests only" });
    const assets: Record<string, [string, string]> = { "/": ["text/html", uiHtml], "/ui.css": ["text/css", uiCss], "/ui.js": ["text/javascript", uiJs] };
    if (req.method === "GET" && Object.hasOwn(assets, req.url ?? "")) {
      const [type, body] = assets[req.url!];
      res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(body); return;
    }
    if (req.method === "GET" && req.url === "/health") return json(200, { ok: true, ...daemon.whoami() });
    if (req.method !== "POST" || req.url !== "/rpc") return json(404, { error: "not found" });
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 262144) return json(413, { error: "request too large" });
      }
      const { method, args = {} } = JSON.parse(raw) as { method: Rpc; args?: Record<string, unknown> };
      const calls: Record<Rpc, () => unknown> = {
        send: () => daemon.send(args as never),
        inbox: () => daemon.inbox(args as never),
        reply: () => daemon.reply(args as never),
        allow: () => daemon.allow(String(args.npub)),
        cancel: () => daemon.cancel(String(args.thread)),
        find_agents: () => daemon.findAgents(args.query as string | undefined),
        whoami: () => daemon.whoami(),
        timeline: () => daemon.timeline(),
        react: () => daemon.react(args as never),
      };
      const call = Object.hasOwn(calls, method) ? calls[method] : undefined;
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
