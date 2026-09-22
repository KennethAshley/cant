# relayd: agent sidecar over Nostr, managed by Jev

Date: 2026-09-22
Status: draft for review, revision 4, clean rewrite
Working name: `relayd`. One constant in `src/config.ts` plus the package name. Rename is two edits.

## 1. Problem

Agents on different harnesses cannot talk to each other. Claude Code, Codex, Hermes, the DeepSeek harness, and plain scripts are each an island. And nobody is watching: the owner is not at a keyboard when a message arrives, so whatever connects the agents must also decide what each message means, whether to act on it, and when a human needs to see it.

## 2. Shape

Three kinds of party on one Nostr network:

- **Human owner.** An npub plus a running sidecar, exactly like an agent, except the sidecar has no handler. Messages wait in the inbox. The owner reads and answers through their own harness or terminal. No Nostr app required.
- **Agent.** An npub plus a sidecar whose handler is a coding harness driven over ACP.
- **Relays.** Dumb pipes. Two or three per sidecar. They queue events while a sidecar is offline.

Jev is not a party. It is a function inside each sidecar that answers typed questions. Code owns control flow and every side effect. Jev never sends and never executes.

## 3. Decisions

| Question | Decision |
|---|---|
| Identity and delivery | Nostr. Every human and agent is an npub. Public relays by default, any relay by config. No server of ours. |
| Privacy | NIP-17 gift-wrapped DMs for every message. Relays see kind 1059 blobs only. |
| Meaning | One `type` tag: `ask`, `ack`, `answer`, `done`, `cant`, `cancel`, `escalate`. Plus `e` for thread and `depth` for loop guard. |
| Decisions | Jev, TypeSafe's System One model, via `@typesafe-ai/sdk`. Optional: without a key the owner does the judging. |
| Distribution | Standalone npm package. `npx relayd init` writes `~/.relayd/config.json`. Every harness integration reads that one file. Not a subcommand of another CLI. |
| Outbound harness integration | MCP server first. Localhost HTTP as fallback. |
| Inbound harness integration | The daemon drives the harness over ACP, the Agent Client Protocol from Zed. One ACP session per thread. |
| Consent | Author gate, default `allowlist`: strangers need one explicit yes from the owner. Known npubs go to Jev triage. |
| Owner surface | `inbox`, `reply`, `allow`, `cancel` as MCP tools and CLI commands. Push through a `notify` command. |
| First harness | Claude Code via `@agentclientprotocol/claude-agent-acp`. |
| Prior code | Copy four files from fez. Import nothing from it. Section 13. |

## 4. Processes

- `relayd up`: the daemon. Holds the key, keeps relay sockets open, hosts the ACP child process, runs the control loop, serves a localhost HTTP endpoint. Daemonizes by default; `--foreground` for debugging.
- `relayd mcp`: thin stdio MCP server that the harness spawns. Forwards every tool call to the daemon over localhost HTTP. Starts the daemon if it is not running.
- `relayd init | whoami | inbox | reply | allow | cancel`: CLI. `init` and `whoami` read the config file. The rest talk to the daemon.

HTTP is localhost only. Between machines it is always relays. ACP is a child process on the same machine.

### ACP in one paragraph

The daemon spawns the handler command once, sends `initialize`, and keeps it alive. For each new thread it calls `session/new` and stores the session id. Each inbound message on that thread becomes a `session/prompt`. The agent streams `session/update` notifications; the daemon collects the text chunks and takes the final text as the reply when the turn ends with a stop reason. `session/cancel` stops a turn. Permission requests from the agent are answered by policy from config. Client library: `@agentclientprotocol/sdk`. Adapters: `claude-agent-acp`, `codex-acp`, `goose acp`, `gemini --acp`, or whatever the owner puts in `handler`.

## 5. Wire format

**Profile.** Kind 0 with tag `["t", "relayd"]`. Content JSON: `name`, `about`, `capabilities` (string array). `find_agents` queries `{kinds:[0], "#t":["relayd"]}` and filters client-side.

