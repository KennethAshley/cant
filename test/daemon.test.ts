import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Event } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { createRumor, createSeal, createWrap } from "nostr-tools/nip59";
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
  if ("action" in q) return { action: choice("act", 0.95), urgency: score(1), in_scope: noul(0.9), contradiction: noul(0) };
  if ("answers_ask" in q) return { answers_ask: noul(0.9) };
  if ("in_scope" in q) return { in_scope: noul(0.8) };
  if ("route" in q) return { route: choice("none", 0.9) };
  return null;
};

function setup(over: Partial<Config> = {}, ask: Ask = actAsk) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-d-"));
  const me = secretFromNsec(generateNsec());
  const owner = secretFromNsec(generateNsec());
  const friend = secretFromNsec(generateNsec());
  const config = defaultConfig({ nsec: nip19.nsecEncode(me), name: "bot", capabilities: ["review"], owner: npubOf(pubkeyOf(owner)), allow: [pubkeyOf(friend)], ...over });
  const relay = new FakeRelay();
  const handler = new FakeHandler();
  const notes: string[] = [];
  const box = new Inbox(dir);
  const d = new Daemon({ config, relay, handler, inbox: box, ask, notify: (t) => notes.push(t) });
  return { d, relay, handler, me, owner, friend, notes, config, box, dir };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("attention labels reach the peer and owner without suppressing agent work", async () => {
  for (const level of ["now", "later", "none"] as const) {
    const {d, relay, me, friend, owner, notes, handler} = setup({}, async (s, q) => {
      if ("answers_ask" in q) return {answers_ask: noul(0.9), needs_owner: noul(level === "none" ? 0.1 : 0.9), attention_urgency: choice(level, 0.9)};
      return actAsk(s, q);
    });
    try {
      await d.start();
      await relay.publish(wrap(friend, pubkeyOf(me), {text: "review", type: "ask", attention: "none"}).wraps);
      await tick(80);
      assert.equal(handler.prompts.length, 1, "owner attention is never agent admission");
      assert.equal(relay.received(friend).find(m => m.type === "ack")?.attention, "none");
      assert.equal(relay.received(friend).find(m => m.type === "done")?.attention, level);
      assert.equal(relay.received(owner).find(m => m.type === "done")?.attention, level);
      assert.equal(notes.length, level === "now" ? 1 : 0);
    } finally { d.stop(); }
  }
});

