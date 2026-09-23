import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapEvent, createRumor, createSeal, createWrap } from "nostr-tools/nip59";
import {
  generateNsec, secretFromNsec, pubkeyOf, npubOf, pubkeyFromNpub,
  wrap, unwrap, profileEvent, parseProfile,
} from "../src/nostr.ts";

test("nsec and npub round-trip", () => {
  const nsec = generateNsec();
  const secret = secretFromNsec(nsec);
  const pk = pubkeyOf(secret);
  assert.equal(pubkeyFromNpub(npubOf(pk)), pk);
});

test("wrap then unwrap keeps text and every tag", () => {
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const { wraps, id } = wrap(a, pubkeyOf(b), { text: "hi", type: "ask", thread: "root1", depth: 2 });
  assert.equal(wraps.length, 2, "one wrap to peer, one to self");
  const got = unwrap(wraps[0], b);
  assert.ok(got);
  assert.equal(got.id, id);
  assert.equal(got.text, "hi");
  assert.equal(got.type, "ask");
  assert.equal(got.thread, "root1");
  assert.equal(got.depth, 2);
  assert.equal(got.from, pubkeyOf(a));
  assert.equal(got.to, pubkeyOf(b));
  const self = unwrap(wraps[1], a);
  assert.equal(self?.id, id);
});

test("first message of a thread uses its own id as thread", () => {
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const { wraps, id } = wrap(a, pubkeyOf(b), { text: "start", type: "ask" });
  const got = unwrap(wraps[0], b);
  assert.equal(got?.thread, id);
  assert.equal(got?.depth, 0);
});

test("encrypted attention labels round-trip; invalid labels leave the message visible", () => {
  const a = secretFromNsec(generateNsec()), b = secretFromNsec(generateNsec());
  for (const attention of ["now", "later", "none"] as const) {
    const {wraps, message} = wrap(a, pubkeyOf(b), {text: "result", type: "done", attention});
    assert.equal(unwrap(wraps[0], b)?.attention, attention);
    assert.equal(message.attention, attention);
  }
  const rumor = createRumor({kind: 14, content: "result", tags: [["p", pubkeyOf(b)], ["type", "done"], ["attention", "bogus"]]}, a);
  const message = unwrap(createWrap(createSeal(rumor, a, pubkeyOf(b)), pubkeyOf(b)), b);
  assert.equal(message?.text, "result");
  assert.equal(message?.attention, undefined);
});

test("unwrap returns undefined for a wrap not addressed to me", () => {
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const c = secretFromNsec(generateNsec());
  const { wraps } = wrap(a, pubkeyOf(b), { text: "x", type: "ask" });
  assert.equal(unwrap(wraps[0], c), undefined);
});

test("unwrap rejects an unknown type", () => {
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const { wraps } = wrap(a, pubkeyOf(b), { text: "x", type: "bogus" as never });
  assert.equal(unwrap(wraps[0], b), undefined);
});

test("profile event round-trips and carries the t tag", () => {
  const a = secretFromNsec(generateNsec());
  const ev = profileEvent(a, { name: "bot", about: "does things", capabilities: ["review", "docs"] });
  assert.equal(ev.kind, 0);
  assert.ok(ev.tags.some((t) => t[0] === "t" && t[1] === "sidecar"));
  const p = parseProfile(ev);
  assert.deepEqual(p, { pubkey: pubkeyOf(a), name: "bot", about: "does things", capabilities: ["review", "docs"] });
});

test("reactions use an encrypted kind 7 event tied to the exact message", () => {
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const target = "a".repeat(64);
  const thread = "b".repeat(64);
  const { wraps } = wrap(a, pubkeyOf(b), { text: "👍", type: "reaction", reactionTo: target, thread });
  assert.equal(wraps[0].kind, 1059);
  const rumor = unwrapEvent(wraps[0], b);
  assert.equal(rumor.kind, 7);
  assert.equal(rumor.content, "👍");
  assert.deepEqual(rumor.tags.find(t => t[0] === "e"), ["e", target]);
  assert.equal(unwrap(wraps[0], b)?.reactionTo, target);
  assert.equal(unwrap(wraps[0], b)?.thread, thread);
  assert.throws(() => wrap(a, pubkeyOf(b), { text: "👍", type: "reaction" }), /reaction target/);
});

