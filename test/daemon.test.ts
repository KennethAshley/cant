import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Event } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { Daemon, serveHttp, type RelayLike, type HandlerLike } from "../src/daemon.ts";
import { Inbox } from "../src/inbox.ts";
import { defaultConfig, type Config } from "../src/config.ts";
import { generateNsec, secretFromNsec, pubkeyOf, npubOf, wrap, unwrap, type Message, type Profile } from "../src/nostr.ts";
import type { Ask, Answer } from "../src/decide.ts";

class FakeRelay implements RelayLike {
  subs: { pubkey: string; cb: (ev: Event) => void }[] = [];
  published: Event[] = [];
  profiles: Profile[] = [];
  async publish(events: Event[]) {
    this.published.push(...events);
    for (const ev of events) for (const s of this.subs) if (ev.tags.some((t) => t[0] === "p" && t[1] === s.pubkey)) setTimeout(() => s.cb(ev), 0);
  }
  subscribeInbox(pubkey: string, _since: number, cb: (ev: Event) => void) { this.subs.push({ pubkey, cb }); return () => {}; }
  async findAgents() { return this.profiles; }
  close() {}
  /** What a given secret's owner received, decrypted, in publish order. */
  received(secret: Uint8Array): Message[] {
    return this.published.map((ev) => unwrap(ev, secret)).filter((m): m is Message => !!m && m.to === pubkeyOf(secret));
  }
}

class FakeHandler implements HandlerLike {
  prompts: { thread: string; text: string }[] = [];
  reply = "did it";
  alive = true;
  async start() {}
  async prompt(thread: string, text: string) { this.prompts.push({ thread, text }); return { text: this.reply, stopReason: "end_turn" }; }
  async cancel() { return true; }
  sessionIds() { return {}; }
  close() {}
}

const choice = (c: string, confidence: number): Answer => ({ type: "choice", choice: c, confidence, probabilities: {} });
const score = (s: number): Answer => ({ type: "score", score: s, confidence: 1, probabilities: {}, legend: {} });
const noul = (p: number): Answer => ({ type: "noul", noul: p });
const actAsk: Ask = async (_s, q): Promise<Record<string, Answer> | null> => {
  if ("action" in q) return { action: choice("act", 0.95), urgency: score(1), in_scope: noul(0.9) };
  if ("answers_ask" in q) return { answers_ask: noul(0.9) };
  if ("in_scope" in q) return { in_scope: noul(0.8) };
  if ("route" in q) return { route: choice("none", 0.9) };
  return null;
};

function setup(over: Partial<Config> = {}, ask: Ask = actAsk) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-d-"));
  const me = secretFromNsec(generateNsec());
  const owner = secretFromNsec(generateNsec());
  const friend = secretFromNsec(generateNsec());
  const config = defaultConfig({ nsec: nip19.nsecEncode(me), name: "bot", capabilities: ["review"], owner: npubOf(pubkeyOf(owner)), allow: [pubkeyOf(friend)], ...over });
  const relay = new FakeRelay();
  const handler = new FakeHandler();
  const notes: string[] = [];
  const d = new Daemon({ config, relay, handler, inbox: new Inbox(dir), ask, notify: (t) => notes.push(t) });
  return { d, relay, handler, me, owner, friend, notes, config };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("known sender, act: ack, handler prompted, done to sender and owner", async () => {
  const { d, relay, handler, me, owner, friend } = setup();
  await d.start();
  await relay.publish(wrap(friend, pubkeyOf(me), { text: "review PR 7", type: "ask" }).wraps);
  await tick();
  assert.deepEqual(relay.received(friend).map((m) => m.type), ["ack", "done"]);
  assert.equal(handler.prompts.length, 1);
  assert.match(handler.prompts[0].text, /review PR 7/);
  assert.deepEqual(relay.received(owner).map((m) => m.type), ["done"]);
  d.stop();
});

