import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { home, loadConfig, type Config } from "./config.ts";
import { agentStatus } from "./picker.ts";
import type { Rpc } from "./daemon.ts";
import { MESSAGE_TYPES, controlActionSchema } from "./nostr.ts";

export async function rpc(port: number, method: Rpc, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", body: JSON.stringify({ method, args }) });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error ?? `rpc ${method} failed`);
  return body.result;
}

export async function ensureDaemon(config: Config = loadConfig()): Promise<void> {
  const status = await agentStatus(config);
  if (status === "running") return;
  if (config.protocol === "pi-interactive") throw new Error(`Open this agent with npx @fezchat/sidecar in a terminal. Its Sidecar runs inside Pi.`);
  if (status === "occupied") throw new Error(`Port ${config.port} belongs to another service. Run the picker to choose a free port.`);
  const logFile = path.join(home(), "daemon.log");
  let child: ReturnType<typeof spawn> | undefined;
  let failed = false;
  if (status === "stopped") {
    const log = fs.openSync(logFile, "a", 0o600);
    child = spawn(process.execPath, [...process.execArgv, process.argv[1], "up", "--foreground"], { detached: true, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    child.on("error", () => { failed = true; });
    child.unref();
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    const current = await agentStatus(config);
    if (current === "running") return;
    if (current === "occupied" || (current === "stopped" && (!child || failed || child.exitCode !== null || child.signalCode !== null))) break;
  }
  child?.kill();
  throw new Error(`Agent did not start. Details: ${logFile}`);
}

/** Every tool forwards to the daemon over localhost HTTP. The harness never sees Nostr. */
export async function serveMcp(): Promise<void> {
  const config = loadConfig();
  const { port } = config;
  await ensureDaemon(config);
  const server = new McpServer({ name: "sidecar", version: "0.0.1" });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
  const call = (method: Rpc) => async (args: Record<string, unknown>) => text(await rpc(port, method, args));

  server.registerTool("send", {
    description: "Send a message to another agent by npub. Omit `to` and Jev picks a recipient from known agents, or returns candidates.",
    inputSchema: { to: z.string().optional(), text: z.string(), type: z.enum(MESSAGE_TYPES).optional(), thread: z.string().optional() },
  }, call("send"));
  server.registerTool("inbox", {
    description: "Messages received by this agent. unread_only defaults to true. waiting_on_me lists consent requests, escalations, unavailable Jev checks, and interrupted work needing review.",
    inputSchema: { unread_only: z.boolean().optional(), waiting_on_me: z.boolean().optional() },
  }, call("inbox"));
  server.registerTool("reply", {
    description: "Reply on a thread. type defaults to answer; use done or cant to close it.",
    inputSchema: { thread: z.string(), text: z.string(), type: z.enum(MESSAGE_TYPES).optional() },
  }, call("reply"));
  server.registerTool("allow", {
    description: "Allow an npub to task this agent. Resumes any parked messages from it.",
    inputSchema: { npub: z.string() },
  }, call("allow"));
  server.registerTool("cancel", {
    description: "Stop work on a thread.",
    inputSchema: { thread: z.string() },
  }, call("cancel"));
  server.registerTool("control", {
    description: "Control agents in a conversation. Stop cancels current and queued work. Pause also holds new work until Resume; cancelled turns are not replayed. Pause/Resume require each agent's configured owner. Inspect the webapp for acceptance; sending is not proof an agent stopped.",
    inputSchema: {thread: z.string(), action: controlActionSchema},
  }, call("control"));
  server.registerTool("find_agents", {
    description: "Agents on the network, optionally filtered by a substring of name, about, or capabilities.",
    inputSchema: { query: z.string().optional() },
  }, call("find_agents"));
  server.registerTool("whoami", { description: "This agent's npub, name, and capabilities.", inputSchema: {} }, call("whoami"));
  server.registerTool("react", {
    description: "Add an encrypted emoji reaction to a message by its id.",
    inputSchema: { id: z.string(), text: z.string().min(1).max(32) },
  }, call("react"));

  await server.connect(new StdioServerTransport());
}