**Message.** NIP-17. A kind 14 rumor, sealed as kind 13, gift-wrapped as kind 1059, one wrap to the recipient and one to self.

Rumor tags:

| Tag | Value |
|---|---|
| `p` | recipient pubkey |
| `e` | thread root rumor id. Omitted on the first message of a thread, whose own id becomes the thread id. |
| `type` | one of the seven below |
| `depth` | agent-to-agent hop count. Omitted when a human originated the thread. Incremented each time a sidecar acts on an `ask` and sends a new `ask` onward. A sidecar refuses `depth` ≥ 3 with `cant`. |

Types:

| Type | Sent by | Meaning |
|---|---|---|
| `ask` | anyone | a request; opens or continues a thread |
| `ack` | sidecar | accepted, a handler is running |
| `answer` | sidecar or agent | a non-final reply, such as a clarifying question |
| `done` | sidecar | final result, verified by Jev |
| `cant` | sidecar | refused, failed, timed out, cancelled, or output did not answer the ask |
| `cancel` | owner or original sender | stop work on this thread |
| `escalate` | sidecar to owner | needs a human: consent, low confidence, out of scope |

Content is plain text. Nothing richer in v1.

**Inbox subscription.** Kind 1059 with `#p` = own pubkey, `since` = last seen minus two days, because wrap timestamps are randomized backward by up to two days. Dedupe on rumor id. Order by the rumor's real timestamp, never the wrap's. Expect a burst on first start after downtime; the queue absorbs it.

## 6. Jev judgments

All questions go through `src/decide.ts`. Each function builds state, asks, validates the response, and returns typed answers plus confidence. Thresholds come from config.

| Function | When | Questions, one request | Code uses it as |
|---|---|---|---|
| `triage(msg, thread, me)` | inbound `ask` from a known npub | Choice `action`: act, ask, escalate. Score `urgency`: low, normal, high, critical. Noul `in_scope`: inside `me.capabilities`. | act needs confidence ≥ `thresholds.act` (0.85), else ask; below `thresholds.ask` (0.5), escalate. `in_scope` false forces escalate. Urgency orders waiting threads. |
| `scope(msg, me)` | inbound from a stranger | Noul `in_scope` | one recommendation line in the consent message. Never runs anything. |
| `verify(ask, output)` | turn ended normally | Noul `answers_ask`: does the output complete the ask | true sends `done`, false sends `cant` with the output attached. |
| `route(request, candidates)` | `send` without `to` | Choice among candidate npubs plus `none` | confidence < `thresholds.route` (0.6) or `none`: return candidates, send nothing. |

State is named JSON: `message.text`, `message.type`, `sender.profile`, `thread.messages[]`, `me.capabilities`. Each question gets only what it needs.

Without `TYPESAFE_API_KEY`, or on API error: `triage` returns escalate, `scope` returns unknown, `verify` returns true, `route` returns `none`. The network still works; the owner judges.

## 7. Control loop

### Gate, checked first

`respond_to` in config: `owner` (only the owner), `allowlist` (owner plus `allow[]`, the default), `anyone`, `nobody`. Owner control bypasses the gate: a `cancel` from the owner on any thread stops it.

### Inbound, on a new rumor addressed to me

1. Append to `inbox.jsonl` with `read: false`.
2. Type `cancel` from the owner or the thread's original sender: `session/cancel`, send `cant`, stop.
3. `depth` ≥ 3: send `cant`, stop.
4. Sender fails the gate. Under `allowlist`: call `scope`, send the owner one `escalate` line with sender name, the ask, and Jev's verdict, run `notify`, park the message. `allow <npub>` re-enters at step 6 with the parked message. `reply --type cant` forwards to the sender. Under `owner` and `nobody`: log and drop.
5. Sender is the owner: send `ack`, prompt the handler, skip triage. Go to step 7.
6. Sender passes the gate: call `triage`.
   - act: send `ack`, prompt the handler with the thread. Go to step 7.
   - ask: prompt the handler with the thread and an instruction to reply with one clarifying question only. Send its output as `answer`.
   - escalate: forward to the owner as `escalate` with Jev's fields. Run `notify`.
