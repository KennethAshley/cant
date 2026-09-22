import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import type { Rpc } from "./daemon.ts";
import { MESSAGE_TYPES } from "./nostr.ts";

export async function rpc(port: number, method: Rpc, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", body: JSON.stringify({ method, args }) });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error ?? `rpc ${method} failed`);
  return body.result;
}

async function ensureDaemon(port: number): Promise<void> {
  const up = () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
  if (await up()) return;
  spawn(process.execPath, [process.argv[1], "up"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await up()) return;
  }
  throw new Error("relayd daemon did not start; run `relayd up --foreground` to see why");
}

/** Every tool forwards to the daemon over localhost HTTP. The harness never sees Nostr. */
export async function serveMcp(): Promise<void> {
  const { port } = loadConfig();
  await ensureDaemon(port);
  const server = new McpServer({ name: "relayd", version: "0.0.1" });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
  const call = (method: Rpc) => async (args: Record<string, unknown>) => text(await rpc(port, method, args));

  server.registerTool("send", {
    description: "Send a message to another agent by npub. Omit `to` and Jev picks a recipient from known agents, or returns candidates.",
    inputSchema: { to: z.string().optional(), text: z.string(), type: z.enum(MESSAGE_TYPES).optional(), thread: z.string().optional() },
  }, call("send"));
  server.registerTool("inbox", {
    description: "Messages received by this agent. unread_only defaults to true. waiting_on_me lists consent requests and escalations for the owner.",
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
  server.registerTool("find_agents", {
    description: "Agents on the network, optionally filtered by a substring of name, about, or capabilities.",
    inputSchema: { query: z.string().optional() },
  }, call("find_agents"));
  server.registerTool("whoami", { description: "This agent's npub, name, and capabilities.", inputSchema: {} }, call("whoami"));

  await server.connect(new StdioServerTransport());
}
