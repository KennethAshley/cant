#!/usr/bin/env node
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import fs from "node:fs";
import path from "node:path";
import { NAME, PKG, defaultConfig, home, loadConfig, saveConfig } from "./config.ts";
import { generateNsec, secretFromNsec, pubkeyOf, npubOf, profileEvent, Relay } from "./nostr.ts";
import { Handler } from "./acp.ts";
import { PiHandler } from "./pi.ts";
import { picker, launchPi } from "./picker.ts";
import { Inbox } from "./inbox.ts";
import { Daemon, serveHttp } from "./daemon.ts";
import { rpc, serveMcp, ensureDaemon } from "./mcp.ts";

const args = process.argv.slice(2);
// A prefix flag keeps reply text and custom-handler arguments untouched.
if (args[0] === "--agent") {
  if (!args[1]) { console.error("--agent needs a name"); process.exit(1); }
  process.env.SIDECAR_AGENT = args[1];
  args.splice(0, 2);
}
const [cmd, ...rest] = args;

async function init(): Promise<void> {
  if (fs.existsSync(path.join(home(), "config.json"))) throw new Error(`An agent already exists at ${home()}. Use the picker to add another agent.`);
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
  saveConfig(config, { exclusive: true });
  const secret = secretFromNsec(nsec);
  const relay = new Relay(config.relays);
  await Promise.race([
    relay.publish([profileEvent(secret, { name, about: config.about, capabilities })]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 8000).unref()),
  ]).catch((e) => console.error(`profile publish failed: ${e instanceof Error ? e.message : e}. It will be retried on \`${PKG} up\`.`));
  relay.close();
  console.log(`npub: ${npubOf(pubkeyOf(secret))}`);
  console.log(`config: ${path.join(home(), "config.json")}`);
  const selected = process.env.SIDECAR_AGENT;
  const mcpArgs = [PKG, ...(selected ? ["--agent", selected] : []), "mcp"];
  console.log(`MCP: add ${JSON.stringify({ [NAME]: { command: "npx", args: mcpArgs } })} to your MCP config, then: npx ${PKG}${selected ? ` --agent ${selected}` : ""} up`);
}

async function up(): Promise<void> {
  if (loadConfig().protocol === "pi-interactive") { await launchPi(loadConfig()); return; }
  const foreground = rest.includes("--foreground");
  if (!foreground) {
    await ensureDaemon();
    console.log(`conversations: http://localhost:${loadConfig().port}`);
    return;
  }
  const config = loadConfig();
  const relay = new Relay(config.relays);
  const secret = secretFromNsec(config.nsec);
  const opts = { permissions: config.acp.permissions, timeoutMs: config.timeoutMs, cwd: config.cwd };
  const daemon = new Daemon({
    config,
    relay,
    handler: config.handler ? config.protocol === "pi" ? new PiHandler([config.handler], opts) : new Handler(config.handler, opts) : undefined,
    inbox: new Inbox(),
  });
  let stop: (() => void) | undefined;
  let ready = false;
  const shutdown = () => { saveConfig(daemon.config()); stop?.(); daemon.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    // Claim the port before subscribing or starting a harness, including concurrent launches.
    stop = await serveHttp(daemon, config.port, () => ready);
    await daemon.start();
    ready = true;
  } catch (e) { stop?.(); daemon.stop(); throw e; }
  void relay.publish([profileEvent(secret, { name: config.name, about: config.about, capabilities: config.capabilities })]).catch((e) => console.error("profile publish failed:", e.message));
  setInterval(() => saveConfig(daemon.config()), 10_000).unref();
  console.log(`${NAME} up as ${daemon.whoami().npub} on port ${config.port}`);
  console.log(`conversations: http://localhost:${config.port}`);
}

async function tool(method: "inbox" | "reply" | "allow" | "cancel" | "stop" | "pause" | "resume"): Promise<void> {
  const config = loadConfig();
  await ensureDaemon(config);
  const { port } = config;
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
  const control = ["stop", "pause", "resume"].includes(method);
  if (control) { args.thread = rest[0]; args.action = method; }
  console.log(JSON.stringify(await rpc(port, control ? "control" : method as "inbox" | "reply" | "allow" | "cancel", args), null, 2));
}

const commands: Record<string, () => Promise<void>> = {
  init, up, mcp: serveMcp,
  stop: () => tool("stop"), pause: () => tool("pause"), resume: () => tool("resume"),
  whoami: async () => { const c = loadConfig(); console.log(npubOf(pubkeyOf(secretFromNsec(c.nsec)))); },
  inbox: () => tool("inbox"), reply: () => tool("reply"), allow: () => tool("allow"), cancel: () => tool("cancel"),
};

const run = cmd === undefined && process.stdin.isTTY && process.stdout.isTTY ? () => picker(() => ensureDaemon()) : commands[cmd ?? ""];
if (!run) {
  console.log(`usage: ${NAME} [--agent name] <init [--yes] [--owner] [--name n] [--nsec k] [--owner-npub npub] [--capabilities a,b] [--handler cmd] [--port n] | up [--foreground] | mcp | whoami | inbox [--waiting] [--all] | reply <thread> <text> [--type t] | allow <npub> | cancel <thread> | stop <thread> | pause <thread> | resume <thread>>\nRun without a command in a terminal to choose an agent.`);
  process.exit(cmd ? 1 : 0);
}
run().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