7. Turn ends. Normal stop: call `verify`, send `done` or `cant`. Cancelled, errored, or past `timeoutMs`: send `cant` with the last 2 KB of output.
8. Every `done` and `cant` an agent sends is also sent to the owner, unless the owner is the recipient. Run `notify`.

One prompt in flight per thread. Later messages on a running thread queue and are batched into the next prompt. When several threads wait, the highest urgency goes first, then oldest.

### Outbound, on `send`

1. `to` given: build the rumor, wrap, publish to all relays, return the rumor id as the thread id.
2. `to` omitted: `find_agents`, then `route`. Send as above, or return candidates and send nothing.

If the sending sidecar is itself acting on an inbound `ask`, the outbound `ask` carries `depth` + 1.

### Prompt shape

Each `session/prompt` carries the queued messages for the thread as text, one block per message with sender name, type, and text, followed by one instruction line for the mode: act, or ask one clarifying question. The ACP session holds earlier context, so earlier messages are not resent.

## 8. Files

`~/.relayd/`, overridable with `RELAYD_HOME`:

| File | Contents |
|---|---|
| `config.json` | `nsec`, `relays[]`, `name`, `about`, `capabilities[]`, `owner` (npub), `handler` (ACP command, empty for owners), `acp.permissions`, `notify`, `respond_to`, `allow[]`, `thresholds{act, ask, route}`, `timeoutMs`, `port`. Mode 600. |
| `inbox.jsonl` | one message per line: rumor id, thread, from, type, depth, text, received at, Jev answers, `read` |
| `sessions.json` | thread id to ACP session id, so a daemon restart can resume |
| `runs/<thread>.log` | handler output per thread |

Defaults from `init`: relays `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`; handler `claude-agent-acp`; `acp.permissions` allow read and edit, deny the rest; `respond_to` `allowlist`; `notify` on macOS `osascript -e 'display notification "$MSG" with title "relayd"'`, elsewhere empty; timeout 20 minutes; port 7777.

`init` prompts for name, capabilities, owner npub, and whether to import an nsec. `--yes` takes defaults. `--owner` with no handler sets up a human's sidecar. Publishes the profile on completion.

## 9. Tools

MCP and HTTP expose the same six, plus `whoami`:

| Tool | Args | Returns |
|---|---|---|
| `send` | `to?`, `text`, `type` (default `ask`), `thread?` | `{thread, id}` or `{candidates[]}` |
| `inbox` | `unread_only` (default true), `waiting_on_me` (default false) | messages with Jev fields; marks returned ones read |
| `reply` | `thread`, `text`, `type` (default `answer`) | `{id}` |
| `allow` | `npub` | `{allowed: true, resumed: n}` |
| `cancel` | `thread` | `{cancelled: true}` |
| `find_agents` | `query?` | profiles |
| `whoami` | none | npub, name, capabilities |

## 10. Failure rules

- Relay socket drops: reconnect with exponential backoff, cap 60 s. Publish to every configured relay; success if any accepts.
- Nothing is sent twice. Outbound keyed on rumor id, inbound deduped on rumor id.
- Handler process exits: respawn once. Sessions are lost; in-flight threads get `cant`. A second exit within a minute stops respawning and every new act becomes escalate.
- Turn cancelled, errored, or timed out: `cant` to sender and owner, log kept.
- Jev error: same as no key, for that call.
- Daemon crash: `inbox.jsonl` is the source of truth. On start, resubscribe from last seen minus two days and re-prompt any thread whose last inbound has no outbound.

## 11. Testing

`test.ts`, plain `node --test`, no framework:

1. Wrap then unwrap a rumor with two generated keys. Text and every tag survive.
2. Each `decide` function against a canned Jev response: act degrades to ask to escalate at the thresholds; the no-key path returns the documented defaults.
3. Control loop against an in-memory fake relay and a fake ACP agent that echoes its prompt: stranger parks and notifies; `allow` resumes; known sender with act reaches `done`; `cancel` reaches `cant`; timeout reaches `cant`; `depth` 3 is refused.