test("manual replies get attention labels; passive owner notifications respect them", async () => {
  const {d, config, relay, friend, owner} = setup({}, async (s, q) => {
    if ("needs_owner" in q) return {needs_owner: noul(0.9), attention_urgency: choice("later", 0.9)};
    return actAsk(s, q);
  });
  const notes: string[] = [];
  const ownerBox = new Inbox(fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-attention-owner-")));
  const ownerDaemon = new Daemon({config: defaultConfig({nsec: nip19.nsecEncode(owner), name: "owner", respond_to: "anyone"}), relay, inbox: ownerBox, notify: t => notes.push(t)});
  try {
    await ownerDaemon.start();
    await d.send({to: npubOf(pubkeyOf(owner)), text: "Optional review when convenient", type: "answer"});
    assert.equal(relay.received(owner).at(-1)?.attention, "later");
    const request = await d.send({to: npubOf(pubkeyOf(friend)), text: "review", type: "ask"});
    assert.ok("thread" in request);
    await d.reply({thread: request.thread, text: "Optional update", type: "done"});
    assert.equal(relay.received(friend).at(-1)?.attention, "later");
    await tick();
    assert.equal(notes.length, 0);
    await relay.publish(wrap(secretFromNsec(config.nsec), pubkeyOf(owner), {text: "blocked", type: "cant", attention: "none"}).wraps);
    await tick();
    assert.equal(notes.length, 1, "blockers stay visible even with a quiet tag");
    assert.equal(ownerDaemon.inbox().length, 2, "filtering never consumes or hides the harness inbox");
  } finally { d.stop(); ownerDaemon.stop(); }
});

test("shared Now replies notify once, including a clarification sent to a peer", async () => {
  const {d, relay, friend, me, notes} = setup({share_activity: true}, async (s, q) => {
    if ("action" in q) return {action: choice("ask", 0.99), urgency: score(1), in_scope: noul(0.9), contradiction: noul(0)};
    if ("needs_owner" in q) return {needs_owner: noul(0.9), attention_urgency: choice("now", 0.9)};
    return actAsk(s, q);
  });
  try {
    await d.start();
    await d.send({to: npubOf(pubkeyOf(friend)), type: "answer", text: "Requested result"});
    assert.equal(notes.length, 1);
    await relay.publish(wrap(friend, pubkeyOf(me), {type: "ask", text: "Review my code"}).wraps);
    await tick(80);
    assert.equal(notes.length, 2);
    assert.equal(relay.received(friend).at(-1)?.attention, "now");
  } finally { d.stop(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

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

test("a conflicting reply escalates to the owner without running the harness and remains visible", async () => {
  const { d, relay, me, owner, friend, handler } = setup({share_activity: true}, async (state, q) => {
    assert.ok("contradiction" in q, "check conflicts as part of triage");
    assert.ok(JSON.stringify(state).includes("requires authentication"));
    return {action: choice("act", 0.99), urgency: score(1), in_scope: noul(0.9), contradiction: noul(0.98)};
  });
  const ownerDaemon = new Daemon({config: defaultConfig({nsec: nip19.nsecEncode(owner), name: "owner", respond_to: "anyone"}),
    relay, inbox: new Inbox(fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-owner-"))), ask: actAsk, notify: () => {}});
  await d.start(); await ownerDaemon.start();
  try {
    const sent = await d.send({to: npubOf(pubkeyOf(friend)), type: "answer", text: "The endpoint requires authentication"});
    assert.ok("thread" in sent);
    const reply = wrap(friend, pubkeyOf(me), {type: "answer", thread: sent.thread, text: "That same endpoint requires no authentication"});
    await relay.publish(reply.wraps); await tick(120);
    assert.equal(handler.prompts.length, 0);
    assert.equal(ownerDaemon.timeline().messages.find(m => m.id === reply.id)?.triage?.contradiction, 0.98);
    const escalations = relay.received(owner).filter(m => m.type === "escalate");
    assert.equal(escalations.length, 1);
    assert.match(escalations[0].text, /contradiction/i);
    assert.ok(!relay.received(friend).some(m => ["ack", "done", "cant"].includes(m.type)));
  } finally { d.stop(); ownerDaemon.stop(); }
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

test("owner request still runs when no judge is configured", async () => {
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

test("a starting daemon claims its identity but refuses RPC work until its harness is ready", async () => {
  const { d, config, me } = setup();
  let ready = false;
  const stop = await serveHttp(d, 17779, () => ready);
  try {
    const health = await fetch("http://127.0.0.1:17779/health");
    assert.equal(health.status, 503);
    assert.equal((await health.json()).npub, d.whoami().npub);
    const change = await fetch("http://127.0.0.1:17779/rpc", { method: "POST", body: JSON.stringify({ method: "allow", args: { npub: npubOf(pubkeyOf(me)) } }) });
    assert.equal(change.status, 503);
    assert.ok(!config.allow.includes(pubkeyOf(me)));
    ready = true;
    assert.equal((await fetch("http://127.0.0.1:17779/health")).status, 200);
  } finally { stop(); d.stop(); }
});

test("timeline keeps both sides across restart without consuming unread messages", async () => {
  const { d, relay, me, friend, dir } = setup({}, async (s, q) => "action" in q
    ? { action: choice("ignore", 0.99), urgency: score(0), in_scope: noul(0.9), contradiction: noul(0) } : actAsk(s, q));
  await d.start();
  try {
    const sent = await d.send({ to: npubOf(pubkeyOf(friend)), text: "review this", type: "answer" });
    assert.ok("thread" in sent);
    await relay.publish(wrap(friend, pubkeyOf(me), { text: "looks good", type: "answer", thread: sent.thread }).wraps);
    await tick();
    assert.deepEqual(d.timeline().messages.map(m => m.text), ["review this", "looks good"]);
    assert.equal(d.inbox().length, 1, "viewing history must not mark incoming messages read");
    assert.equal(new Inbox(dir).all().length, 2, "sent messages survive restart");
    await d.reply({ thread: sent.thread, text: "thanks" });
    assert.equal(relay.received(friend).at(-1)?.text, "thanks");
  } finally { d.stop(); }
});

test("owner acknowledgments are judged and can stay quiet", async () => {
  const { d, relay, me, owner, handler, box } = setup({}, async (s, q) => "action" in q
    ? { action: choice("ignore", 0.99), urgency: score(0), in_scope: noul(0.1), contradiction: noul(0) } : actAsk(s, q));
  await d.start();
  try {
    const incoming = wrap(owner, pubkeyOf(me), { type: "ask", text: "Thanks, that is all" });
    await relay.publish(incoming.wraps); await tick(80);
    assert.equal(handler.prompts.length, 0);
    assert.equal(box.thread(incoming.id)[0].triage?.action, "ignore");
    assert.equal(relay.received(owner).length, 0);
  } finally { d.stop(); }
});

test("the owner sees Jev's quiet decision on their own message", async () => {
  const { d, relay, me, owner, handler } = setup({ share_activity: true }, async (s, q) => "action" in q
    ? { action: choice("ignore", 0.99), urgency: score(0), in_scope: noul(0.1), contradiction: noul(0) } : actAsk(s, q));
  const ownerDaemon = new Daemon({
    config: defaultConfig({ nsec: nip19.nsecEncode(owner), name: "owner" }), relay,
    inbox: new Inbox(fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-owner-"))), notify: () => {},
  });
  await ownerDaemon.start(); await d.start();
  try {
    const sent = await ownerDaemon.send({ to: npubOf(pubkeyOf(me)), type: "answer", text: "Thanks, all done" });
    assert.ok("id" in sent);
    await tick(100);
    const messages = ownerDaemon.timeline().messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, sent.id);
    assert.equal(messages[0].triage?.action, "ignore");
    assert.equal(messages[0].observedBy, undefined, "keep the owner's original message");
    assert.equal(handler.prompts.length, 0);
  } finally { d.stop(); ownerDaemon.stop(); }
});

for (const type of ["answer", "done", "cant"] as const) test(`Jev can continue a ${type} with the original conversation context`, async () => {
  let verificationState: { thread?: {text: string}[] } | undefined;
  const { d, relay, me, friend, handler, box } = setup({}, async (s, q) => {
    if ("answers_ask" in q) verificationState = s as typeof verificationState;
    return actAsk(s, q);
  });
  await d.start();
  try {
    const sent = await d.send({ to: npubOf(pubkeyOf(friend)), type: "ask", text: "Review the parser" });
    assert.ok("thread" in sent);
    const incoming = wrap(friend, pubkeyOf(me), { type, text: "Use src/parser.ts", thread: sent.thread, depth: 1 });
    await relay.publish(incoming.wraps); await tick(80);
    assert.equal(handler.prompts.length, 1);
    assert.match(handler.prompts[0].text, /Review the parser/);
    assert.match(handler.prompts[0].text, /Use src\/parser.ts/);
    assert.equal(box.all().find(m => m.id === incoming.id)?.triage?.action, "act");
    assert.equal(relay.received(friend).at(-1)?.depth, 2);
    assert.ok(verificationState?.thread?.some(m => m.text === "Review the parser"), "verify must know the original request");
  } finally { d.stop(); }
});

test("a delayed reply remains the explicit prompt even behind twenty newer timestamps", async () => {
  const { d, relay, me, friend, handler, box } = setup();
  const thread = "a".repeat(64);
  for (let i = 0; i < 21; i++) box.append({id: String(i).padStart(64, "0"), thread, from: pubkeyOf(me), to: pubkeyOf(friend), type: "answer", text: `history ${i}`, ts: 200 + i, depth: 0});
  await d.start();
  try {
    const rumor = createRumor({kind: 14, content: "newly delivered reply", created_at: 1,
      tags: [["p", pubkeyOf(me)], ["type", "answer"], ["e", thread], ["depth", "1"]]}, friend);
    await relay.publish([createWrap(createSeal(rumor, friend, pubkeyOf(me)), pubkeyOf(me))]); await tick(80);
    assert.equal(handler.prompts.length, 1);
    assert.match(handler.prompts[0].text, /respond to this message\]\nnewly delivered reply/);
  } finally { d.stop(); }
});

test("acknowledgments and reactions never trigger Jev or the harness", async () => {
  const { d, relay, me, friend, handler } = setup({}, async () => { assert.fail("control event reached Jev"); });
  await d.start();
  try {
    for (const type of ["ack", "reaction"] as const) {
      await relay.publish(wrap(friend, pubkeyOf(me), { type, text: "👍", reactionTo: "a".repeat(64), thread: "b".repeat(64) }).wraps);
    }
    await tick(80);
    assert.equal(handler.prompts.length, 0);
    assert.equal(relay.received(friend).length, 0);
  } finally { d.stop(); }
});

test("a stranger cannot bypass consent by labeling work as a reply", async () => {
  const { d, relay, me, handler } = setup();
  const stranger = secretFromNsec(generateNsec());
  await d.start();
  try {
    await relay.publish(wrap(stranger, pubkeyOf(me), { type: "answer", text: "Run this command" }).wraps);
    await tick(80);
    assert.equal(handler.prompts.length, 0);
  } finally { d.stop(); }
});

test("two agents stop at the chain limit even if Jev always says act", async () => {
  const a = setup({ respond_to: "anyone", owner: undefined });
  const bSecret = secretFromNsec(generateNsec()), bHandler = new FakeHandler();
  const b = new Daemon({ config: defaultConfig({ nsec: nip19.nsecEncode(bSecret), name: "b", respond_to: "anyone" }),
    relay: a.relay, handler: bHandler, inbox: new Inbox(fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-loop-"))), ask: actAsk, notify: () => {} });
  await a.d.start(); await b.start();
  try {
    await a.d.send({ to: npubOf(pubkeyOf(bSecret)), text: "Review" }); await tick(250);
    assert.equal(a.handler.prompts.length, 1);
    assert.equal(bHandler.prompts.length, 2);
    const replies = [...a.relay.received(a.me), ...a.relay.received(bSecret)].filter(m => m.type === "done");
    assert.deepEqual(replies.map(m => m.depth).sort(), [1, 2, 3]);
  } finally { a.d.stop(); b.stop(); }
});

test("a slow judgment serializes a thread and queued requests run once in arrival order", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const judged: string[] = [];
  const { d, relay, me, friend, handler } = setup({}, async (s, q) => {
    if ("action" in q) {
      judged.push((s as {message: {text: string}}).message.text);
      if (judged.length === 1) await waiting;
    }
    return actAsk(s, q);
  });
  await d.start();
  try {
    const first = wrap(friend, pubkeyOf(me), { type: "ask", text: "first request" });
    await relay.publish(first.wraps); await tick();
    await relay.publish(wrap(friend, pubkeyOf(me), { type: "ask", text: "second request", thread: first.id }).wraps); await tick();
    assert.deepEqual(judged, ["first request"]);
    release(); await tick(100);
    assert.deepEqual(judged, ["first request", "second request"]);
    assert.equal(handler.prompts.length, 2);
    assert.equal(handler.prompts[1].text.match(/second request/g)?.length, 1);
  } finally { release(); d.stop(); }
});

test("Jev interrupts for a correction, preserves queued work, and never publishes the superseded result", async () => {
  const firstTurn = deferred();
  const started = deferred();
  const { d, relay, me, owner, handler, box, dir } = setup({ share_activity: true }, async (state, q) => {
    if ("changes_work" in q) {
      const input = state as { in_flight: string; new_message: string };
      assert.equal(input.in_flight, "Write the detailed report");
      return { changes_work: noul(input.new_message.startsWith("Actually") ? 0.95 : 0.1) };
    }
    return actAsk(state, q);
  });
  let cancellations = 0, active = 0, maxActive = 0;
  handler.prompt = async (thread, text) => {
    handler.prompts.push({ thread, text }); maxActive = Math.max(maxActive, ++active);
    const first = handler.prompts.length === 1;
    if (first) { started.resolve(); await firstTurn.promise; }
    active--;
    return { text: first ? "obsolete report" : "updated result", stopReason: "end_turn" };
  };
  handler.cancel = async () => { cancellations++; firstTurn.resolve(); return true; };
  await d.start();
  try {
    const first = wrap(owner, pubkeyOf(me), { type: "ask", text: "Write the detailed report" });
    await relay.publish(first.wraps); await started.promise;
    const aside = wrap(owner, pubkeyOf(me), { type: "answer", thread: first.id, text: "Also, a separate question for later" });
    await relay.publish(aside.wraps); await tick(60);
    assert.equal(cancellations, 0);
    assert.equal(handler.prompts.length, 1);
    const correction = wrap(owner, pubkeyOf(me), { type: "answer", thread: first.id, text: "Actually, just give me one sentence" });
    await relay.publish(correction.wraps); await tick(150);
    assert.equal(cancellations, 1);
    assert.equal(maxActive, 1, "wait for the interrupted prompt to stop before starting another");
    assert.equal(handler.prompts.length, 3);
    assert.match(handler.prompts[1].text, /Write the detailed report/);
    assert.match(handler.prompts[1].text, /Actually, just give me one sentence/);
    assert.ok(!handler.prompts[1].text.includes(aside.message.text), "queued work must not leak into the correction turn");
    assert.match(handler.prompts[2].text, /separate question for later/);
    assert.ok(!relay.received(owner).some(m => m.type === "cant" || m.text === "obsolete report"));
    assert.equal(box.thread(first.id).find(m => m.id === aside.id)?.steering?.action, "queue");
    assert.equal(new Inbox(dir).thread(first.id).find(m => m.id === correction.id)?.steering?.action, "interrupt");
    const copy = relay.received(owner).filter(m => m.type === "activity").map(m => JSON.parse(m.text).message).find(m => m.id === correction.id && m.steering);
    assert.equal(copy?.steering?.action, "interrupt");
  } finally { firstTurn.resolve(); d.stop(); }
});

test("a late interrupt decision cannot cancel the next turn", async () => {
  const firstTurn = deferred(), laterTurn = deferred(), judgment = deferred();
  const started = deferred();
  const { d, relay, me, owner, handler } = setup({}, async (s, q) => {
    if ("changes_work" in q) { await judgment.promise; return { changes_work: noul(0.99) }; }
    return actAsk(s, q);
  });
  let cancellations = 0;
  handler.cancel = async () => { cancellations++; return true; };
  handler.prompt = async (thread, text) => {
    handler.prompts.push({thread, text}); started.resolve();
    await (handler.prompts.length === 1 ? firstTurn.promise : laterTurn.promise);
    return {text: "done", stopReason: "end_turn"};
  };
  await d.start();
  try {
    const first = wrap(owner, pubkeyOf(me), {type: "ask", text: "Original task"});
    await relay.publish(first.wraps); await started.promise;
    await relay.publish(wrap(owner, pubkeyOf(me), {type: "answer", text: "Correction", thread: first.id}).wraps);
    await tick(60);
    firstTurn.resolve(); await tick(60);
    assert.equal(handler.prompts.length, 2);
    judgment.resolve(); await tick(60);
    assert.equal(cancellations, 0);
    assert.equal(d.timeline().messages.filter(m => m.steering).length, 1, "the stale decision is recorded as queued");
  } finally { firstTurn.resolve(); laterTurn.resolve(); judgment.resolve(); d.stop(); }
});

test("overlapping correction judgments cannot apply an older correction after a newer one", async () => {
  const original = deferred(), firstCorrection = deferred(), judgment = deferred(), started = deferred();
  const { d, relay, me, owner, handler } = setup({}, async (s, q) => {
    if ("changes_work" in q) {
      if ((s as { new_message: string }).new_message === "Use blue") await judgment.promise;
      return { changes_work: noul(0.99) };
    }
    return actAsk(s, q);
  });
  handler.prompt = async (thread, text) => {
    handler.prompts.push({thread, text}); started.resolve();
    if (handler.prompts.length === 1) await original.promise;
    else if (handler.prompts.length === 2) await firstCorrection.promise;
    return {text: "done", stopReason: "end_turn"};
  };
  handler.cancel = async () => { original.resolve(); return true; };
  await d.start();
  try {
    const first = wrap(owner, pubkeyOf(me), {type: "ask", text: "Use red"});
    await relay.publish(first.wraps); await started.promise;
    await relay.publish(wrap(owner, pubkeyOf(me), {type: "answer", text: "Use blue", thread: first.id}).wraps); await tick();
    await relay.publish(wrap(owner, pubkeyOf(me), {type: "answer", text: "Use green", thread: first.id}).wraps); await tick();
    judgment.resolve(); await tick(60);
    assert.match(handler.prompts[1]?.text ?? "", /respond to this message\]\nUse blue/);
    firstCorrection.resolve(); await tick(60);
    assert.equal(handler.prompts.length, 3);
    assert.match(handler.prompts[2].text, /respond to this message\]\nUse green/);
  } finally { original.resolve(); firstCorrection.resolve(); judgment.resolve(); d.stop(); }
});

test("explicit cancellation wins over a pending interrupt judgment", async () => {
  const turn = deferred(), started = deferred(), judgment = deferred();
  const { d, relay, me, owner, handler } = setup({}, async (s, q) => {
    if ("changes_work" in q) { await judgment.promise; return {changes_work: noul(0.99)}; }
    return actAsk(s, q);
  });
  let cancellations = 0;
  handler.prompt = async (thread, text) => {
    handler.prompts.push({thread, text}); started.resolve(); await turn.promise;
    return {text: "obsolete", stopReason: "end_turn"};
  };
  handler.cancel = async () => { cancellations++; turn.resolve(); return true; };
  await d.start();
  try {
    const first = wrap(owner, pubkeyOf(me), {type: "ask", text: "Original"});
    await relay.publish(first.wraps); await started.promise;
    await relay.publish(wrap(owner, pubkeyOf(me), {type: "answer", text: "Correction", thread: first.id}).wraps); await tick();
    await d.cancel(first.id); judgment.resolve(); await tick(60);
    assert.equal(handler.prompts.length, 1);
    assert.equal(cancellations, 1);
    assert.ok(!relay.received(owner).some(m => m.type === "done"));
  } finally { turn.resolve(); judgment.resolve(); d.stop(); }
});

test("another allowed peer cannot interrupt a task by reusing its thread id", async () => {
  const turn = deferred(), started = deferred();
  const { d, relay, me, owner, friend, handler } = setup({}, async (s, q) => {
    assert.ok(!("changes_work" in q), "another peer's message must not reach the interrupt judge");
    return actAsk(s, q);
  });
  let cancellations = 0;
  handler.prompt = async (thread, text) => {
    handler.prompts.push({thread, text}); started.resolve(); await turn.promise;
    return {text: "done", stopReason: "end_turn"};
  };
  handler.cancel = async () => { cancellations++; return true; };
  await d.start();
  try {
    const first = wrap(owner, pubkeyOf(me), {type: "ask", text: "Owner task"});
    await relay.publish(first.wraps); await started.promise;
    await relay.publish(wrap(friend, pubkeyOf(me), {type: "answer", text: "Actually do mine", thread: first.id}).wraps); await tick(60);
    assert.equal(cancellations, 0);
    assert.equal(handler.prompts.length, 1);
  } finally { turn.resolve(); d.stop(); }
});

test("interrupt judgment includes the original task when work started from a clarification reply", async () => {
  const turn = deferred(), started = deferred();
  let steeringState: {in_flight: string; thread?: {text: string}[]} | undefined;
  const { d, relay, me, owner, handler } = setup({}, async (s, q) => {
    if ("changes_work" in q) { steeringState = s as typeof steeringState; return {changes_work: noul(0.99)}; }
    if ("action" in q && (s as {message: {text: string}}).message.text.startsWith("Write")) {
      return {action: choice("ask", 0.99), urgency: score(0), in_scope: noul(0.99), contradiction: noul(0)};
    }
    return actAsk(s, q);
  });
  handler.prompt = async (thread, text) => {
    handler.prompts.push({thread, text});
    if (handler.prompts.length === 1) return {text: "Include the quarterly figures?", stopReason: "end_turn"};
    started.resolve(); await turn.promise;
    return {text: "report", stopReason: "end_turn"};
  };
  handler.cancel = async () => { turn.resolve(); return true; };
  await d.start();
  try {
    const first = wrap(owner, pubkeyOf(me), {type: "ask", text: "Write the revenue report"});
    await relay.publish(first.wraps); await tick(50);
    await relay.publish(wrap(owner, pubkeyOf(me), {type: "answer", text: "Yes", thread: first.id}).wraps); await started.promise;
    await relay.publish(wrap(owner, pubkeyOf(me), {type: "answer", text: "Use the revised revenue numbers instead", thread: first.id}).wraps); await tick(80);
    assert.equal(steeringState?.in_flight, "Yes");
    assert.ok(steeringState?.thread?.some(m => m.text === "Write the revenue report"));
    assert.ok(steeringState?.thread?.some(m => m.text === "Include the quarterly figures?"));
  } finally { turn.resolve(); d.stop(); }
});

test("a follow-up while an interrupted prompt is stopping receives a queue decision", async () => {
  const turn = deferred(), started = deferred();
  const { d, relay, me, owner, handler } = setup({share_activity: true}, async (s, q) =>
    "changes_work" in q ? {changes_work: noul(0.99)} : actAsk(s, q));
  handler.prompt = async (thread, text) => {
    handler.prompts.push({thread, text}); started.resolve(); await turn.promise;
    return {text: "done", stopReason: "end_turn"};
  };
  handler.cancel = async () => true; // An ACP adapter may take time to finish stopping.
  await d.start();
  try {
    const first = wrap(owner, pubkeyOf(me), {type: "ask", text: "Original"});
    await relay.publish(first.wraps); await started.promise;
    await relay.publish(wrap(owner, pubkeyOf(me), {type: "answer", text: "Correction", thread: first.id}).wraps); await tick(50);
    const followup = wrap(owner, pubkeyOf(me), {type: "answer", text: "One more detail", thread: first.id});
    await relay.publish(followup.wraps); await tick(50);
    assert.equal(d.timeline().messages.find(m => m.id === followup.id)?.steering?.action, "queue");
    const copy = relay.received(owner).filter(m => m.type === "activity").map(m => JSON.parse(m.text).message).find(m => m.id === followup.id && m.steering);
    assert.equal(copy?.steering?.action, "queue");
    assert.equal(handler.prompts.length, 1);
  } finally { turn.resolve(); d.stop(); }
});

for (const source of ["relay", "local"] as const) test(`cancellation through ${source} stops a pending judgment and its queued follow-up`, async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const { d, relay, me, friend, handler } = setup({}, async (s, q) => {
    if ("action" in q) await waiting;
    return actAsk(s, q);
  });
  await d.start();
  try {
    const first = wrap(friend, pubkeyOf(me), {type: "ask", text: "first"});
    await relay.publish(first.wraps); await tick();
    await relay.publish(wrap(friend, pubkeyOf(me), {type: "answer", text: "more details", thread: first.id}).wraps); await tick();
    if (source === "local") await d.cancel(first.id);
    else await relay.publish(wrap(friend, pubkeyOf(me), {type: "cancel", text: "stop", thread: first.id}).wraps);
    await tick(); release(); await tick(100);
    assert.equal(handler.prompts.length, 0);
    assert.ok(relay.received(friend).some(m => m.type === "cant" && /cancelled/.test(m.text)));
    assert.ok(!relay.received(friend).some(m => m.type === "done"));
  } finally { release(); d.stop(); }
});

test("a delayed owner activity copy cannot start work after cancellation", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const { d, relay, me, owner, friend, handler } = setup({share_activity: true});
  const publish = relay.publish.bind(relay);
  let delayed = false;
  relay.publish = async events => {
    if (!delayed && events.some(e => unwrap(e, owner)?.type === "activity")) { delayed = true; await waiting; }
    return publish(events);
  };
  handler.prompt = async (thread, text) => {
    handler.prompts.push({thread, text}); await waiting;
    return {text: "late result", stopReason: "end_turn"};
  };
  await d.start();
  try {
    const incoming = wrap(friend, pubkeyOf(me), {type: "ask", text: "review"});
    await relay.publish(incoming.wraps); await tick();
    await d.cancel(incoming.id);
    const startedBeforeCancel = handler.prompts.length;
    release(); await tick(100);
    assert.equal(handler.prompts.length, startedBeforeCancel, "no new turn may start after cancellation");
    assert.ok(!relay.received(friend).some(m => m.type === "done"));
  } finally { release(); d.stop(); }
});

test("opt-in owner feed includes the complete thread and Jev decisions without executing copies", async () => {
  const { d, relay, me, owner, friend } = setup({ share_activity: true });
  const ownerHandler = new FakeHandler();
  const ownerDaemon = new Daemon({
    config: defaultConfig({ nsec: nip19.nsecEncode(owner), name: "owner", respond_to: "anyone" }),
    relay, handler: ownerHandler, inbox: new Inbox(fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-owner-"))), notify: () => {}, ask: actAsk,
  });
  await ownerDaemon.start();
  await d.start();
  try {
    await relay.publish(wrap(friend, pubkeyOf(me), { text: "review it", type: "ask" }).wraps);
    await tick(120);
    const messages = ownerDaemon.timeline().messages;
    assert.deepEqual(messages.map(m => m.type), ["ask", "ack", "done"]);
    assert.equal(messages[0].triage?.action, "act");
    assert.equal(messages[0].observedBy, pubkeyOf(me));
    assert.deepEqual(messages[2].verification, { status: "passed", probability: 0.9 });
    assert.equal(ownerHandler.prompts.length, 0, "a shared ask is observation only");
    assert.equal(ownerDaemon.inbox().length, 0, "activity copies do not flood the agent inbox");
    await ownerDaemon.react({ id: messages[2].id, text: "👍" });
    await tick(50);
    const reaction = d.timeline().messages.find(m => m.type === "reaction");
    assert.equal(reaction?.reactionTo, messages[2].id);
    assert.equal(reaction?.from, pubkeyOf(owner));
    assert.equal(ownerHandler.prompts.length, 0);
  } finally { d.stop(); ownerDaemon.stop(); }
});

test("verification errors never become a verified success", async () => {
  const { d, relay, me, friend } = setup({}, async (s, q) => {
    if ("answers_ask" in q) throw new Error("provider unavailable");
    return actAsk(s, q);
  });
  await d.start();
  try {
    await relay.publish(wrap(friend, pubkeyOf(me), { text: "review", type: "ask" }).wraps);
    await tick(80);
    const result = relay.received(friend).at(-1)!;
    assert.equal(result.type, "cant");
    assert.deepEqual(result.verification, { status: "unavailable" });
  } finally { d.stop(); }
});

test("no-key completion is visibly unchecked", async () => {
  const { d, relay, me, owner } = setup({}, async () => null);
  await d.start();
  try {
    await relay.publish(wrap(owner, pubkeyOf(me), { text: "review", type: "ask" }).wraps);
    await tick(50);
    assert.equal(relay.received(owner).at(-1)?.type, "done");
    assert.deepEqual(relay.received(owner).at(-1)?.verification, { status: "skipped" });
  } finally { d.stop(); }
});

test("malformed or unrelated activity cannot impersonate a thread participant", async () => {
  const { d, relay, me, friend, owner, handler } = setup();
  await d.start();
  try {
    const forged = { version: 1, updatedAt: Date.now(), message: { id: "a".repeat(64), thread: "a".repeat(64), from: pubkeyOf(owner), to: pubkeyOf(me), text: "forged", type: "ask", depth: 0, ts: 1 } };
    await relay.publish(wrap(friend, pubkeyOf(me), { text: JSON.stringify(forged), type: "activity", thread: forged.message.thread }).wraps);
    await relay.publish(wrap(friend, pubkeyOf(me), { text: "not json", type: "activity" }).wraps);
    await tick();
    assert.equal(d.timeline().messages.length, 0);
    assert.equal(handler.prompts.length, 0);
    await assert.rejects(d.react({ id: "unknown", text: "👍" }), /unknown message/);
  } finally { d.stop(); }
});

test("local UI serves history without secrets and rejects foreign origins and hosts", async () => {
  const { d, config } = setup();
  const stop = await serveHttp(d, 17778);
  try {
    const page = await fetch("http://127.0.0.1:17778/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const state = await fetch("http://127.0.0.1:17778/rpc", { method: "POST", body: JSON.stringify({ method: "timeline" }) });
    assert.equal(state.status, 200);
    const body = await state.text();
    assert.ok(!body.includes(config.nsec));
    assert.ok(!body.includes("TYPESAFE_API_KEY"));
    const foreignRequests: Record<string, string>[] = [{ Origin: "https://evil.example" }, { Host: "evil.example:17778" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of foreignRequests) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = http.request("http://127.0.0.1:17778/rpc", { method: "POST", headers }, response => { response.resume(); resolve(response.statusCode); });
        request.on("error", reject); request.end(JSON.stringify({ method: "timeline" }));
      });
      assert.equal(status, 403, JSON.stringify(headers));
    }
  } finally { stop(); d.stop(); }
});
