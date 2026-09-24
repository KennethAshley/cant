import { finalizeEvent, generateSecretKey, getPublicKey, validateEvent, verifyEvent, type Event } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";
import * as nip59 from "nostr-tools/nip59";
import { z } from "zod";

// Keep profile discovery compatible with existing Sidecar peers.
const PROFILE_TAG = "sidecar";
export const KIND_PROFILE = 0;
export const KIND_DM = 14;
export const KIND_GIFT_WRAP = 1059;
export const KIND_WORKING = 20002;
export const WORKING_TTL_MS = 8000;
/** Wrap timestamps are fuzzed up to 2 days back; subscriptions must reach at least this far. */
export const DM_FUZZ_WINDOW_S = 2 * 86_400;

export const MESSAGE_TYPES = ["ask", "ack", "answer", "done", "cant", "cancel", "escalate"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number] | "reaction" | "activity" | "control";
export const controlActionSchema = z.enum(["stop", "pause", "resume"]);
export type ControlAction = z.infer<typeof controlActionSchema>;
export const reviewActionSchema = z.enum(["approve", "deny"]);
export type ReviewAction = z.infer<typeof reviewActionSchema>;
const controlSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("command"), action: controlActionSchema, at: z.number().int().nonnegative().safe()}),
  z.object({kind: z.literal("review"), action: reviewActionSchema, request: z.string().regex(/^[0-9a-f]{64}$/)}),
  z.object({kind: z.literal("receipt"), request: z.string().regex(/^[0-9a-f]{64}$/), accepted: z.boolean(), paused: z.boolean()}),
]);
export type Control = z.infer<typeof controlSchema>;
export function parseControl(text: string): Control | undefined {
  if (text.length > 512) return;
  try { return controlSchema.parse(JSON.parse(text)); } catch { return undefined; }
}
export const verificationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("passed"), probability: z.number().min(0).max(1) }),
  z.object({ status: z.literal("failed"), probability: z.number().min(0).max(1) }),
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("skipped") }),
]);
export type Verification = z.infer<typeof verificationSchema>;
export const attentionSchema = z.enum(["now", "later", "none"]);
export type Attention = z.infer<typeof attentionSchema>;
export const titleSchema = z.string().regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/).trim().min(1).max(80);
export type Outgoing = Pick<Message, "text" | "type"> & Partial<Pick<Message, "thread" | "depth" | "reactionTo" | "verification" | "attention" | "title">>;

export function validTimestamp(seconds: number): boolean {
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8_640_000_000_000;
}

export interface Message {
  id: string;
  thread: string;
  from: string;
  to: string;
  type: MessageType;
  text: string;
  depth: number;
  /** Real timestamp in seconds, from the rumor, never the wrap. */
  ts: number;
  reactionTo?: string;
  verification?: Verification;
  attention?: Attention;
  title?: string;
}

export interface Profile {
  pubkey: string;
  name: string;
  about: string;
  capabilities: string[];
}

// keys

export function generateNsec(): string {
  return nip19.nsecEncode(generateSecretKey());
}
export function secretFromNsec(nsec: string): Uint8Array {
  const d = nip19.decode(nsec);
  if (d.type !== "nsec") throw new Error("not an nsec");
  return d.data;
}
export function pubkeyOf(secret: Uint8Array): string {
  return getPublicKey(secret);
}
export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}
export function pubkeyFromNpub(npub: string): string {
  if (/^[0-9a-f]{64}$/.test(npub)) return npub;
  const d = nip19.decode(npub);
  if (d.type !== "npub") throw new Error("not an npub");
  return d.data;
}

// messages
// Wrap and unwrap are fez's src/protocol/dm.ts with type, e, and depth tags and without group DMs.

export function wrap(
  secret: Uint8Array,
  to: string,
  msg: Outgoing,
): { wraps: Event[]; id: string; message: Message } {
  const tags: string[][] = [["p", to], ["type", msg.type]];
  if (msg.type === "reaction") {
    if (!msg.reactionTo || !/^[0-9a-f]{64}$/.test(msg.reactionTo)) throw new Error("invalid reaction target");
    if (!msg.text.trim() || msg.text.length > 32) throw new Error("reaction must be 1–32 characters");
    tags.push(["e", msg.reactionTo], ["k", String(KIND_DM)]);
    if (msg.thread) tags.push(["thread", msg.thread]);
  } else if (msg.thread) tags.push(["e", msg.thread]);
  if (msg.verification) tags.push(["verification", JSON.stringify(verificationSchema.parse(msg.verification))]);
  if (msg.attention) tags.push(["attention", attentionSchema.parse(msg.attention)]);
  const title = msg.title === undefined ? undefined : titleSchema.parse(msg.title);
  if (title) tags.push(["title", title]);
  if (msg.depth) tags.push(["depth", String(msg.depth)]);
  const rumor = nip59.createRumor({ kind: msg.type === "reaction" ? 7 : KIND_DM, tags, content: msg.text }, secret);
  const self = getPublicKey(secret);
  const wraps = [to, self].map((pk) => nip59.createWrap(nip59.createSeal(rumor, secret, pk), pk) as Event);
  const message: Message = { id: rumor.id, thread: msg.thread ?? rumor.id, from: self, to, type: msg.type, text: msg.text, depth: msg.depth ?? 0, ts: rumor.created_at,
    ...(msg.reactionTo ? { reactionTo: msg.reactionTo } : {}), ...(msg.verification ? { verification: msg.verification } : {}), ...(msg.attention ? { attention: msg.attention } : {}), ...(title ? {title} : {}) };
  return { wraps, id: rumor.id, message };
}

