#!/usr/bin/env node
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NAME, PKG, defaultConfig, home, loadConfig, saveConfig } from "./config.ts";
import { generateNsec, secretFromNsec, pubkeyOf, npubOf, profileEvent, Relay } from "./nostr.ts";
import { Handler } from "./acp.ts";
import { Inbox } from "./inbox.ts";
import { Daemon, serveHttp } from "./daemon.ts";
import { rpc, serveMcp } from "./mcp.ts";

const [cmd, ...rest] = process.argv.slice(2);

async function init(): Promise<void> {
  const { values } = parseArgs({ args: rest, options: { yes: { type: "boolean" }, owner: { type: "boolean" }, name: { type: "string" }, nsec: { type: "string" }, "owner-npub": { type: "string" }, capabilities: { type: "string" }, handler: { type: "string" }, port: { type: "string" } } });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, d: string) => (values.yes ? d : (await rl.question(`${q} [${d}]: `)) || d);
  const name = values.name ?? (await ask("name", "agent"));
  const capabilities = values.owner ? [] : (values.capabilities ?? (await ask("capabilities, comma separated", ""))).split(",").map((s) => s.trim()).filter(Boolean);
  const ownerNpub = values.owner ? "" : (values["owner-npub"] ?? (await ask("owner npub, blank for none", "")));
  const nsec = values.nsec ?? ((await ask("nsec to import, blank to generate", "")) || generateNsec());
  rl.close();
  const config = defaultConfig({
    nsec, name, capabilities, owner: ownerNpub || undefined,
    handler: values.owner ? "" : (values.handler ?? "npx -y @agentclientprotocol/claude-agent-acp"),
    ...(values.port ? { port: Number(values.port) } : {}),
  });
  saveConfig(config);
  const secret = secretFromNsec(nsec);
  const relay = new Relay(config.relays);
  await Promise.race([
    relay.publish([profileEvent(secret, { name, about: config.about, capabilities })]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 8000)),
  ]).catch((e) => console.error(`profile publish failed: ${e instanceof Error ? e.message : e}. It will be retried on \`${PKG} up\`.`));
  relay.close();
  console.log(`npub: ${npubOf(pubkeyOf(secret))}`);
  console.log(`config: ${path.join(home(), "config.json")}`);
  console.log(`MCP: add {"${NAME}": {"command": "npx", "args": ["${PKG}", "mcp"]}} to your MCP config, then: npx ${PKG} up`);
}

async function up(): Promise<void> {
  const foreground = rest.includes("--foreground");
  if (!foreground) {
    const log = fs.openSync(path.join(home(), "daemon.log"), "a");
    const child = spawn(process.execPath, [process.argv[1], "up", "--foreground"], { detached: true, stdio: ["ignore", log, log] });
    child.unref();
    console.log(`daemon started, pid ${child.pid}, log ${path.join(home(), "daemon.log")}`);
    return;
  }
  const config = loadConfig();
  const relay = new Relay(config.relays);
  const secret = secretFromNsec(config.nsec);
  await relay.publish([profileEvent(secret, { name: config.name, about: config.about, capabilities: config.capabilities })]).catch((e) => console.error("profile publish failed:", e.message));
  const daemon = new Daemon({
    config,
    relay,
    handler: config.handler ? new Handler(config.handler, { permissions: config.acp.permissions, timeoutMs: config.timeoutMs }) : undefined,
    inbox: new Inbox(),
  });
  await daemon.start();
  const stop = await serveHttp(daemon, config.port);
  const persist = setInterval(() => saveConfig(daemon.config()), 10_000);
  console.log(`${NAME} up as ${daemon.whoami().npub} on port ${config.port}`);
  console.log(`conversations: http://localhost:${config.port}`);
  const shutdown = () => { clearInterval(persist); saveConfig(daemon.config()); stop(); daemon.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function tool(method: "inbox" | "reply" | "allow" | "cancel"): Promise<void> {
  const { port } = loadConfig();
  const args: Record<string, unknown> = {};
  if (method === "reply") {
    const t = rest.indexOf("--type");
    args.thread = rest[0];
    args.text = (t >= 0 ? rest.slice(1, t) : rest.slice(1)).join(" ");
    if (t >= 0) args.type = rest[t + 1];
  }
  if (method === "allow") args.npub = rest[0];
  if (method === "cancel") args.thread = rest[0];
  if (method === "inbox") { args.waiting_on_me = rest.includes("--waiting"); args.unread_only = !rest.includes("--all"); }
  console.log(JSON.stringify(await rpc(port, method, args), null, 2));
}

const commands: Record<string, () => Promise<void>> = {
  init, up, mcp: serveMcp,
  whoami: async () => { const c = loadConfig(); console.log(npubOf(pubkeyOf(secretFromNsec(c.nsec)))); },
  inbox: () => tool("inbox"), reply: () => tool("reply"), allow: () => tool("allow"), cancel: () => tool("cancel"),
};

const run = commands[cmd ?? ""];
if (!run) {
  console.log(`usage: ${NAME} <init [--yes] [--owner] [--name n] [--nsec k] [--owner-npub npub] [--capabilities a,b] [--handler cmd] [--port n] | up [--foreground] | mcp | whoami | inbox [--waiting] [--all] | reply <thread> <text> [--type t] | allow <npub> | cancel <thread>>`);
  process.exit(cmd ? 1 : 0);
}
run().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
