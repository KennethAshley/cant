import { finalizeEvent, generateSecretKey, getPublicKey, validateEvent, verifyEvent, type Event } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";
import * as nip59 from "nostr-tools/nip59";
import { NAME } from "./config.ts";
import { z } from "zod";

export const KIND_PROFILE = 0;
export const KIND_DM = 14;
export const KIND_GIFT_WRAP = 1059;
/** Wrap timestamps are fuzzed up to 2 days back; subscriptions must reach at least this far. */
export const DM_FUZZ_WINDOW_S = 2 * 86_400;

export const MESSAGE_TYPES = ["ask", "ack", "answer", "done", "cant", "cancel", "escalate"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number] | "reaction" | "activity";
export const verificationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("passed"), probability: z.number().min(0).max(1) }),
  z.object({ status: z.literal("failed"), probability: z.number().min(0).max(1) }),
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("skipped") }),
]);
export type Verification = z.infer<typeof verificationSchema>;
export const attentionSchema = z.enum(["now", "later", "none"]);
export type Attention = z.infer<typeof attentionSchema>;
export type Outgoing = Pick<Message, "text" | "type"> & Partial<Pick<Message, "thread" | "depth" | "reactionTo" | "verification" | "attention">>;

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
  if (msg.depth) tags.push(["depth", String(msg.depth)]);
  const rumor = nip59.createRumor({ kind: msg.type === "reaction" ? 7 : KIND_DM, tags, content: msg.text }, secret);
  const self = getPublicKey(secret);
  const wraps = [to, self].map((pk) => nip59.createWrap(nip59.createSeal(rumor, secret, pk), pk) as Event);
  const message: Message = { id: rumor.id, thread: msg.thread ?? rumor.id, from: self, to, type: msg.type, text: msg.text, depth: msg.depth ?? 0, ts: rumor.created_at,
    ...(msg.reactionTo ? { reactionTo: msg.reactionTo } : {}), ...(msg.verification ? { verification: msg.verification } : {}), ...(msg.attention ? { attention: msg.attention } : {}) };
  return { wraps, id: rumor.id, message };
}

/** Decrypt and authenticate a gift wrap addressed to me. Undefined for anything not ours. */
function unwrapRumor(event: Event, secret: Uint8Array): Event | undefined {
  try {
    if (event.kind !== KIND_GIFT_WRAP || !verifyEvent(event)) return undefined;
    const seal: Event = JSON.parse(nip44.decrypt(event.content, nip44.getConversationKey(secret, event.pubkey)));
    if (seal.kind !== 13 || !verifyEvent(seal)) return undefined;
    const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(secret, seal.pubkey)));
    if (!validateEvent(rumor) || typeof rumor.id !== "string" || rumor.pubkey !== seal.pubkey) return undefined;
    return rumor as Event;
  } catch {
    return undefined;
  }
}

export function unwrap(event: Event, secret: Uint8Array): Message | undefined {
  const rumor = unwrapRumor(event, secret);
  if (!rumor || (rumor.kind !== KIND_DM && rumor.kind !== 7) || !validTimestamp(rumor.created_at)) return undefined;
  const tag = (k: string) => rumor.tags.find((t) => t[0] === k)?.[1];
  const type = rumor.kind === 7 ? "reaction" : tag("type");
  const to = tag("p");
  if (!to || ![...MESSAGE_TYPES, "reaction", "activity"].includes(type ?? "")) return undefined;
  const depth = Number(tag("depth") ?? 0);
  if (!Number.isSafeInteger(depth) || depth < 0) return undefined;
  const reactionTo = type === "reaction" ? tag("e") : undefined;
  if (type === "reaction" && (rumor.kind !== 7 || !reactionTo || !/^[0-9a-f]{64}$/.test(reactionTo) || !rumor.content.trim() || rumor.content.length > 32)) return undefined;
  let verification: Verification | undefined;
  const attention = attentionSchema.safeParse(tag("attention"));
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
  };
}

// profile

export function profileEvent(secret: Uint8Array, p: Omit<Profile, "pubkey">): Event {
  return finalizeEvent(
    {
      kind: KIND_PROFILE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["t", NAME]],
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

  /** Live subscription for gift wraps addressed to `pubkey`. Dedupes across relays. */
  subscribeInbox(pubkey: string, sinceS: number, onEvent: (ev: Event) => void): () => void {
    const seen = new Set<string>();
    const stops = [...new Set(this.urls)].map(url => {
      let stopped = false, delay = 1000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sub: ReturnType<SimplePool["subscribeMany"]> | undefined;
      const connect = () => {
        if (stopped) return;
        // Reissue the original filter: gift-wrap timestamps are randomized, not arrival cursors.
        sub = this.pool.subscribeMany([url],
          { kinds: [KIND_GIFT_WRAP], "#p": [pubkey], since: Math.max(0, sinceS - DM_FUZZ_WINDOW_S) }, {
            onevent: ev => {
              delay = 1000;
              if (stopped || seen.has(ev.id)) return;
              onEvent(ev);
              seen.add(ev.id);
            },
            // The pool also calls oneose on connection failure, so it cannot reset backoff.
            onclose: () => {
              if (stopped) return;
              timer = setTimeout(connect, delay);
              timer.unref();
              delay = Math.min(delay * 2, 30_000);
            },
          });
      };
      connect();
      return () => { stopped = true; clearTimeout(timer); sub?.close(); };
    });
    const stop = () => { stops.forEach(stop => stop()); this.subscriptions.delete(stop); };
    this.subscriptions.add(stop);
    return stop;
  }

  async findAgents(): Promise<Profile[]> {
    const events = await this.pool.querySync(this.urls, { kinds: [KIND_PROFILE], "#t": [NAME] }, { maxWait: 3000 });
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