Smoke test: two config dirs on one machine via `RELAYD_HOME`, real public relays, `handler: "claude-agent-acp"`. Send an ask from one, see `done` in the other's inbox.

## 12. Deferred, in order of likely need

1. `progress` type streamed from `session/update` chunks, for long turns.
2. Local web inbox page served by the daemon.
3. `settled` judgment: Noul "is this thread finished", to auto-close threads.
4. Plain shell-command handler for harnesses with no ACP adapter.
5. Our own default relay.
6. Keychain storage for the nsec, lifted from fez when wanted.
7. NIP-90 job kinds as the marketplace layer, where Bittensor miners plug in.
8. Nostr app support for owners who have one. Works today by accident, untested.

## 13. Lifted from fez

`~/Projects/Fez/fez`, published as `@fezchat/protocol`, is this idea at 15k core lines plus 60k across 50 packages. relayd copies four files out of it and imports nothing, so the package has no path back to the rest.

| Take | From | Lines | Change |
|---|---|---|---|
| NIP-17 wrap and unwrap, self-copy, fuzz window, seal verification, `depth` | `src/protocol/dm.ts` | 155 | add the `type` and `e` tags |
| ACP client: spawn, `initialize`, `session/new`, `session/prompt` with streamed updates | `src/agent/harness.ts`, about lines 780 to 950 | about 150 | drop the pool, workspaces, memory prompt |
| TypeSafe Choice call with response validation | `packages/fez-orchestrator/src/typesafe.ts` | 75 | base of `decide.ts`; add Score and Noul |
| Relay reconnect with backoff and per-relay health | `src/protocol/relay.ts` | up to 100 of 625 | only if nostr-tools `SimplePool` proves flaky |

Not taken: the 47xxx custom kinds and public task events, personas, extensions, communities, keychain, TUI, desktop, wallet, git.

## 14. Prior art

- **fez.** Our own earlier take. Agents by name over Nostr, NIP-17 DMs, ACP harness, TypeSafe route choice, owner-only, anyone, or allowlist summon gating, depth-tag loop guards. Grew into a workspace product. relayd is its thin core, restarted. https://github.com/KennethAshley/fez
- **Block Buzz.** Humans and agents in NIP-29 channels on a self-hosted relay. Its `buzz-acp` harness drives Claude Code, Codex, and Goose over ACP with one prompt in flight per channel, batched prompts, replay on reconnect, gate modes owner-only, allowlist, anyone, nobody, and owner control words that bypass the gate. Job kinds 43001 to 43006: request, accepted, progress, result, cancel, error. We took ACP, the gate modes, the control word, the queue rule, and the `ack` and `cancel` types. We skipped the relay, workspace, personas, and push. https://github.com/block/buzz
- **Sortis AI Agent Messenger.** NIP-17 CLI with an ingest daemon and an orchestrator that runs an agent CLI per message. No MCP, discovery, consent, or triage. https://github.com/Sortis-AI/agent-messenger
- **ContextVM.** MCP JSON-RPC over Nostr, kind 25910. Tools over Nostr, not agents tasking agents. https://github.com/ContextVM
- **NIP-90 Data Vending Machines.** Job request and result kinds. The marketplace path. https://github.com/nostr-protocol/nips/blob/master/90.md

## 15. References

- Nostr NIPs: https://github.com/nostr-protocol/nips
- Agent Client Protocol: https://agentclientprotocol.com. SDK `@agentclientprotocol/sdk` 1.5.0. Adapters `@agentclientprotocol/claude-agent-acp` 0.80.0, `@agentclientprotocol/codex-acp` 1.12.0.
- TypeSafe: https://docs.typesafe.ai/introduction, https://docs.typesafe.ai/concepts/how-to-build-with-system-one, https://docs.typesafe.ai/confidence, https://docs.typesafe.ai/patterns/confidence-routing, https://docs.typesafe.ai/sdk/javascript
- A2A, vocabulary reference only: https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- DeepSeek harness, distribution reference: https://github.com/deepseek-ai/deepseek-harness
- Honcho: one `init`, one config file, many harness plugins.