test("stranger is parked, owner gets escalate, allow resumes it", async () => {
  const { d, relay, handler, me, owner, notes } = setup();
  const stranger = secretFromNsec(generateNsec());
  await d.start();
  await relay.publish(wrap(stranger, pubkeyOf(me), { text: "hey do a thing", type: "ask" }).wraps);
  await tick();
  assert.equal(handler.prompts.length, 0);
  assert.deepEqual(relay.received(owner).map((m) => m.type), ["escalate"]);
  assert.equal(notes.length, 1);
  const r = await d.allow(npubOf(pubkeyOf(stranger)));
  await tick();
  assert.equal(r.resumed, 1);
  assert.equal(handler.prompts.length, 1);
  assert.deepEqual(relay.received(stranger).map((m) => m.type), ["ack", "done"]);
  d.stop();
});

test("owner sender skips triage", async () => {
  const { d, relay, handler, me, owner } = setup({}, async () => null);
  await d.start();
  await relay.publish(wrap(owner, pubkeyOf(me), { text: "do it", type: "ask" }).wraps);
  await tick();
  assert.equal(handler.prompts.length, 1);
  assert.deepEqual(relay.received(owner).map((m) => m.type), ["ack", "done"]);
  d.stop();
});

test("verify false turns done into cant with output attached", async () => {
  const ask: Ask = async (s, q) => ("answers_ask" in q ? { answers_ask: noul(0.1) } : actAsk(s, q));
  const { d, relay, handler, me, friend } = setup({}, ask);
  handler.reply = "I could not";
  await d.start();
  await relay.publish(wrap(friend, pubkeyOf(me), { text: "x", type: "ask" }).wraps);
  await tick();
  const last = relay.received(friend).at(-1)!;
  assert.equal(last.type, "cant");
  assert.match(last.text, /I could not/);
  d.stop();
});

test("depth at the limit is refused with cant", async () => {
  const { d, relay, handler, me, friend } = setup();
  await d.start();
  await relay.publish(wrap(friend, pubkeyOf(me), { text: "loop", type: "ask", depth: 3 }).wraps);
  await tick();
  assert.equal(handler.prompts.length, 0);
  assert.deepEqual(relay.received(friend).map((m) => m.type), ["cant"]);
  d.stop();
});

test("cancel from the original sender sends cant", async () => {
  const { d, relay, handler, me, friend } = setup();
  handler.prompt = async () => { await tick(200); return { text: "late", stopReason: "cancelled" }; };
  await d.start();
  await relay.publish(wrap(friend, pubkeyOf(me), { text: "slow", type: "ask" }).wraps);
  await tick();
  const root = relay.received(friend)[0].thread; // the ack carries the thread id
  await relay.publish(wrap(friend, pubkeyOf(me), { text: "", type: "cancel", thread: root }).wraps);
  await tick(300);
  assert.ok(relay.received(friend).some((m) => m.type === "cant"));
  d.stop();
});

test("send with a recipient publishes an ask; without one and no route returns candidates", async () => {
  const { d, relay, friend } = setup();
  relay.profiles = [{ pubkey: pubkeyOf(friend), name: "f", about: "", capabilities: ["docs"] }];
  await d.start();
  const r = await d.send({ to: npubOf(pubkeyOf(friend)), text: "hi" });
  assert.ok("thread" in r);
  assert.equal(relay.received(friend)[0].type, "ask");
  const r2 = await d.send({ text: "hi" });
  assert.ok("candidates" in r2 && r2.candidates.length === 1);
  d.stop();
});

test("inbox waiting_on_me lists parked items; whoami", async () => {
  const { d, relay, me, config } = setup();
  const stranger = secretFromNsec(generateNsec());
  await d.start();
  await relay.publish(wrap(stranger, pubkeyOf(me), { text: "hey", type: "ask" }).wraps);
  await tick();
  assert.equal(d.inbox({ waiting_on_me: true }).length, 1);
  assert.equal(d.whoami().name, config.name);
  d.stop();
});

test("http rpc round-trips whoami and rejects unknown methods", async () => {
  const { d } = setup();
  await d.start();
  const stop = await serveHttp(d, 17777);
  const ok = await fetch("http://127.0.0.1:17777/rpc", { method: "POST", body: JSON.stringify({ method: "whoami", args: {} }) });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { result: { name: string } }).result.name, "bot");
  const bad = await fetch("http://127.0.0.1:17777/rpc", { method: "POST", body: JSON.stringify({ method: "nope" }) });
  assert.equal(bad.status, 400);
  const health = await fetch("http://127.0.0.1:17777/health");
  assert.equal(health.status, 200);
  stop();
  d.stop();
});
