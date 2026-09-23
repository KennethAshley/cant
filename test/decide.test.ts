import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { triage, steer, scope, verify, attention, route, typesafeAsk, type Ask, type Answer } from "../src/decide.ts";
import type { Message, Profile } from "../src/nostr.ts";

const me: Profile = { pubkey: "me", name: "me", about: "", capabilities: ["review code"] };
const msg: Message = { id: "m1", thread: "m1", from: "them", to: "me", type: "ask", text: "review my PR", depth: 0, ts: 1 };
const thresholds = { act: 0.85, ask: 0.5, route: 0.6 };

const canned = (answers: Record<string, Answer>): Ask => async () => answers;
const choice = (c: string, confidence: number): Answer => ({ type: "choice", choice: c, confidence, probabilities: { [c]: confidence } });
const score = (s: number, confidence: number): Answer => ({ type: "score", score: s, confidence, probabilities: {}, legend: {} });
const noul = (p: number): Answer => ({ type: "noul", noul: p });

test("triage acts when confident and in scope", async () => {
  const t = await triage({ message: msg, thread: [msg], me, thresholds }, canned({ action: choice("act", 0.95), urgency: score(2, 0.9), in_scope: noul(0.9), contradiction: noul(0) }));
  assert.equal(t.action, "act");
  assert.equal(t.urgency, 2);
});

test("triage degrades act to ask below the act threshold", async () => {
  const t = await triage({ message: msg, thread: [msg], me, thresholds }, canned({ action: choice("act", 0.7), urgency: score(1, 0.9), in_scope: noul(0.9), contradiction: noul(0) }));
  assert.equal(t.action, "ask");
});

test("triage degrades to escalate below the ask threshold", async () => {
  const t = await triage({ message: msg, thread: [msg], me, thresholds }, canned({ action: choice("act", 0.3), urgency: score(1, 0.9), in_scope: noul(0.9), contradiction: noul(0) }));
  assert.equal(t.action, "escalate");
});

test("triage escalates when out of scope regardless of action", async () => {
  const t = await triage({ message: msg, thread: [msg], me, thresholds }, canned({ action: choice("act", 0.99), urgency: score(1, 0.9), in_scope: noul(0.2), contradiction: noul(0) }));
  assert.equal(t.action, "escalate");
  assert.match(t.reason, /scope/);
});

test("contradiction escalates even an otherwise actionable or quiet message in the same judge call", async () => {
  const prior: Message = {...msg, id: "prior", from: me.pubkey, to: msg.from, type: "answer", text: "The endpoint requires authentication"};
  const latest: Message = {...msg, type: "answer", text: "That same endpoint requires no authentication"};
  for (const [p, candidate, wanted] of [[0.79, "act", "act"], [0.8, "act", "escalate"], [0.95, "ignore", "escalate"]] as const) {
    let calls = 0;
    const result = await triage({message: latest, thread: [prior, latest], me, owner: true, thresholds}, async (state, questions) => {
      calls++;
      assert.ok("contradiction" in questions && "action" in questions);
      assert.ok(JSON.stringify(state).includes(prior.text));
      return {action: choice(candidate, 0.99), urgency: score(1, 1), in_scope: noul(0.9), contradiction: noul(p)};
    });
    assert.equal(result.action, wanted);
    assert.equal(result.contradiction, p);
    assert.equal(calls, 1);
    if (wanted === "escalate") {
      assert.equal(result.confidence, p, "display conflict confidence, not the overridden action's confidence");
      assert.match(result.reason, /contradiction/i);
    }
  }
});

test("no-key defaults: escalate, unknown scope, unchecked completion, no route", async () => {
  const none: Ask = async () => null;
  assert.equal((await triage({ message: msg, thread: [msg], me, thresholds }, none)).action, "escalate");
  assert.equal((await scope({ message: msg, me }, none)).inScope, undefined);
  assert.equal((await verify({ ask: "a", output: "b" }, none)).answersAsk, true);
  assert.equal((await verify({ ask: "a", output: "b" }, none)).p, undefined);
  assert.equal((await route({ request: "x", candidates: [me], threshold: 0.6 }, none)).pubkey, undefined);
});

test("verify says no below 0.5", async () => {
  assert.equal((await verify({ ask: "a", output: "b" }, canned({ answers_ask: noul(0.2) }))).answersAsk, false);
});

