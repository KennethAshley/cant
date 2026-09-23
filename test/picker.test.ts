import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "../src/config.ts";
import { generateNsec, npubOf, pubkeyOf, secretFromNsec } from "../src/nostr.ts";
import { discoverAgents, savedAgents, availablePort, agentStatus } from "../src/picker.ts";

test("discovery shows installed agents together and reads Pi's configured model without copying credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-discovery-"));
  for (const name of ["pi", "claude"]) fs.writeFileSync(path.join(dir, name), "", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultModel: "kimi-k3", defaultProvider: "opencode-go", apiKey: "not-for-sidecar" }));
  const agents = discoverAgents(dir, dir);
  assert.deepEqual(agents.map(a => a.id), ["pi", "claude"]);
  assert.match(agents[0].detail, /kimi-k3/);
  assert.doesNotMatch(JSON.stringify(agents), /not-for-sidecar/);
  fs.chmodSync(path.join(dir, "pi"), 0o644);
  assert.deepEqual(discoverAgents(dir, dir).map(a => a.id), ["claude"]);
});

test("saved-agent discovery includes legacy config and preserves distinct identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-saved-"));
  fs.mkdirSync(path.join(root, "agents", "mini-pi"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(defaultConfig({ nsec: "legacy", name: "old" })));
  fs.writeFileSync(path.join(root, "agents", "mini-pi", "config.json"), JSON.stringify(defaultConfig({ nsec: "pi", name: "mini-pi", port: 7778 })));
  assert.deepEqual(savedAgents(root).map(a => [a.id, a.config.name, a.config.nsec]), [["default", "old", "legacy"], ["mini-pi", "mini-pi", "pi"]]);
});

test("port selection skips running services and ports reserved by stopped agents", async t => {
  const server = http.createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const found = await availablePort(new Set([port + 1]), port);
  assert.ok(found > port + 1);
});

test("a healthy daemon for another npub is occupied, not the selected agent", async t => {
  const config = defaultConfig({ name: "pi", nsec: generateNsec() });
  let identity = "npub1somebodyelse";
  let ready = true;
  const server = http.createServer((_req, res) => { res.statusCode = ready ? 200 : 503; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: ready, npub: identity })); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  config.port = (server.address() as { port: number }).port;
  assert.equal(await agentStatus(config), "occupied");
  identity = npubOf(pubkeyOf(secretFromNsec(config.nsec)));
  assert.equal(await agentStatus(config), "running");
  ready = false;
  assert.equal(await agentStatus(config), "starting");
});
