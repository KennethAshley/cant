import { execFile } from "node:child_process";
import http from "node:http";
import type { Event } from "nostr-tools/pure";
import type { Config } from "./config.ts";
import { Inbox, type Stored } from "./inbox.ts";
import { pubkeyFromNpub, pubkeyOf, npubOf, secretFromNsec, wrap, unwrap, titleSchema, type Message, type MessageType, type Profile, type Outgoing, type Verification, type Attention } from "./nostr.ts";
import { triage, steer, scope, verify, attention, route, typesafeAsk, COMMUNICATION_POLICY, type Ask, type Steering } from "./decide.ts";
import { projectTimeline, attentionOf } from "./activity.ts";
import { uiHtml, uiCss, uiJs } from "./ui.ts";
import { KIND_WORKING, WORKING_TTL_MS, wrapWorking, unwrapWorking, type Working } from "./nostr.ts";
import { parseControl, controlActionSchema, type Control, type ControlAction } from "./nostr.ts";

export interface RelayLike {
  publish(events: Event[]): Promise<void>;
  publishEphemeral(events: Event[]): void;
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
  private stopped = false;
  private retryTimer?: ReturnType<typeof setInterval>;
  private deliveries = new Map<string, Promise<void>>();
  private retries = new Map<string, { attempts: number; at: number }>();
  private working = new Map<string, Working>();
  private workingTurns = new Map<string, Stored>();
  private workingTimer?: ReturnType<typeof setInterval>;

  constructor(deps: Deps) {
    this.deps = deps;
    this.secret = secretFromNsec(deps.config.nsec);
    this.pubkey = pubkeyOf(this.secret);
    this.owner = deps.config.owner ? pubkeyFromNpub(deps.config.owner) : undefined;
    this.ask = deps.ask ?? ((state, questions) => typesafeAsk(state, questions, deps.config.judge));
    this.notifyFn = deps.notify ?? ((text) => {
      const cmd = deps.config.notify;
      if (!cmd) return;
      execFile("/bin/sh", ["-c", cmd], { env: { ...process.env, MSG: text.replaceAll("\0", "").slice(0, 200) }, timeout: 5000 }, error => {
        if (error) console.error("notification could not be delivered");
      });
    });
  }

