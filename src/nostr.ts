import { finalizeEvent, generateSecretKey, getPublicKey, validateEvent, verifyEvent, type Event } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";
import * as nip59 from "nostr-tools/nip59";
import { NAME } from "./config.ts";

export const KIND_PROFILE = 0;
export const KIND_DM = 14;
export const KIND_GIFT_WRAP = 1059;
/** Wrap timestamps are fuzzed up to 2 days back; subscriptions must reach at least this far. */
export const DM_FUZZ_WINDOW_S = 2 * 86_400;

export const MESSAGE_TYPES = ["ask", "ack", "answer", "done", "cant", "cancel", "escalate"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

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
  msg: { text: string; type: MessageType; thread?: string; depth?: number },
): { wraps: Event[]; id: string } {
  const tags: string[][] = [["p", to], ["type", msg.type]];
  if (msg.thread) tags.push(["e", msg.thread]);
  if (msg.depth) tags.push(["depth", String(msg.depth)]);
  const rumor = nip59.createRumor({ kind: KIND_DM, tags, content: msg.text }, secret);
  const self = getPublicKey(secret);
  const wraps = [to, self].map((pk) => nip59.createWrap(nip59.createSeal(rumor, secret, pk), pk) as Event);
  return { wraps, id: rumor.id };
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
  if (!rumor || rumor.kind !== KIND_DM) return undefined;
  const tag = (k: string) => rumor.tags.find((t) => t[0] === k)?.[1];
  const type = tag("type");
  const to = tag("p");
  if (!to || !MESSAGE_TYPES.includes(type as MessageType)) return undefined;
  return {
    id: rumor.id,
    thread: tag("e") ?? rumor.id,
    from: rumor.pubkey,
    to,
    type: type as MessageType,
    text: rumor.content,
    depth: Number(tag("depth") ?? 0),
    ts: rumor.created_at,
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