/** Decrypt and authenticate a gift wrap addressed to me. Undefined for anything not ours. */
function unwrapRumor(event: Event, secret: Uint8Array, kind = KIND_GIFT_WRAP): Event | undefined {
  try {
    if (event.kind !== kind || !verifyEvent(event)) return undefined;
    const seal: Event = JSON.parse(nip44.decrypt(event.content, nip44.getConversationKey(secret, event.pubkey)));
    if (seal.kind !== 13 || !verifyEvent(seal)) return undefined;
    const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(secret, seal.pubkey)));
    if (!validateEvent(rumor) || typeof rumor.id !== "string" || rumor.pubkey !== seal.pubkey) return undefined;
    return rumor as Event;
  } catch {
    return undefined;
  }
}

const workingSchema = z.object({
  thread: z.string().min(1).max(128), message: z.string().regex(/^[0-9a-f]{64}$/),
  active: z.boolean(), at: z.number().int().nonnegative().safe(),
});
export type Working = z.infer<typeof workingSchema> & { from: string };

/** Cant's private kind-20002 envelope: NIP-44 + signed seal, never a stored DM. */
export function wrapWorking(secret: Uint8Array, to: string, status: Omit<Working, "from">): Event {
  const rumor = nip59.createRumor({kind: KIND_WORKING, tags: [["p", to]], content: JSON.stringify(workingSchema.parse(status))}, secret);
  const seal = nip59.createSeal(rumor, secret, to);
  const outer = generateSecretKey();
  return finalizeEvent({kind: KIND_WORKING, created_at: Math.floor(Date.now() / 1000), tags: [["p", to]],
    content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(outer, to))}, outer);
}

export function unwrapWorking(event: Event, secret: Uint8Array, now = Date.now()): Working | undefined {
  try {
    if (event.kind !== KIND_WORKING || event.content.length > 4096 || !event.tags.some(t => t[0] === "p" && t[1] === getPublicKey(secret))) return;
    const rumor = unwrapRumor(event, secret, KIND_WORKING);
    if (!rumor || rumor.kind !== KIND_WORKING || !rumor.tags.some(t => t[0] === "p" && t[1] === getPublicKey(secret))) return;
    const status = workingSchema.parse(JSON.parse(rumor.content));
    if (status.at > now + 2000 || now - status.at >= WORKING_TTL_MS) return;
    return {...status, from: rumor.pubkey};
  } catch { return undefined; }
}

export function unwrap(event: Event, secret: Uint8Array): Message | undefined {
  const rumor = unwrapRumor(event, secret);
  if (!rumor || (rumor.kind !== KIND_DM && rumor.kind !== 7) || !validTimestamp(rumor.created_at)) return undefined;
  const tag = (k: string) => rumor.tags.find((t) => t[0] === k)?.[1];
  const type = rumor.kind === 7 ? "reaction" : tag("type");
  const to = tag("p");
  if (!to || ![...MESSAGE_TYPES, "reaction", "activity", "control"].includes(type ?? "")) return undefined;
  if (type === "control" && !parseControl(rumor.content)) return undefined;
  const depth = Number(tag("depth") ?? 0);
  if (!Number.isSafeInteger(depth) || depth < 0) return undefined;
  const reactionTo = type === "reaction" ? tag("e") : undefined;
  if (type === "reaction" && (rumor.kind !== 7 || !reactionTo || !/^[0-9a-f]{64}$/.test(reactionTo) || !rumor.content.trim() || rumor.content.length > 32)) return undefined;
  let verification: Verification | undefined;
  const attention = attentionSchema.safeParse(tag("attention"));
  const title = titleSchema.safeParse(tag("title"));
  if (tag("verification")) {
    try { verification = verificationSchema.parse(JSON.parse(tag("verification")!)); } catch { /* Ignore invalid optional evidence. */ }
  }
  return {
    id: rumor.id,
    thread: (type === "reaction" ? tag("thread") ?? reactionTo : tag("e")) ?? rumor.id,
    from: rumor.pubkey,
    to,
    type: type as MessageType,
    text: rumor.content,
    depth,
    ts: rumor.created_at,
    ...(reactionTo ? { reactionTo } : {}),
    ...(verification ? { verification } : {}),
    ...(attention.success ? { attention: attention.data } : {}),
    ...(title.success ? {title: title.data} : {}),
  };
}

