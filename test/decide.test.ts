import { test } from "node:test";
import assert from "node:assert/strict";
import { triage, scope, verify, route, typesafeAsk, type Ask, type Answer } from "../src/decide.ts";
import type { Message, Profile } from "../src/nostr.ts";

const me: Profile = { pubkey: "me", name: "me", about: "", capabilities: ["review code"] };
const msg: Message = { id: "m1", thread: "m1", from: "them", to: "me", type: "ask", text: "review my PR", depth: 0, ts: 1 };
const thresholds = { act: 0.85, ask: 0.5, route: 0.6 };

const canned = (answers: Record<string, Answer>): Ask => async () => answers;
const choice = (c: string, confidence: number): Answer => ({ type: "choice", choice: c, confidence, probabilities: { [c]: confidence } });
const score = (s: number, confidence: number): Answer => ({ type: "score", score: s, confidence, probabilities: {}, legend: {} });
const noul = (p: number): Answer => ({ type: "noul", noul: p });

test("triage acts when confident and in scope", async () => {
  const t = await triage({ message: msg, thread: [msg], me, thresholds }, canned({ action: choice("act", 0.95), urgency: score(2, 0.9), in_scope: noul(0.9) }));
  assert.equal(t.action, "act");
  assert.equal(t.urgency, 2);
});

test("triage degrades act to ask below the act threshold", async () => {
  const t = await triage({ message: msg, thread: [msg], me, thresholds }, canned({ action: choice("act", 0.7), urgency: score(1, 0.9), in_scope: noul(0.9) }));
  assert.equal(t.action, "ask");
});

test("triage degrades to escalate below the ask threshold", async () => {
  const t = await triage({ message: msg, thread: [msg], me, thresholds }, canned({ action: choice("act", 0.3), urgency: score(1, 0.9), in_scope: noul(0.9) }));
  assert.equal(t.action, "escalate");
});

test("triage escalates when out of scope regardless of action", async () => {
  const t = await triage({ message: msg, thread: [msg], me, thresholds }, canned({ action: choice("act", 0.99), urgency: score(1, 0.9), in_scope: noul(0.2) }));
  assert.equal(t.action, "escalate");
  assert.match(t.reason, /scope/);
});

test("no-key defaults: escalate, unknown scope, verified, no route", async () => {
  const none: Ask = async () => null;
  assert.equal((await triage({ message: msg, thread: [msg], me, thresholds }, none)).action, "escalate");
  assert.equal((await scope({ message: msg, me }, none)).inScope, undefined);
  assert.equal((await verify({ ask: "a", output: "b" }, none)).answersAsk, true);
  assert.equal((await route({ request: "x", candidates: [me], threshold: 0.6 }, none)).pubkey, undefined);
});

test("verify says no below 0.5", async () => {
  assert.equal((await verify({ ask: "a", output: "b" }, canned({ answers_ask: noul(0.2) }))).answersAsk, false);
});

test("route picks a candidate above threshold and refuses below", async () => {
  const cands: Profile[] = [me, { pubkey: "p2", name: "two", about: "", capabilities: ["docs"] }];
  const hit = await route({ request: "write docs", candidates: cands, threshold: 0.6 }, canned({ route: choice("p2", 0.8) }));
  assert.equal(hit.pubkey, "p2");
  const miss = await route({ request: "write docs", candidates: cands, threshold: 0.6 }, canned({ route: choice("p2", 0.4) }));
  assert.equal(miss.pubkey, undefined);
  const none = await route({ request: "write docs", candidates: cands, threshold: 0.6 }, canned({ route: choice("none", 0.9) }));
  assert.equal(none.pubkey, undefined);
});

test("typesafeAsk returns null without a key", async () => {
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await typesafeAsk({}, {}), null);
});
