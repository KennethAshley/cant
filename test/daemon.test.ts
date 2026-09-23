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
import * as nostr from "../src/nostr.ts";

class FakeRelay implements RelayLike {
  subs: { pubkey: string; cb: (ev: Event) => void }[] = [];
  published: Event[] = [];
  profiles: Profile[] = [];
  async publish(events: Event[]) {
    this.published.push(...events);
    for (const ev of events) for (const s of this.subs) if (ev.tags.some((t) => t[0] === "p" && t[1] === s.pubkey)) setTimeout(() => s.cb(ev), 0);
  }
  publishEphemeral(events: Event[]) { void this.publish(events).catch(() => {}); }
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

test("one agent turn titles the encrypted conversation, survives restart, and keeps metadata out of Jev", async () => {
  const outputs: unknown[] = [];
  const {d, relay, handler, me, friend, owner, dir, config} = setup({share_activity: true}, async (state, questions) => {
    if ("answers_ask" in questions) outputs.push((state as {output: string}).output);
    return actAsk(state, questions);
  });
  handler.reply = "<sidecar-title>Montréal chat</sidecar-title>\n\nVisit Mount Royal.";
  await d.start();
  const request = wrap(friend, pubkeyOf(me), {text: "A couple of Montréal locations?", type: "ask"});
  try {
    await relay.publish(request.wraps); await tick(120);
    const result = relay.received(friend).find(m => m.type === "done")!;
    assert.equal(result?.title, "Montréal chat");
    assert.equal(result?.text, "Visit Mount Royal.");
    assert.deepEqual(outputs, ["Visit Mount Royal."]);
    assert.equal(handler.prompts.length, 1, "title uses the existing turn");
    assert.match(handler.prompts[0].text, /<sidecar-title>/);
    const ownerCopy = relay.received(owner).filter(m => m.type === "activity").map(m => JSON.parse(m.text).message).find(m => m.id === result.id);
    assert.equal(ownerCopy.title, result.title);
  } finally { d.stop(); }
  const nextRelay = new FakeRelay(), nextHandler = new FakeHandler();
  nextHandler.reply = "<sidecar-title>Changed title</sidecar-title>\nOld Montréal too.";
  const restarted = new Daemon({config, relay: nextRelay, handler: nextHandler, inbox: new Inbox(dir), ask: actAsk, notify: () => {}});
  try {
    await restarted.start();
    await nextRelay.publish(wrap(friend, pubkeyOf(me), {text: "Anywhere else?", type: "answer", thread: request.id}).wraps); await tick(120);
    const result = nextRelay.received(friend).find(m => m.type === "done")!;
    assert.equal(result?.title, "Montréal chat");
    assert.equal(result?.text, "Old Montréal too.");
    assert.ok(!nextHandler.prompts[0].text.includes("<sidecar-title>"), "do not request another title");
  } finally { restarted.stop(); }
});

test("clarifications can supply titles and optional formatting never loses a plain reply", async () => {
  for (const [reply, text, title] of [
    ["<sidecar-title>Montréal chat</sidecar-title>\nWhich neighborhood?", "Which neighborhood?", "Montréal chat"],
    ["Which neighborhood?", "Which neighborhood?", undefined],
    ["<sidecar-title>" + "x".repeat(81) + "</sidecar-title>\nWhich neighborhood?", "Which neighborhood?", undefined],
  ]) {
    const {d, relay, handler, friend, me} = setup({}, async () => ({action: choice("ask", .99), urgency: score(1), in_scope: noul(1), contradiction: noul(0)}));
    handler.reply = reply!;
    try {
      await d.start();
      await relay.publish(wrap(friend, pubkeyOf(me), {text: "Where should we go?", type: "ask"}).wraps); await tick(100);
      const result = relay.received(friend).find(m => m.type === "answer");
      assert.equal(result?.text, text);
      assert.equal(result?.title, title);
    } finally { d.stop(); }
  }
});

test("working heartbeats reach the peer and opted-in owner without history or extra judgments", async () => {
  let judgments = 0;
  const {d, relay, handler, me, friend, owner, box} = setup({share_activity: true}, async (s, q) => { judgments++; return actAsk(s, q); });
  const turn = deferred();
  handler.prompt = async () => { await turn.promise; return {text: "ready", stopReason: "end_turn"}; };
  const peerBox = new Inbox(fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-working-peer-")));
  const ownerBox = new Inbox(fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-working-owner-")));
  const peer = new Daemon({config: defaultConfig({nsec: nip19.nsecEncode(friend), name: "peer"}), relay, inbox: peerBox, notify: () => {}});
  const observer = new Daemon({config: defaultConfig({nsec: nip19.nsecEncode(owner), name: "owner"}), relay, inbox: ownerBox, notify: () => {}});
  try {
    await d.start(); await peer.start(); await observer.start();
    assert.deepEqual(d.timeline().working, []);
    const sent = await peer.send({to: pubkeyOf(me), text: "take your time"});
    assert.ok("id" in sent);
    await tick(150);
    for (const daemon of [d, peer, observer]) {
      assert.deepEqual(daemon.timeline().working.map(w => [w.from, w.thread, w.message]), [[pubkeyOf(me), sent.thread, sent.id]]);
    }
    const history = [box, peerBox, ownerBox].map(b => b.all().length);
    const first = peer.timeline().working[0].at;
    await tick(3100);
    assert.ok(peer.timeline().working[0].at > first, "active turn refreshes the indicator");
    assert.deepEqual([box, peerBox, ownerBox].map(b => b.all().length), history);
    assert.equal(judgments, 1, "heartbeats bypass Jev");
    turn.resolve(); await tick(150);
    for (const daemon of [d, peer, observer]) assert.deepEqual(daemon.timeline().working, []);
    assert.ok(peer.timeline().messages.some(m => m.type === "done" && m.text === "ready"));
    assert.ok([box, peerBox, ownerBox].every(b => b.all().every(m => !m.text.includes('"active"'))));
  } finally { turn.resolve(); d.stop(); peer.stop(); observer.stop(); }
});

test("working indicators reject unrelated agents and replays, expire, and disappear on restart", async t => {
  const {d, relay, me, friend, owner, config, box, dir} = setup();
  await d.start();
  try {
    assert.deepEqual(d.timeline().working, []);
    const sent = await d.send({to: pubkeyOf(friend), text: "request"});
    assert.ok("id" in sent);
    const now = Date.now();
    const status = {thread: sent.thread, message: sent.id, active: true, at: now};
    const publish = async (secret: Uint8Array, value = status) => {
      await relay.publish([nostr.wrapWorking(secret, pubkeyOf(me), value)]); await tick();
    };
    await publish(owner);
    assert.deepEqual(d.timeline().working, [], "only the actual recipient can report working on this request");
    await publish(friend, {...status, thread: "unrelated"});
    assert.deepEqual(d.timeline().working, []);
    const count = box.all().length;
    await publish(friend);
    assert.equal(d.timeline().working.length, 1);
    await publish(friend, {...status, active: false, at: now + 1});
    await publish(friend);
    assert.deepEqual(d.timeline().working, [], "delayed start cannot undo a newer stop");
    await publish(friend, {...status, at: now + 2});
    assert.equal(d.timeline().working.length, 1);
    assert.equal(box.all().length, count);
    const restarted = new Daemon({config, relay: new FakeRelay(), inbox: new Inbox(dir)});
    assert.deepEqual(restarted.timeline().working, []);
    t.mock.method(Date, "now", () => now + 9000);
    assert.deepEqual(d.timeline().working, [], "lost stop packets expire without new traffic");
  } finally { d.stop(); }
});

test("working clears on failure, cancellation, and shutdown without sharing to an opted-out owner", async () => {
  for (const ending of ["error", "cancel", "shutdown"]) {
    const {d, relay, handler, me, friend, owner} = setup();
    const turn = deferred(), started = deferred();
    handler.prompt = async () => {
      started.resolve(); await turn.promise;
      if (ending === "error") throw new Error("handler crashed");
      return {text: "", stopReason: "cancelled"};
    };
    handler.cancel = async () => { turn.resolve(); return true; };
    try {
      await d.start();
      const request = wrap(friend, pubkeyOf(me), {type: "ask", text: "work"});
      await relay.publish(request.wraps); await started.promise;
      assert.equal(d.timeline().working.length, 1, ending);
      if (ending === "shutdown") d.stop();
      else if (ending === "cancel") await d.cancel(request.id);
      else turn.resolve();
      await tick(100);
      assert.deepEqual(d.timeline().working, [], ending);
      const events = relay.published.filter(e => e.kind === 20002);
      assert.ok(events.every(e => e.tags[0][1] === pubkeyOf(friend)), "owner sharing remains opt-in");
      assert.equal(nostr.unwrapWorking(events.at(-1)!, friend)?.active, false);
      assert.ok(events.every(e => nostr.unwrapWorking(e, owner) === undefined));
    } finally { turn.resolve(); d.stop(); }
  }
});

test("owner notifications follow attention transitions without repeats from shared observations or relay replay", async () => {
  const {relay, me, owner, friend} = setup();
  const notes: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-notifications-"));
  const config = defaultConfig({nsec: nip19.nsecEncode(owner), name: "owner", handler: "", notify: "", respond_to: "anyone"});
  const observer = new Daemon({config, relay, inbox: new Inbox(dir), notify: text => notes.push(text)});
  const message = wrap(friend, pubkeyOf(me), {type: "ask", text: "Could you review this?", attention: "none"}).message;
  let updatedAt = Date.now();
  const share = async (source: Uint8Array, detail: object = {}) => {
    const copy = wrap(source, pubkeyOf(owner), {type: "activity", thread: message.thread,
      text: JSON.stringify({version: 1, updatedAt: ++updatedAt, message: {...message, ...detail}})});
    await relay.publish(copy.wraps); await tick();
    return copy;
  };
  try {
    await observer.start();
    await share(friend);
    assert.equal(notes.length, 0, "quiet observations do not notify");
    const triage = {action: "escalate", confidence: .9, urgency: 2, inScope: .9, reason: "needs owner decision"};
    await share(me, {triage});
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Could you review this/);
    const duplicate = await share(me, {triage});
    await share(friend);
    assert.equal(notes.length, 1, "neither repeat decisions nor the other reporter duplicate an alert");
    observer.stop();
    const restarted = new Daemon({config, relay, inbox: new Inbox(dir), notify: text => notes.push(text)});
    await restarted.start();
    try {
      await relay.publish(duplicate.wraps); await tick();
      await share(me, {triage});
      assert.equal(notes.length, 1, "restart and history replay do not repeat existing alerts");
    } finally { restarted.stop(); }
  } finally { observer.stop(); }
});

test("a fresh contact notifies once per npub, while later quiet messages and discovery stay silent", async () => {
  const {relay, me, friend, owner, config, dir, box} = setup({handler: "", respond_to: "anyone"});
  const notes: string[] = [];
  const d = new Daemon({config, relay, inbox: box, notify: text => notes.push(text)});
  const first = wrap(friend, pubkeyOf(me), {type: "answer", text: "Hello from a new agent", attention: "later"});
  try {
    await d.start();
    relay.profiles = [{pubkey: pubkeyOf(friend), name: "Pi", about: "", capabilities: []}];
    await d.findAgents(); assert.equal(notes.length, 0);
    await relay.publish(first.wraps); await tick();
    assert.equal(notes.length, 1);
    assert.match(notes[0], /New connection.*Pi/);
    await relay.publish(first.wraps);
    await relay.publish(wrap(friend, pubkeyOf(me), {type: "done", text: "Another quiet update", attention: "later"}).wraps);
    await tick(); assert.equal(notes.length, 1);
    await relay.publish(wrap(friend, pubkeyOf(me), {type: "answer", text: "Need your input", attention: "now"}).wraps);
    await tick(); assert.equal(notes.length, 2);
    assert.match(notes[1], /Need your input/);
    await relay.publish(wrap(owner, pubkeyOf(me), {type: "ask", text: "New and needs attention", attention: "now"}).wraps);
    await tick(); assert.equal(notes.length, 3, "first contact and attention share a single alert");
    d.stop();
    const restarted = new Daemon({config, relay, inbox: new Inbox(dir), notify: text => notes.push(text)});
    await restarted.start();
    try {
      await relay.publish(first.wraps);
      await relay.publish(wrap(friend, pubkeyOf(me), {type: "answer", text: "Still connected", attention: "none"}).wraps);
      await tick(); assert.equal(notes.length, 3);
    } finally { restarted.stop(); }
  } finally { d.stop(); }
});

test("notification hooks receive message data safely without blocking message admission", async () => {
  const {relay, friend, me, config, box, dir} = setup({handler: "", respond_to: "anyone"});
  const output = path.join(dir, "notification.txt");
  const d = new Daemon({config: {...config, notify: `/usr/bin/printenv MSG > '${output}'`}, relay, inbox: box});
  try {
    await d.start();
    const incoming = wrap(friend, pubkeyOf(me), {type: "answer", text: 'Montréal "hello"\0 $MSG $(whoami)', attention: "now"});
    await relay.publish(incoming.wraps); await tick(100);
    assert.equal(box.get(incoming.id)?.work, "finished");
    assert.match(fs.readFileSync(output, "utf8"), /Montréal "hello" \$MSG \$\(whoami\)/);
  } finally { d.stop(); }
});

test("offline sends survive restart and retry the original signed events after partial acceptance", async () => {
  const {d, config, relay, friend, dir} = setup({owner: undefined});
  const attempts: Event[][] = [];
  relay.publish = async events => { attempts.push(events); throw new Error("connection lost after recipient accepted"); };
  const sent = await d.send({to: pubkeyOf(friend), text: "durable request"});
  assert.ok("id" in sent);
  d.stop();
  const reopened = new Inbox(dir);
  assert.equal(reopened.all().find(m => m.id === sent.id)?.delivery, "pending");
  const healthy = new FakeRelay();
  const restarted = new Daemon({config, relay: healthy, inbox: reopened, ask: actAsk});
  try {
    await restarted.start(); await tick();
    assert.equal(JSON.stringify(healthy.published), JSON.stringify(attempts[0]), "retry wire bytes unchanged, including the self copy");
    assert.equal(new Inbox(dir).all().find(m => m.id === sent.id)?.delivery, "sent");
    assert.ok(!JSON.stringify(restarted.timeline()).includes("wraps"), "transport payloads stay out of the UI");
  } finally { restarted.stop(); }
});

test("the outbox retries during an outage without requiring a restart", async () => {
  const {d, relay, friend, box} = setup({owner: undefined});
  const publish = relay.publish.bind(relay);
  let offline = true;
  relay.publish = async events => { if (offline) throw new Error("offline"); await publish(events); };
  try {
    await d.start();
    const sent = await d.send({to: pubkeyOf(friend), text: "retry me"});
    assert.ok("id" in sent);
    offline = false;
    await tick(5500);
    assert.equal(box.all().find(m => m.id === sent.id)?.delivery, "sent");
    assert.equal(new Set(relay.received(friend).map(m => m.id)).size, 1);
  } finally { d.stop(); }
});

test("a completed result survives publication failure and is delivered after restart without rerunning work", async () => {
  const {d, config, relay, handler, me, friend, dir} = setup({owner: undefined});
  handler.prompt = async (thread, text) => {
    handler.prompts.push({thread, text});
    relay.publish = async () => { throw new Error("relay went offline"); };
    return {text: "saved completed output", stopReason: "end_turn"};
  };
  await d.start();
  await relay.publish(wrap(friend, pubkeyOf(me), {type: "ask", text: "finish once"}).wraps);
  await tick(120); d.stop();
  const box = new Inbox(dir);
  assert.ok(box.all().some(m => m.text === "saved completed output" && m.delivery === "pending"));
  const healthy = new FakeRelay(), nextHandler = new FakeHandler();
  const restarted = new Daemon({config, relay: healthy, inbox: box, handler: nextHandler, ask: actAsk});
  try {
    await restarted.start(); await tick();
    assert.equal(nextHandler.prompts.length, 0);
    assert.equal(healthy.received(friend).filter(m => m.type === "done").length, 1);
    assert.equal(healthy.received(friend).find(m => m.type === "done")?.text, "saved completed output");
  } finally { restarted.stop(); }
});

test("restart resumes never-started work in order, with admission and deduplication intact", async () => {
  const judgment = deferred();
  const {d, config, relay, handler, me, friend, dir} = setup({owner: undefined}, async (s, q) => { await judgment.promise; return actAsk(s, q); });
  await d.start();
  const first = wrap(friend, pubkeyOf(me), {type: "ask", text: "first pending task"});
  const second = wrap(friend, pubkeyOf(me), {type: "answer", text: "second pending task", thread: first.id});
  await relay.publish(first.wraps); await tick();
  await relay.publish(second.wraps); await tick();
  d.stop(); judgment.resolve(); await tick();
  assert.equal(handler.prompts.length, 0, "shutdown must not start the waiting turn");
  const healthy = new FakeRelay(), nextHandler = new FakeHandler();
  const restarted = new Daemon({config, relay: healthy, inbox: new Inbox(dir), handler: nextHandler, ask: actAsk});
  try {
    await restarted.start(); await tick(180);
    await healthy.publish([...first.wraps, ...second.wraps]); await tick();
    assert.equal(nextHandler.prompts.length, 2);
    assert.match(nextHandler.prompts[0].text, /first pending task/);
    assert.ok(!nextHandler.prompts[0].text.includes("second pending task"));
    assert.match(nextHandler.prompts[1].text, /second pending task/);
  } finally { restarted.stop(); }
});

test("restart flags interrupted work once, holds its follow-ups, and never blindly repeats agent actions", async () => {
  const {d, config, relay, handler, me, friend, dir} = setup({owner: undefined});
  handler.prompt = async () => new Promise(() => {});
  await d.start();
  const active = wrap(friend, pubkeyOf(me), {type: "ask", text: "partially executed task", attention: "none"});
  await relay.publish(active.wraps); await tick(80);
  await relay.publish(wrap(friend, pubkeyOf(me), {type: "answer", text: "dependent follow-up", thread: active.id}).wraps);
  await tick(); d.stop();
  for (let restart = 0; restart < 2; restart++) {
    const healthy = new FakeRelay(), nextHandler = new FakeHandler();
    const restarted = new Daemon({config, relay: healthy, inbox: new Inbox(dir), handler: nextHandler, ask: actAsk});
    try {
      await restarted.start(); await tick(100);
      assert.equal(nextHandler.prompts.length, 0);
      assert.equal(new Inbox(dir).all().find(m => m.id === active.id)?.work, "interrupted");
      assert.equal(restarted.timeline().messages.find(m => m.id === active.id)?.attention, "now");
      assert.ok(restarted.inbox({waiting_on_me: true, unread_only: false}).some(m => m.id === active.id));
      assert.equal(healthy.received(friend).filter(m => m.type === "cant" && /interrupted/i.test(m.text)).length, restart === 0 ? 1 : 0);
    } finally { restarted.stop(); }
  }
});

test("recovery reapplies consent and leaves historical messages alone", async () => {
  const judgment = deferred();
  const {d, config, relay, me, friend, dir, box} = setup({owner: undefined}, async (s, q) => { await judgment.promise; return actAsk(s, q); });
  box.append(wrap(friend, pubkeyOf(me), {type: "ask", text: "old untracked message"}).message);
  await d.start();
  const request = wrap(friend, pubkeyOf(me), {type: "ask", text: "permission since revoked"});
  await relay.publish(request.wraps); await tick(); d.stop();
  judgment.resolve(); await tick();
  const nextHandler = new FakeHandler();
  const restarted = new Daemon({config: {...config, allow: []}, relay: new FakeRelay(), handler: nextHandler, inbox: new Inbox(dir), ask: actAsk});
  try {
    await restarted.start(); await tick(100);
    assert.equal(nextHandler.prompts.length, 0);
    assert.equal(new Inbox(dir).parked().find(m => m.id === request.id)?.text, "permission since revoked");
  } finally { restarted.stop(); }
});

test("explicit cancellation stays cancelled after a restart", async () => {
  const {d, config, relay, handler, me, friend, dir} = setup({owner: undefined});
  handler.prompt = async () => new Promise(() => {});
  await d.start();
  const request = wrap(friend, pubkeyOf(me), {type: "ask", text: "cancelled task"});
  await relay.publish(request.wraps); await tick();
  await relay.publish(wrap(friend, pubkeyOf(me), {type: "answer", thread: request.id, text: "queued before cancel"}).wraps); await tick();
  await d.cancel(request.id); d.stop();
  const nextHandler = new FakeHandler(), healthy = new FakeRelay();
  const restarted = new Daemon({config, relay: healthy, handler: nextHandler, inbox: new Inbox(dir), ask: actAsk});
  try {
    await restarted.start(); await tick(100);
    assert.equal(nextHandler.prompts.length, 0);
    assert.equal(healthy.received(friend).length, 0, "no spurious interruption notice for explicitly cancelled work");
  } finally { restarted.stop(); }
});

test("sending while offline cannot move the replay window past older unread DMs", async t => {
  const {d, relay, friend, me, handler} = setup({owner: undefined});
  t.mock.timers.enable({apis: ["Date"], now: Date.now() - 5 * 86400_000});
  const missed = wrap(friend, pubkeyOf(me), {type: "ask", text: "waiting on relay for five days"});
  t.mock.timers.reset();
  await d.send({to: pubkeyOf(friend), text: "newer outgoing message"});
  relay.subscribeInbox = (_pubkey, since, cb) => {
    if (missed.wraps[0].created_at >= Math.max(0, since - 2 * 86400)) setTimeout(() => cb(missed.wraps[0]), 0);
    return () => {};
  };
  try {
    await d.start(); await tick(100);
    assert.equal(handler.prompts.length, 1);
    assert.match(handler.prompts[0].text, /waiting on relay for five days/);
  } finally { d.stop(); }
});

test("a restart while an interrupted agent is still stopping holds all work for review", async () => {
  const {d, relay, config, handler, friend, me, dir} = setup({owner: undefined}, async (s, q) => {
    if ("changes_work" in q) return {changes_work: noul(0.99)};
    return actAsk(s, q);
  });
  handler.prompt = async () => new Promise(() => {});
  await d.start();
  const root = wrap(friend, pubkeyOf(me), {type: "ask", text: "active task"});
  await relay.publish(root.wraps); await tick();
  const correction = wrap(friend, pubkeyOf(me), {type: "answer", text: "Stop and use the corrected requirement", thread: root.id});
  await relay.publish(correction.wraps); await tick();
  assert.equal(new Inbox(dir).get(correction.id)?.steering?.action, "interrupt");
  d.stop();
  const nextHandler = new FakeHandler();
  const restarted = new Daemon({config, relay: new FakeRelay(), handler: nextHandler, inbox: new Inbox(dir), ask: actAsk});
  try {
    await restarted.start(); await tick(100);
    assert.equal(nextHandler.prompts.length, 0, "the cancelled subprocess never confirmed it stopped");
    assert.equal(new Inbox(dir).get(root.id)?.work, "interrupted");
  } finally { restarted.stop(); }
});

test("restart preserves a correction's place ahead of older queued messages", async () => {
  const turn = deferred(), judgment = deferred(), correcting = deferred();
  const {d, config, relay, handler, friend, me, dir} = setup({owner: undefined}, async (s, q) => {
    if ("changes_work" in q) return {changes_work: noul((s as {new_message: string}).new_message === "correction first" ? 0.99 : 0)};
    if ("action" in q && (s as {message: {text: string}}).message.text === "correction first") { correcting.resolve(); await judgment.promise; }
    return actAsk(s, q);
  });
  handler.prompt = async () => { await turn.promise; return {text: "superseded", stopReason: "end_turn"}; };
  handler.cancel = async () => { turn.resolve(); return true; };
  await d.start();
  const root = wrap(friend, pubkeyOf(me), {type: "ask", text: "original task"});
  await relay.publish(root.wraps); await tick();
  await relay.publish(wrap(friend, pubkeyOf(me), {type: "answer", text: "older queued aside", thread: root.id}).wraps); await tick();
  await relay.publish(wrap(friend, pubkeyOf(me), {type: "answer", text: "correction first", thread: root.id}).wraps);
  await correcting.promise;
  d.stop(); judgment.resolve(); await tick();
  const order: string[] = [], nextHandler = new FakeHandler();
  const restarted = new Daemon({config, relay: new FakeRelay(), handler: nextHandler, inbox: new Inbox(dir), ask: async (s, q) => {
    if ("action" in q) order.push((s as {message: {text: string}}).message.text);
    return actAsk(s, q);
  }});
  try {
    await restarted.start(); await tick(150);
    assert.deepEqual(order, ["correction first", "older queued aside"]);
  } finally { restarted.stop(); }
});

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
      assert.equal(notes.filter(n => !n.startsWith("New connection")).length, level === "now" ? 1 : 0);
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
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^New connection/);
    await relay.publish(wrap(secretFromNsec(config.nsec), pubkeyOf(owner), {text: "blocked", type: "cant", attention: "none"}).wraps);
    await tick();
    assert.equal(notes.length, 2, "blockers stay visible even with a quiet tag");
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
  assert.equal(notes.filter(n => !n.startsWith("New connection")).length, 1);
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

test("judge transport errors stay on the original message without sending an escalation or running work", async () => {
  for (const share_activity of [false, true]) {
    const {d, relay, handler, me, owner, friend, notes, box, dir} = setup({share_activity}, async () => { throw new Error("Judge HTTP 504"); });
    await d.start();
    try {
      const request = wrap(friend, pubkeyOf(me), {type: "answer", text: "Thanks for the chat!", attention: "none"});
      await relay.publish(request.wraps); await tick(100);
      assert.equal(handler.prompts.length, 0, "unjudged messages cannot start work");
      assert.deepEqual(relay.received(friend), []);
      assert.equal(relay.received(owner).filter(m => m.type !== "activity").length, 0, "no technical error is sent as conversation text");
      assert.deepEqual(notes.filter(n => !n.startsWith("New connection")), [], "no push notification for a transport error");
      assert.equal(box.get(request.id)?.triage?.action, "unavailable");
      assert.match(new Inbox(dir).get(request.id)?.triage?.reason ?? "", /Judge HTTP 504/);
      assert.equal(d.timeline().messages.find(m => m.id === request.id)?.attention, "now");
      assert.ok(d.inbox({waiting_on_me: true}).some(m => m.id === request.id), "unjudged messages remain available for review");
      if (share_activity) {
        const ownerBox = new Inbox(fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-judge-owner-")));
        for (const m of relay.received(owner)) ownerBox.append(m);
        const ownerDaemon = new Daemon({config: defaultConfig({nsec: nip19.nsecEncode(owner), name: "owner"}), relay, inbox: ownerBox});
        const messages = ownerDaemon.timeline().messages;
        assert.equal(messages.length, 1);
        assert.equal(messages[0].text, "Thanks for the chat!");
        assert.equal(messages[0].triage?.action, "unavailable");
        assert.match(messages[0].triage?.reason ?? "", /Judge HTTP 504/);
      }
    } finally { d.stop(); }
  }
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