  private get me(): Profile {
    const c = this.deps.config;
    return { pubkey: this.pubkey, name: c.name, about: c.about, capabilities: c.capabilities };
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.deps.handler) await this.deps.handler.start();
    const box = this.deps.inbox;
    for (const s of box.all().filter(s => s.to === this.pubkey && s.type === "control" && s.work === "pending")) await this.handleControl(s, true);
    // Old inboxes have no work markers: never infer permission to replay historical tasks.
    const unfinished = box.all().filter(s => s.to === this.pubkey && s.work === "running");
    const interruptedThreads = new Set(unfinished.map(s => s.thread));
    for (const s of box.all()) {
      if ((s.work === "pending" || s.work === "preparing") && interruptedThreads.has(s.thread)) box.setWork(s.id, "interrupted");
    }
    for (const s of unfinished) {
      void this.outcome(s, "cant", "This task was interrupted by a Sidecar restart. Work may be partially complete. Review it before sending a new request; queued follow-ups in this thread were held for review.", undefined, "now", "interrupted").catch(e => console.error("recovery notice failed", e));
    }
    const pending = box.all().filter(s => s.to === this.pubkey && (s.work === "pending" || s.work === "preparing") && !s.parked);
    // Preserve the reserved turn (including a prioritized correction) ahead of its queue.
    pending.sort((a, b) => Number(b.work === "preparing") - Number(a.work === "preparing") || a.receivedAt - b.receivedAt);
    for (const s of pending) {
      void this.admit(s).catch(e => console.error("recovered message failed", e));
    }
    const flush = () => {
      for (const [id, events] of box.outbox()) void this.deliver(id, events).catch(e => console.error("outbox failed", e));
    };
    flush();
    this.retryTimer = setInterval(flush, 5000);
    this.retryTimer.unref();
    this.workingTimer = setInterval(() => {
      for (const message of this.workingTurns.values()) this.setWorking(message, true);
    }, 3000);
    this.workingTimer.unref();
    // ponytail: replay retained DM history and dedupe by inbox ID; paginate if history becomes too large.
    // New outgoing messages must not advance the cursor past unread messages sent during an outage.
    this.stopSub = this.deps.relay.subscribeInbox(this.pubkey, 0, (ev) => {
      if (this.stopped) return;
      if (ev.kind === KIND_WORKING) {
        const status = unwrapWorking(ev, this.secret);
        if (status && projectTimeline(this.deps.inbox.all()).some(m => m.id === status.message && m.thread === status.thread && m.to === status.from)) this.rememberWorking(status);
        return;
      }
      const m = unwrap(ev, this.secret);
      if (!m || this.deps.inbox.has(m.id)) return;
      if (m.to === this.pubkey) void this.onInbound(m).catch((e) => console.error("inbound failed", e));
      else if (m.from === this.pubkey && m.type !== "activity") this.deps.inbox.append(m, { read: true });
    });
  }

  stop(): void {
    for (const message of this.workingTurns.values()) this.setWorking(message, false);
    this.workingTurns.clear();
    this.working.clear();
    this.stopped = true;
    clearInterval(this.retryTimer);
    clearInterval(this.workingTimer);
    for (const thread of this.running.keys()) this.cancelled.add(thread);
    this.queued.clear();
    this.stopSub?.();
    this.deps.handler?.close();
    this.deps.relay.close();
  }

  // sending

  private rememberWorking(status: Working): void {
    for (const [id, entry] of this.working) if (Date.now() - entry.at >= WORKING_TTL_MS) this.working.delete(id);
    const id = status.from + ":" + status.message;
    if (status.at <= (this.working.get(id)?.at ?? -1)) return;
    this.working.delete(id);
    this.working.set(id, status); // Keep stop timestamps until expiry to reject delayed starts.
    if (this.working.size > 256) this.working.delete(this.working.keys().next().value!);
  }

  private setWorking(message: Stored, active: boolean): void {
    const previous = this.working.get(this.pubkey + ":" + message.id);
    const status: Working = {from: this.pubkey, thread: message.thread, message: message.id, active, at: Math.max(Date.now(), (previous?.at ?? 0) + 1)};
    this.rememberWorking(status);
    const recipients = new Set([message.from]);
    if (this.deps.config.share_activity && this.owner) recipients.add(this.owner);
    recipients.delete(this.pubkey);
    this.deps.relay.publishEphemeral([...recipients].map(to => wrapWorking(this.secret, to, status)));
  }

  private deliver(id: string, events: Event[]): Promise<void> {
    const active = this.deliveries.get(id);
    if (active) return active;
    if (this.stopped || Date.now() < (this.retries.get(id)?.at ?? 0)) return Promise.resolve();
    const delivery = (async () => {
      try { await this.deps.relay.publish(events); }
      catch (error) {
        const attempts = (this.retries.get(id)?.attempts ?? 0) + 1;
        this.retries.set(id, { attempts, at: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)) });
        console.error(`message ${id.slice(0, 8)} saved; delivery will retry:`, error instanceof Error ? error.message : error);
        return;
      }
      if (this.stopped) return; // A restart can safely repeat the same signed events.
      this.deps.inbox.delivered(id);
      this.retries.delete(id);
    })().finally(() => this.deliveries.delete(id));
    this.deliveries.set(id, delivery);
    return delivery;
  }

  private async emit(to: string, msg: Outgoing, complete?: { id: string; state: "finished" | "interrupted" }): Promise<string> {
    if (msg.thread && ["ask", "answer", "done", "cant", "escalate"].includes(msg.type)) {
      const titled = this.deps.inbox.thread(msg.thread).find(m => m.title && ["ask", "answer", "done", "cant", "escalate"].includes(m.type) &&
        ((m.from === to && m.to === this.pubkey) || (m.from === this.pubkey && m.to === to)));
      if (titled) msg = {...msg, title: titled.title};
    }
    if (!msg.attention && ["answer", "done"].includes(msg.type)) {
      const thread = msg.thread ? this.deps.inbox.thread(msg.thread).filter(m =>
        (m.from === to && m.to === this.pubkey) || (m.from === this.pubkey && m.to === to)) : [];
      msg = {...msg, attention: await attention({ask: thread.find(m => m.type === "ask")?.text ?? "", output: msg.text, thread}, this.ask)};
    }
    msg = {...msg, attention: attentionOf({...msg, attention: msg.attention ?? (msg.type === "ask" && to !== this.owner ? "none" : undefined)})};
    const { wraps, id, message } = wrap(this.secret, to, msg);
    this.deps.inbox.enqueue(message, wraps, complete);
    await Promise.all([this.deliver(id, wraps), this.shareActivity(message)]);
    if (this.owner && this.owner !== this.pubkey && to !== this.owner && msg.attention === "now") this.notifyFn(`${msg.type}: ${msg.text.slice(0, 80)}`);
    return id;
  }

  private async shareActivity(message: Message | Stored): Promise<void> {
    if (!this.deps.config.share_activity || !this.owner || this.owner === this.pubkey || ["activity", "control"].includes(message.type) || message.to === this.owner) return;
    if (message.from === this.owner && !("triage" in message && message.triage) && !("steering" in message && message.steering) && !("withheld" in message && message.withheld)) return;
    const { wraps, id, message: copy } = wrap(this.secret, this.owner, {
      type: "activity", thread: message.thread,
      text: JSON.stringify({ version: 1, updatedAt: Date.now(), message }),
    });
    this.deps.inbox.enqueue(copy, wraps);
    await this.deliver(id, wraps);
  }

  /** Outcome to the sender, cc the owner unless the owner is the sender. */
  private async outcome(m: Stored, type: "done" | "cant", text: string, verification?: Verification, attention: Attention = "now", state: "finished" | "interrupted" = "finished", title?: string): Promise<void> {
    attention = attentionOf({type, verification, attention});
    await Promise.all([
      this.emit(m.from, { text, type, thread: m.thread, depth: m.depth + 1, verification, attention, title }, {id: m.id, state}),
      this.owner && m.from !== this.owner && !this.deps.config.share_activity
        ? this.emit(this.owner, { text: `[${type} for ${m.from.slice(0, 8)}] ${text}`, type, thread: m.thread, depth: m.depth + 1, verification, attention, title }) : undefined,
    ]);
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
    const previous = this.deps.inbox.all();
    const s = this.deps.inbox.append(m, m.type === "control" ? {read: true, work: "pending"} : m.type === "activity" ? { read: true } :
      ["ask", "answer", "done", "cant", "escalate", "cancel"].includes(m.type) ? {work: "pending"} : {});
    if (m.type === "control") { await this.handleControl(s); return; }
    if (m.type === "activity") {
      const before = new Map(projectTimeline(previous).map(message => [message.id, message]));
      for (const message of projectTimeline([...previous, s])) {
        const old = before.get(message.id);
        if (message.triage?.action !== "unavailable" && attentionOf(message) === "now" && (!old || attentionOf(old) !== "now")) this.notifyFn(`${message.type}: ${message.text.slice(0, 160)}`);
      }
      return;
    }
    if (m.from !== this.pubkey && ["ask", "answer", "done", "cant", "escalate"].includes(m.type)) {
      const known = previous.some(message => message.type !== "activity" && (message.from === m.from || message.to === m.from));
      const sender = this.profiles.get(m.from)?.name || npubOf(m.from);
      if (!known) this.notifyFn(`New connection · ${sender}: ${m.text.slice(0, 100)}`);
      else if (!this.deps.handler && attentionOf(s) === "now") this.notifyFn(`${s.type} from ${sender}: ${s.text.slice(0, 100)}`);
    }
    // Observation delivery must not delay admission/cancellation of the actual message.
    void this.shareActivity(s).catch(() => console.error("owner activity copy could not be delivered"));
    await this.admit(s);
  }

  private async admit(s: Stored): Promise<void> {
    if (this.stopped) return;
    const m = s;
    if (m.type === "cancel") {
      const root = this.deps.inbox.thread(m.thread)[0];
      if (root && root.id !== m.id && (m.from === this.owner || m.from === root.from)) {
        await this.cancelThread(m.thread);
        await this.outcome(root, "cant", "cancelled");
      }
      this.deps.inbox.setWork(m.id, "finished");
      return;
    }
    if (!["ask", "answer", "done", "cant", "escalate"].includes(m.type)) {
      // Acknowledgments and reactions are feedback, never another agent turn.
      return;
    }
    if (m.depth >= this.deps.config.depthLimit) {
      if (m.type === "ask") await this.emit(m.from, { text: `refused: depth ${m.depth} reached the limit`, type: "cant", thread: m.thread, depth: m.depth + 1 });
      this.deps.inbox.setWork(m.id, "finished");
      return;
    }
    if (!this.passesGate(m.from)) {
      if (this.deps.config.respond_to !== "allowlist") { this.deps.inbox.setWork(m.id, "finished"); return; }
      const { inScope } = await scope({ message: m, me: this.me }, this.ask).catch(() => ({ inScope: undefined }));
      if (this.stopped || s.work === "finished") return;
      this.deps.inbox.setTriage(m.id, { action: "escalate", confidence: 0, urgency: 1, inScope: inScope ?? 0, reason: "stranger" });
      await this.shareActivity(s);
      this.deps.inbox.park(m.id);
      const verdict = inScope === undefined ? "scope unknown, Jev unavailable" : `in scope ${inScope.toFixed(2)}`;
      await this.escalate(s, `consent needed: ${verdict}. Reply: sidecar allow ${npubOf(m.from)}`);
      return;
    }
    if (!this.deps.inbox.isPaused(s.thread)) await this.dispatch(s);
  }

  private async dispatch(s: Stored): Promise<void> {
    if (this.stopped || this.deps.inbox.isPaused(s.thread) || s.work === "finished" || s.work === "interrupted") return;
    if (!this.deps.handler) {
      // owner's own sidecar: nothing runs, the inbox is the surface
      this.deps.inbox.setWork(s.id, "finished");
      return;
    }
    const active = this.running.get(s.thread);
    if (active) {
      this.queued.set(s.thread, [...(this.queued.get(s.thread) ?? []), s]);
      // Sharing a thread id does not let another peer redirect someone else's work.
      if (active.message.from !== s.from) return;
      // Judge in arrival order so a slow verdict cannot apply an older correction last.
      const judgment = active.judging.catch(() => {}).then(async () => {
        if (this.stopped) return;
        const ended: Steering = { action: "queue", reason: "original turn ended or was cancelled before the decision" };
        let decision = this.running.get(s.thread) === active && !this.cancelled.has(s.thread)
          ? await steer({ inFlight: active.message.text, message: s.text, thread: active.thread }, this.ask) : ended;
        if (this.stopped) return;
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
    this.deps.inbox.setWork(s.id, "preparing");
    this.running.set(s.thread, turn); // Reserve before judging or running.
    try {
      const queued = new Set(this.deps.inbox.thread(s.thread).filter(m => m.id !== s.id && m.work === "pending").map(m => m.id));
      const thread = this.deps.inbox.thread(s.thread).filter(m => !queued.has(m.id) &&
        ["ask", "answer", "done", "cant", "escalate", "cancel"].includes(m.type) &&
        ((m.from === s.from && m.to === this.pubkey) || (m.from === this.pubkey && m.to === s.from)));
      turn.thread = thread;
      const t = await triage(
        { message: s, thread, sender: this.profiles.get(s.from), me: this.me, owner: s.from === this.owner, thresholds: this.deps.config.thresholds },
        this.ask,
      ).catch((e) => ({ action: "unavailable" as const, confidence: 0, urgency: 1, inScope: 0, reason: String(e instanceof Error ? e.message : e).slice(0, 2000) }));
      if (this.stopped || this.cancelled.has(s.thread)) return;
      this.deps.inbox.setTriage(s.id, t);
      await this.shareActivity(s);
      if (this.stopped || this.cancelled.has(s.thread)) return;
      if (t.action === "escalate") await this.escalate(s, `escalated: ${t.reason}`);
      else if (t.action === "act" || t.action === "ask") await this.run(s, t.action, thread);
      if (!this.stopped) this.deps.inbox.setWork(s.id, "finished");
    } finally {
      if (!this.stopped && this.cancelled.has(s.thread) && s.work !== "pending") this.deps.inbox.setWork(s.id, "finished");
      this.running.delete(s.thread);
      this.cancelled.delete(s.thread);
      const queue = this.queued.get(s.thread);
      const next = queue?.shift();
      if (!queue?.length) this.queued.delete(s.thread);
      if (next && !this.stopped) void this.dispatch(next).catch(e => console.error("queued message failed", e));
    }
  }

  private async run(s: Stored, mode: "act" | "ask", thread: Message[]): Promise<void> {
    const h = this.deps.handler!;
    if (mode === "act") await this.emit(s.from, { text: "accepted, working", type: "ack", thread: s.thread, depth: s.depth + 1 });
    if (this.stopped || this.cancelled.has(s.thread)) return;
    const body = [...thread.filter(m => m.id !== s.id).slice(-19), s]
      .map((m) => `[${m.type} from ${m.from === this.pubkey ? "me" : "them"}${m.id === s.id ? ", respond to this message" : ""}]\n${m.text}`).join("\n\n");
    let instruction = mode === "act"
      ? "Respond to the marked message using this conversation as context. Continue unfinished work when a reply supplies a missing detail. Do not repeat finished work. Reply with the result only."
      : "Do not do the task yet. Reply with exactly one clarifying question.";
    instruction += "\nShared communication policy: " + COMMUNICATION_POLICY;
    let title = thread.find(m => m.title)?.title;
    if (!title) instruction += '\nBefore your reply, add one metadata line: <sidecar-title>A short title</sidecar-title>. Choose a 2–5 word conversation title (maximum 80 characters) based on the topic. Then a blank line and your normal reply. No other wrapper.';
    else instruction += '\nReply in plain text without title metadata.';
    let out: { text: string; stopReason: string };
    this.deps.inbox.setWork(s.id, "running");
    this.workingTurns.set(s.id, s);
    this.setWorking(s, true);
    try {
      out = await h.prompt(s.thread, `${body}\n\n${instruction}`);
    } catch (e) {
      if (this.stopped || this.cancelled.has(s.thread)) return;
      return this.outcome(s, "cant", `handler failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (this.workingTurns.delete(s.id)) this.setWorking(s, false);
    }
    if (this.stopped || this.cancelled.has(s.thread)) return;
    this.deps.inbox.saveSessions(h.sessionIds());
    if (out.stopReason !== "end_turn") return this.holdReply(s, out.text, `Agent stopped before completing its reply: ${out.stopReason}`);
    const metadata = out.text.match(/^\s*<sidecar-title>([^\r\n]*)<\/sidecar-title>\s*\r?\n([\s\S]+)$/);
    if (metadata && metadata[2].trim()) {
      title ??= titleSchema.safeParse(metadata[1]).data;
      out.text = metadata[2].trim();
    }
    let v;
    try { v = await verify({ ask: s.text, output: out.text, thread, clarification: mode === "ask" }, this.ask); }
    catch {
      if (this.stopped || this.cancelled.has(s.thread)) return;
      return this.holdReply(s, out.text, "Jev check unavailable; the draft has not been approved.", { status: "unavailable" }, title);
    }
    if (this.stopped || this.cancelled.has(s.thread)) return;
    const verification: Verification = v.p === undefined ? { status: "skipped" } : { status: v.answersAsk ? "passed" : "failed", probability: v.p };
    if (!v.communicationOK || !v.answersAsk) return this.holdReply(s, out.text, !v.communicationOK
      ? "The reply did not pass the shared communication policy, or exceeded the 20,000-character review limit."
      : "The reply did not answer the request.", v.p === undefined || v.answersAsk ? undefined : {status: "failed", probability: v.p}, title);
    // A clarifying question blocks progress and always needs attention.
    if (mode === "ask") { await this.emit(s.from, { text: out.text, type: "answer", thread: s.thread, depth: s.depth + 1, attention: "now", title }, {id: s.id, state: "finished"}); return; }
    await this.outcome(s, "done", out.text, verification, v.attention, "finished", title);
  }

  private async holdReply(s: Stored, text: string, reason: string, verification?: Verification, title?: string): Promise<void> {
    this.deps.inbox.setWithheld(s.id, {text: text.slice(0, 100_000), reason: reason + (text.length > 100_000 ? " Draft preview truncated to 100,000 characters." : "")});
    void this.shareActivity(s).catch(() => console.error("held reply owner copy failed"));
    await this.outcome(s, "cant", "Reply held for owner review. Awaiting new instructions.", verification, "now", "finished", title);
  }

  // tools

  async send(args: { to?: string; text: string; type?: MessageType; thread?: string }): Promise<{ thread: string; id: string; delivery: "pending" | "sent" } | { candidates: Profile[] }> {
    let to = args.to ? pubkeyFromNpub(args.to) : undefined;
    if (!to) {
      const candidates = await this.findAgents();
      const r = await route({ request: args.text, candidates, threshold: this.deps.config.thresholds.route }, this.ask).catch(() => ({ pubkey: undefined, confidence: 0 }));
      if (!r.pubkey) return { candidates };
      to = r.pubkey;
    }
    const id = await this.emit(to, { text: args.text, type: args.type ?? "ask", thread: args.thread });
    return { thread: args.thread ?? id, id, delivery: this.deps.inbox.get(id)!.delivery! };
  }

  inbox(args: { unread_only?: boolean; waiting_on_me?: boolean } = {}): Stored[] {
    const box = this.deps.inbox;
    let items = args.unread_only === false ? box.all() : box.unread();
    items = items.filter(s => s.to === this.pubkey && !["activity", "control"].includes(s.type));
    if (args.waiting_on_me) items = items.filter((s) => s.parked || s.withheld || s.type === "escalate" || s.work === "interrupted" || s.triage?.action === "unavailable");
    box.markRead(items.map((s) => s.id));
    return items;
  }

  async reply(args: { thread: string; text: string; type?: MessageType }): Promise<{ id: string; delivery: "pending" | "sent" }> {
    const root = this.deps.inbox.thread(args.thread)[0];
    if (!root) throw new Error(`unknown thread ${args.thread}`);
    const to = root.from === this.pubkey ? root.to : root.from;
    const id = await this.emit(to, { text: args.text, type: args.type ?? "answer", thread: args.thread });
    return { id, delivery: this.deps.inbox.get(id)!.delivery! };
  }

  async allow(npub: string): Promise<{ allowed: true; resumed: number }> {
    const pk = pubkeyFromNpub(npub);
    if (!this.deps.config.allow.includes(pk)) this.deps.config.allow.push(pk);
    const resumed = this.deps.inbox.unpark(pk);
    for (const s of resumed) { this.deps.inbox.setWork(s.id, "pending"); await this.admit(s); }
    return { allowed: true, resumed: resumed.length };
  }

  async cancel(thread: string): Promise<{ cancelled: boolean }> {
    const root = this.deps.inbox.thread(thread)[0];
    const cancelled = await this.cancelThread(thread);
    if (root && root.from !== this.pubkey) await this.outcome(root, "cant", "cancelled by owner");
    return { cancelled };
  }

  private async cancelThread(thread: string, holdQueue = false): Promise<boolean> {
    const pending = this.running.has(thread);
    if (pending) this.cancelled.add(thread);
    for (const s of this.deps.inbox.thread(thread)) {
      if (holdQueue && (s.work === "pending" || s.work === "preparing")) { this.deps.inbox.setWork(s.id, "pending"); continue; }
      if (s.work === "pending" || s.work === "preparing" || s.work === "running") this.deps.inbox.setWork(s.id, "finished");
    }
    this.queued.delete(thread);
    return (await this.deps.handler?.cancel(thread)) || pending;
  }

  private async sendControl(to: string, thread: string, control: Control): Promise<void> {
    const msg = {type: "control" as const, thread, text: JSON.stringify(control), attention: "none" as const};
    if (to !== this.pubkey) { await this.emit(to, msg); return; }
    const stored = this.deps.inbox.append(wrap(this.secret, to, msg).message, {read: true, work: control.kind === "command" ? "pending" : "finished"});
    if (control.kind === "command") await this.handleControl(stored);
  }

  private async handleControl(message: Stored, recovering = false): Promise<void> {
    const command = parseControl(message.text);
    if (command?.kind !== "command") { this.deps.inbox.setWork(message.id, "finished"); return; }
    const box = this.deps.inbox, root = box.thread(message.thread)[0];
    const owner = message.from === this.pubkey || message.from === this.owner;
    const authorized = owner || (command.action === "stop" && root?.from === message.from);
    const wasPaused = box.isPaused(message.thread);
    const paused = command.action === "pause" ? true : command.action === "resume" ? false : wasPaused;
    const accepted = authorized && command.at <= Date.now() + 60_000 &&
      box.setThreadControl(message.thread, message.from, command.at, message.id, paused, command.action);
    if (accepted) {
      if (command.action !== "resume") await this.cancelThread(message.thread, command.action === "pause");
      else if (!recovering && wasPaused) {
        const pending = box.thread(message.thread).filter(s => s.to === this.pubkey && s.work === "pending" && !s.parked);
        if (this.cancelled.has(message.thread)) this.queued.set(message.thread, pending);
        else for (const s of pending) void this.admit(s).catch(() => console.error("resumed message failed"));
      }
    }
    box.setWork(message.id, "finished");
    await this.sendControl(message.from, message.thread, {kind: "receipt", request: message.id, accepted, paused: box.isPaused(message.thread)});
  }

  async control(args: {thread: string; action: ControlAction}): Promise<{targets: string[]}> {
    const action = controlActionSchema.parse(args.action);
    const messages = projectTimeline(this.deps.inbox.all()).filter(m => m.thread === args.thread && m.type !== "reaction");
    if (!messages.length) throw new Error("unknown thread");
    const targets = [...new Set(messages.flatMap(m => [m.from, m.to]))].filter(pk => pk !== this.pubkey || !!this.deps.handler);
    const previous = this.deps.inbox.all().filter(m => m.type === "control" && m.from === this.pubkey && m.thread === args.thread)
      .map(m => parseControl(m.text)).filter(c => c?.kind === "command");
    const at = Math.max(Date.now(), ...previous.map(c => c!.at + 1));
    await Promise.all(targets.map(to => this.sendControl(to, args.thread, {kind: "command", action, at})));
    return {targets};
  }

  private controlStates() {
    const records = this.deps.inbox.all().filter(m => m.type === "control").map(m => ({m, c: parseControl(m.text)}));
    const latest = new Map<string, typeof records[number]>();
    for (const record of records) {
      const {m, c} = record;
      if (c?.kind !== "command" || m.from !== this.pubkey) continue;
      const key = m.thread + ":" + m.to, old = latest.get(key);
      if (!old || old.c?.kind !== "command" || c.at > old.c.at || (c.at === old.c.at && m.id > old.m.id)) latest.set(key, record);
    }
    const result: Record<string, {pubkey: string; action: ControlAction; accepted?: boolean; paused?: boolean; delivery?: string}[]> = {};
    for (const {m, c} of latest.values()) {
      if (c?.kind !== "command") continue;
      const receipt = records.find(r => r.m.from === m.to && r.m.to === this.pubkey && r.m.thread === m.thread && r.c?.kind === "receipt" && r.c.request === m.id)?.c;
      (result[m.thread] ??= []).push({pubkey: m.to, action: c.action, delivery: m.delivery,
        ...(receipt?.kind === "receipt" ? {accepted: receipt.accepted, paused: receipt.paused} : {})});
    }
    return result;
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
    for (const [id, status] of this.working) if (Date.now() - status.at >= WORKING_TTL_MS) this.working.delete(id);
    return {
      me: { ...this.me, npub: npubOf(this.pubkey) }, profiles: [...this.profiles.values()].filter(p => p.pubkey !== this.pubkey),
      messages: projectTimeline(this.deps.inbox.all()).map(m => ({...m, attention: attentionOf(m)})), relays: this.deps.config.relays,
      sharing: { enabled: !!this.deps.config.share_activity, owner: this.deps.config.owner },
      working: [...this.working.values()].filter(status => status.active),
      controls: this.controlStates(),
      paused: [...new Set(this.deps.inbox.all().map(m => m.thread))].filter(thread => this.deps.inbox.isPaused(thread)),
    };
  }

  async react(args: { id: string; text: string }): Promise<{ id: string; delivery: "pending" | "sent" }> {
    const target = this.timeline().messages.find(m => m.id === args.id && m.type !== "reaction");
    if (!target) throw new Error("unknown message");
    if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 32) throw new Error("reaction must be 1–32 characters");
    const to = target.from === this.pubkey ? target.to : target.from;
    const id = await this.emit(to, { type: "reaction", text: args.text.trim(), thread: target.thread, reactionTo: target.id });
    return { id, delivery: this.deps.inbox.get(id)!.delivery! };
  }

  /** The live config, so the CLI can persist changes made through tools (allow). */
  config(): Config { return this.deps.config; }
}

// localhost HTTP endpoint

export type Rpc = "send" | "inbox" | "reply" | "allow" | "cancel" | "control" | "find_agents" | "whoami" | "timeline" | "react";

export function serveHttp(daemon: Daemon, port: number, ready = () => true): Promise<() => void> {
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
    if (req.method === "GET" && req.url === "/health") return json(ready() ? 200 : 503, { ok: ready(), ...daemon.whoami() });
    if (!ready()) return json(503, { error: "agent is starting" });
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
        control: () => daemon.control(args as never),
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