// profile

export function profileEvent(secret: Uint8Array, p: Omit<Profile, "pubkey">): Event {
  return finalizeEvent(
    {
      kind: KIND_PROFILE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["t", PROFILE_TAG]],
      content: JSON.stringify({ name: p.name, about: p.about, capabilities: p.capabilities }),
    },
    secret,
  );
}

export function parseProfile(event: Event): Profile | undefined {
  try {
    if (event.kind !== KIND_PROFILE) return undefined;
    const c = JSON.parse(event.content);
    return {
      pubkey: event.pubkey,
      name: String(c.name ?? ""),
      about: String(c.about ?? ""),
      capabilities: Array.isArray(c.capabilities) ? c.capabilities.map(String) : [],
    };
  } catch {
    return undefined;
  }
}

// relay

import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";

export function __setWebSocketForTests(ws: typeof WebSocket): void {
  useWebSocketImplementation(ws);
}

export class Relay {
  private pool = new SimplePool({ enablePing: true });
  private subscriptions = new Set<() => void>();
  private urls: string[];
  constructor(urls: string[]) {
    this.urls = urls;
    this.pool.maxWaitForConnection = 5000;
  }

  /** Publish to every relay. Resolves if any relay accepts; rejects only if all refuse. */
  async publish(events: Event[]): Promise<void> {
    for (const ev of events) {
      const results = await Promise.allSettled(this.pool.publish(this.urls, ev));
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error(`no relay accepted event ${ev.id}: ${results.map((r) => (r as PromiseRejectedResult).reason).join("; ")}`);
      }
    }
  }

  /** Best effort on existing connections: no durable outbox, ACK wait, or replay. */
  publishEphemeral(events: Event[]): void {
    for (const [url, connected] of this.pool.listConnectionStatus()) {
      if (!connected) continue;
      void this.pool.ensureRelay(url, {abort: AbortSignal.timeout(500)}).then(async relay => {
        for (const event of events) if (relay.connected) await relay.send(JSON.stringify(["EVENT", event]));
      }).catch(() => {});
    }
  }

  /** Inbox + private ephemeral status. Only durable events need an ID history. */
  subscribeInbox(pubkey: string, sinceS: number, onEvent: (ev: Event) => void): () => void {
    const seen = new Set<string>();
    const stops = [...new Set(this.urls)].map(url => {
      let stopped = false, delay = 1000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sub: { close(): void } | undefined;
      const retry = () => {
        if (stopped) return;
        timer = setTimeout(connect, delay);
        timer.unref();
        delay = Math.min(delay * 2, 30_000);
      };
      const connect = async () => {
        if (stopped) return;
        // Reissue the original filter: gift-wrap timestamps are randomized, not arrival cursors.
        try {
          const relay = await this.pool.ensureRelay(url);
          if (stopped) return;
          // Direct subscription avoids SimplePool retaining every heartbeat ID forever.
          sub = relay.subscribe(
            [{ kinds: [KIND_GIFT_WRAP, KIND_WORKING], "#p": [pubkey], since: Math.max(0, sinceS - DM_FUZZ_WINDOW_S) }], {
              onevent: ev => {
                delay = 1000;
                if (stopped || seen.has(ev.id)) return;
                onEvent(ev);
                if (ev.kind !== KIND_WORKING) seen.add(ev.id);
              },
              onclose: retry,
            });
        } catch { retry(); }
      };
      void connect();
      return () => { stopped = true; clearTimeout(timer); sub?.close(); };
    });
    const stop = () => { stops.forEach(stop => stop()); this.subscriptions.delete(stop); };
    this.subscriptions.add(stop);
    return stop;
  }

  async findAgents(): Promise<Profile[]> {
    const events = await this.pool.querySync(this.urls, { kinds: [KIND_PROFILE], "#t": [PROFILE_TAG] }, { maxWait: 3000 });
    const latest = new Map<string, Event>();
    for (const ev of events) {
      const prev = latest.get(ev.pubkey);
      if (!prev || prev.created_at < ev.created_at) latest.set(ev.pubkey, ev);
    }
    return [...latest.values()].map(parseProfile).filter((p): p is Profile => !!p);
  }

  close(): void {
    for (const stop of this.subscriptions) stop();
    this.pool.close(this.urls);
  }
}