test("attention filters chatter, defers useful replies, and fails visible", async () => {
  const input = { ask: "Review when convenient", output: "Looks good", thread: [msg] };
  for (const [p, urgency, wanted] of [[0.59, "now", "none"], [0.6, "later", "later"], [0.9, "now", "now"], [0.9, "none", "now"]] as const) {
    const answers = { needs_owner: noul(p), attention_urgency: choice(urgency, 0.9) };
    assert.equal(await attention(input, canned(answers)), wanted);
    let calls = 0;
    const result = await verify(input, async (state, questions) => {
      calls++;
      assert.ok("answers_ask" in questions && "needs_owner" in questions);
      assert.ok(JSON.stringify(state).includes(msg.text));
      return { ...answers, answers_ask: noul(0.9) };
    });
    assert.equal(result.attention, wanted);
    assert.equal(calls, 1, "completion and attention share one request");
  }
  for (const ask of [async () => null, async () => ({}), async () => { throw new Error("offline"); }]) {
    assert.equal(await attention(input, ask), "now");
  }
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
  delete process.env.FEZ_JUDGE_URL;
  delete process.env.FEZ_JUDGE_KEY;
  assert.equal(await typesafeAsk({}, {}), null);
});

function judgeEnv(t: TestContext, values: Record<string, string>) {
  for (const name of ["TYPESAFE_API_KEY", "FEZ_JUDGE_URL", "FEZ_JUDGE_KEY"]) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
  }
}

test("hosted judge uses the gateway credential and wire contract, not the provider key", async t => {
  judgeEnv(t, { TYPESAFE_API_KEY: "provider-must-stay-local" });
  const questions = { ready: { type: "noul" as const, instructions: "Ready?", criteria: { true: "ready", false: "not ready" } } };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://judge.example/v1/judge");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer gateway-key");
    assert.deepEqual(JSON.parse(String(init.body)), { state: { task: "review" }, questions });
    return Response.json({ answers: { ready: noul(0.9) } });
  });
  assert.deepEqual(await typesafeAsk({ task: "review" }, questions, { url: "https://judge.example/v1/", key: "gateway-key" }), { ready: noul(0.9) });
});

test("gateway environment overrides config and a failure never falls back to TypeSafe", async t => {
  judgeEnv(t, { FEZ_JUDGE_URL: "https://override.example/v1", FEZ_JUDGE_KEY: "override-key", TYPESAFE_API_KEY: "provider-key" });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer override-key");
    return new Response("secret-echo", { status: 502 });
  });
  await assert.rejects(typesafeAsk({}, {}, { url: "https://config.example/v1", key: "config-key" }), /^Error: Judge HTTP 502$/);
  assert.deepEqual(urls, ["https://override.example/v1/judge"]);
});

test("partial gateway configuration fails before sending data or falling back", async t => {
  judgeEnv(t, { FEZ_JUDGE_URL: "https://judge.example/v1", TYPESAFE_API_KEY: "provider-key" });
  t.mock.method(globalThis, "fetch", () => { assert.fail("incomplete gateway configuration must not send data"); });
  await assert.rejects(typesafeAsk({}, {}), /judge.*URL.*key/i);
});

test("malformed judge responses do not leak their body into conversation errors", async t => {
  judgeEnv(t, { FEZ_JUDGE_URL: "https://judge.example/v1", FEZ_JUDGE_KEY: "client-key" });
  t.mock.method(globalThis, "fetch", async () => new Response("secret-echo"));
  await assert.rejects(typesafeAsk({}, {}), /^Error: Judge returned invalid JSON$/);
});

test("Jev can stay quiet on a resolved out-of-scope reply", async () => {
  const t = await triage({ message: { ...msg, type: "done", text: "All done, thanks" }, thread: [msg], me, thresholds },
    canned({ action: choice("ignore", 0.99), urgency: score(0, 1), in_scope: noul(0.1), contradiction: noul(0) }));
  assert.equal(t.action, "ignore");
});

test("interrupt decisions require a confident change and fall back to queuing", async () => {
  const input = { inFlight: "x".repeat(10000), message: "y".repeat(10000) };
  for (const [p, action] of [[0.1, "queue"], [0.69, "queue"], [0.7, "interrupt"], [0.99, "interrupt"]] as const) {
    const result = await steer(input, async (s) => {
      const state = s as { in_flight: string; new_message: string };
      assert.ok(state.in_flight.length <= 8000 && state.new_message.length <= 8000);
      return { changes_work: noul(p) };
    });
    assert.equal(result.action, action);
  }
  assert.equal((await steer(input, async () => null)).action, "queue");
  const failure = await steer(input, async () => { throw new Error("private provider error"); });
  assert.equal(failure.action, "queue");
  assert.ok(!JSON.stringify(failure).includes("private provider error"));
});