test("rejects authenticated messages with timestamps outside the displayable range", () => {
  const a = secretFromNsec(generateNsec()), b = secretFromNsec(generateNsec());
  const rumor = createRumor({ kind: 14, content: "bad date", created_at: 8640000000001, tags: [["p", pubkeyOf(b)], ["type", "answer"]] }, a);
  const event = createWrap(createSeal(rumor, a, pubkeyOf(b)), pubkeyOf(b));
  assert.equal(unwrap(event, b), undefined);
});

test("invalid depths cannot bypass the conversation chain limit", () => {
  const a = secretFromNsec(generateNsec()), b = secretFromNsec(generateNsec());
  for (const depth of ["-1", "1.5", "NaN", "Infinity"]) {
    const rumor = createRumor({kind: 14, content: "reply", tags: [["p", pubkeyOf(b)], ["type", "answer"], ["depth", depth]]}, a);
    assert.equal(unwrap(createWrap(createSeal(rumor, a, pubkeyOf(b)), pubkeyOf(b)), b), undefined, depth);
  }
});

// relay

import type { Event } from "nostr-tools/pure";
import { Relay, __setWebSocketForTests, type Message } from "../src/nostr.ts";

class FakeSocket {
  static OPEN = 1;
  static store: Event[] = [];
  static sockets: FakeSocket[] = [];
  readyState = 1;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  subs = new Map<string, Record<string, unknown>>();
  constructor(url: string) {
    this.url = url;
    FakeSocket.sockets.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(raw: string) {
    const [verb, a, b] = JSON.parse(raw);
    if (verb === "EVENT") {
      FakeSocket.store.push(a);
      this.reply(["OK", a.id, true, ""]);
      for (const s of FakeSocket.sockets) for (const [id, f] of s.subs) if (matches(a, f)) s.reply(["EVENT", id, a]);
    } else if (verb === "REQ") {
      this.subs.set(a, b);
      for (const ev of FakeSocket.store) if (matches(ev, b)) this.reply(["EVENT", a, ev]);
      this.reply(["EOSE", a]);
    } else if (verb === "CLOSE") {
      this.subs.delete(a);
    }
  }
  reply(msg: unknown[]) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 0);
  }
  close() { this.readyState = 3; this.onclose?.({}); }
}
function matches(ev: Event, f: Record<string, unknown>): boolean {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (typeof f.since === "number" && ev.created_at < f.since) return false;
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith("#") || !Array.isArray(v)) continue;
    if (!ev.tags.some((t) => t[0] === k.slice(1) && v.includes(t[1]))) return false;
  }
  return true;
}

test("relay publishes, delivers to a live inbox subscription, and finds agents", async () => {
  __setWebSocketForTests(FakeSocket as unknown as typeof WebSocket);
  const a = secretFromNsec(generateNsec());
  const b = secretFromNsec(generateNsec());
  const relay = new Relay(["wss://fake.one", "wss://fake.two"]);

  const got: Message[] = [];
  const stop = relay.subscribeInbox(pubkeyOf(b), 0, (ev) => { const m = unwrap(ev, b); if (m) got.push(m); });

  const { wraps, id } = wrap(a, pubkeyOf(b), { text: "ping", type: "ask" });
  await relay.publish(wraps);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 1, "exactly one delivery even though two relays echoed it");
  assert.equal(got[0].id, id);

  await relay.publish([profileEvent(a, { name: "alice", about: "", capabilities: ["review"] })]);
  const agents = await relay.findAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "alice");

  stop();
  relay.close();
});
