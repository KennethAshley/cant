# relayd: agent sidecar over Nostr, managed by Jev

Date: 2026-09-22
Status: draft for review, revision 3 after reading Buzz and fez
Working name: `relayd`. One constant in `src/config.ts` plus the package name. Rename is two edits.

## 1. Problem

Agents on different harnesses (Claude Code, Codex, Hermes, DeepSeek harness, scripts) cannot talk to each other. Each harness is an island. Nobody watches the inbox, so whatever connects them must also decide what each message means and who needs to see it.

## 2. Decisions

| Question | Decision |
|---|---|
| Identity and delivery | Nostr. Every human and agent is an npub. Relays carry signed events. Public relays by default, any relay by config. |
| Privacy | NIP-17 gift-wrapped DMs for every message. Relays see kind 1059 blobs only. |
| Meaning | Thin `type` tag: `ask`, `ack`, `answer`, `done`, `cant`, `cancel`, `escalate`. |
| Decisions | Jev (TypeSafe System One) answers typed questions. Code owns control flow and every side effect. |
| Distribution | Standalone npm package. `npx relayd init` writes `~/.relayd/config.json`. Every harness plugin reads that one file. Not a subcommand of another CLI. |
| Harness integration, outbound | MCP server first. Localhost HTTP as fallback. |
| Harness integration, inbound | The daemon drives the harness over ACP, the Agent Client Protocol (JSON-RPC over stdio, from Zed). One ACP session per thread. |
| Consent | Author gate with four modes, default `allowlist`: strangers need one explicit yes from the owner. Known npubs go to Jev triage. |
| Owner surface | The owner's own harness and terminal. No Nostr app required. Push via a `notify` command. |
| First harness | Claude Code via `@agentclientprotocol/claude-agent-acp`. |

Changed in revision 2, from Buzz: ACP instead of `claude -p`; `ack` and `cancel` types; owner control word `cancel`; `respond_to` gate modes; startup burst note. See section 13.

## 3. Parties

- **Human owner.** Has an npub and a running sidecar, like an agent. Their sidecar has no ACP handler: messages wait in the inbox. They read with `inbox` and answer with `reply` and `allow`.
- **Agent.** An npub plus a sidecar whose handler is a harness speaking ACP.
- **Relays.** Dumb pipes. Two or three per sidecar for redundancy. Queue events while a sidecar is offline.
- **Jev.** Not a party. A function inside each sidecar. Never sends, never executes.

## 4. Processes

- `relayd up`: the daemon. Holds the key, keeps relay sockets open, runs the control loop, hosts the ACP child process, serves a localhost HTTP endpoint for local clients. Daemonizes by default; `--foreground` for debugging.
- `relayd mcp`: thin stdio MCP server the harness spawns. Forwards every tool call to the daemon over localhost HTTP. Starts the daemon if it is not running.
- `relayd init | whoami | inbox | reply | allow | cancel`: CLI. All but `init` and `whoami` talk to the daemon.

HTTP is localhost only. Between machines it is always relays. ACP is a child process on the same machine.

### ACP in one paragraph

The daemon spawns the handler command once, sends `initialize`, and keeps it alive. For each new thread it calls `session/new` and remembers the session id. Each inbound message on that thread becomes a `session/prompt`. The agent streams `session/update` notifications; the daemon collects the text chunks and treats the final one as the reply when the turn ends with a stop reason. `session/cancel` stops a turn. Permission requests from the agent are answered by policy from config (`acp.permissions: allow | deny`, default `allow` for read and edit, `deny` for anything else). Client library: `@agentclientprotocol/sdk`. Adapters: `claude-agent-acp`, `codex-acp`, `goose acp`, `gemini --acp`, and whatever else the owner puts in `handler`.

## 5. Wire format

Profile: kind 0 with tag `["t", "relayd"]`. Content JSON: `name`, `about`, `capabilities` (string array). `find_agents` queries `{kinds:[0], "#t":["relayd"]}` and filters client-side.

Message: NIP-17. Kind 14 rumor, sealed (kind 13), gift-wrapped (kind 1059) to the recipient and to self.

Rumor tags:

| Tag | Value |
|---|---|
| `p` | recipient pubkey |
| `e` | thread root rumor id, omitted on the first message of a thread |
| `type` | one of the seven below |
| `depth` | agent-to-agent hop count, omitted when a human originated the thread. A sidecar refuses to act on `depth` ≥ 3 and sends `cant`. Loop guard, from fez. |

| Type | Sent by | Meaning |
|---|---|---|
| `ask` | anyone | a request, opens or continues a thread |
| `ack` | sidecar | accepted, a handler is running |
| `answer` | sidecar or agent | a reply that is not final: a clarifying question, a partial |
| `done` | sidecar | final result, verified by Jev |
| `cant` | sidecar | refused, failed, timed out, or output did not answer the ask |
| `cancel` | owner or original sender | stop work on this thread |
| `escalate` | sidecar to owner | needs a human: consent, low confidence, out of scope |

Content is plain text. Nothing richer in v1.

Inbox subscription: kind 1059 with `#p` = own pubkey, `since` = last seen minus two days, because gift-wrap timestamps are randomized backward by up to two days. Dedupe on rumor id. Expect a burst on first start after downtime; the queue absorbs it.

## 6. Jev judgments

All questions go through `src/decide.ts`. Each function builds state, asks, and returns typed answers plus confidence. Thresholds come from config.

| Function | When | Questions (one request) | Used by code as |
|---|---|---|---|
| `triage(msg, thread, me)` | inbound `ask` from a known npub | Choice `action`: act, ask, escalate. Score `urgency`: low, normal, high, critical. Noul `in_scope`: is this inside `me.capabilities`. | act needs confidence ≥ `thresholds.act` (0.85), else degrade to ask; below `thresholds.ask` (0.5) degrade to escalate. `in_scope` false forces escalate. Urgency orders the queue. |
| `scope(msg, me)` | inbound from a stranger | Noul `in_scope` only | Recommendation line in the consent message to the owner. Never runs anything. |
| `verify(ask, output)` | turn ended normally | Noul `answers_ask`: does the output complete the ask | true sends `done`, false sends `cant` with the output attached. |
| `route(request, candidates)` | `send` without `to` | Choice among candidate npubs plus `none` | confidence < `thresholds.route` (0.6) or `none` returns candidates to the caller and sends nothing. |

State fields are named JSON: `message.text`, `message.type`, `sender.profile`, `thread.messages[]`, `me.capabilities`. Give each question only what it needs.

No `TYPESAFE_API_KEY`: `triage` returns escalate, `scope` returns unknown, `verify` returns true, `route` returns `none`. The network still works; the owner does the judging.

## 7. Control loop

### Author gate, checked first

`respond_to` in config: `owner` (only the owner), `allowlist` (owner plus `allow[]`, the default), `anyone`, `nobody`. Owner control messages bypass the gate: a `cancel` from the owner on a thread stops that thread's turn and sends `cant` to the sender.

### Inbound, on a new rumor addressed to me

1. Append to `inbox.jsonl` with `read: false`.
2. Type `cancel` from the owner or the thread's original sender: `session/cancel`, send `cant`, stop.
3. Sender fails the gate under `allowlist`: call `scope`. Send the owner an `escalate` with one line: sender name, the ask, Jev's verdict and confidence. Run `notify`. Park the message. `allow <npub>` re-enters at step 5 with the parked message. `reply --type cant` forwards to the sender. Under `owner` and `nobody` the message is dropped after logging.
4. Sender is the owner: send `ack`, prompt the handler, skip triage. Go to step 6.
5. Sender passes the gate: call `triage`.
   - act: send `ack`. Prompt the handler with the thread. Go to step 6.
   - ask: prompt the handler with the thread and an instruction to reply with one clarifying question only. Send its output as `answer`.
   - escalate: forward to the owner as `escalate` with Jev's reason fields. Run `notify`.
6. Turn ends. Stop reason normal: call `verify`; send `done` or `cant`. Cancelled, errored, or past `timeoutMs`: send `cant` with the last 2 KB of output.
7. Every `done` and `cant` an agent sends is also sent to the owner, unless the owner is the recipient already. Run `notify`.

One prompt in flight per thread. Later messages on a running thread queue and are batched into the next prompt, oldest thread first. Threads are ordered by Jev's urgency when several are waiting.

### Outbound, on `send`

1. `to` given: build rumor, wrap, publish to all relays, return rumor id as thread id.
2. `to` omitted: `find_agents`, `route`, then as above, or return candidates with no send.

### Prompt shape

Each `session/prompt` carries the queued messages for that thread as text: one block per message with sender name, type, and text, followed by the instruction line for the mode (act or ask). The ACP session holds prior context, so earlier messages are not resent.

## 8. Files

`~/.relayd/`

| File | Contents |
|---|---|
| `config.json` | `nsec`, `relays[]`, `name`, `about`, `capabilities[]`, `owner` (npub), `handler` (string, ACP command, empty for owners), `acp.permissions`, `notify` (string), `respond_to`, `allow[]`, `thresholds{act, ask, route}`, `timeoutMs`, `port`. Mode 600. |
| `inbox.jsonl` | one message per line: rumor id, thread, from, type, text, received at, Jev answers, `read` |
| `sessions.json` | thread id to ACP session id, so a daemon restart can resume |
| `runs/<thread>.log` | handler output per thread |

Defaults from `init`: relays `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`; handler `claude-agent-acp`; `respond_to` `allowlist`; notify on macOS `osascript -e 'display notification "$MSG" with title "relayd"'`, elsewhere empty; timeout 20 minutes; port 7777.

`init` prompts for name, capabilities, owner npub, and whether to import an nsec. `--yes` takes defaults. `--owner` with no handler sets up a human's sidecar. Publishes the profile on completion.

## 9. Tools

MCP and HTTP expose the same six:

| Tool | Args | Returns |
|---|---|---|
| `send` | `to?`, `text`, `type` (default `ask`), `thread?` | `{thread, id}` or `{candidates[]}` |
| `inbox` | `unread_only` (default true), `waiting_on_me` (default false) | messages with Jev fields, marks returned ones read |
| `reply` | `thread`, `text`, `type` (default `answer`) | `{id}` |
| `allow` | `npub` | `{allowed: true, resumed: n}` |
| `cancel` | `thread` | `{cancelled: true}` |
| `find_agents` | `query?` | profiles |

Plus `whoami` returning npub and capabilities.

## 10. Failure rules

- Relay socket drops: reconnect with exponential backoff, cap 60 s. Publish to every configured relay; success if any accepts.
- Nothing is sent twice. Outbound keyed on rumor id, inbound deduped on rumor id.
- Handler process exits: respawn once, sessions are lost, in-flight threads get `cant`. A second exit within a minute stops respawning and every new `act` becomes `escalate`.
- Turn cancelled, errored, or timed out: `cant` to sender and owner, log kept.
- Jev API error: treat as no key for that call.
- Daemon crash: inbox file is the source of truth. On start, resubscribe from last seen minus two days and re-prompt any thread whose last inbound has no outbound.

## 11. Testing

`test.ts`, plain `node --test`, no framework:

1. Wrap then unwrap a rumor with two generated keys. Text and tags survive.
2. Each `decide` function with a canned Jev response: thresholds degrade act to ask to escalate as designed; no key path returns the documented defaults.
3. Control loop with a fake relay in memory and a fake ACP agent (a script that echoes the prompt): stranger parks and notifies, `allow` resumes, known sender with act reaches `done`, `cancel` reaches `cant`, timeout reaches `cant`.

Smoke test: two config dirs on one machine via `RELAYD_HOME`, real public relays, `handler: "claude-agent-acp"`. Send an ask from one, see `done` in the other's inbox.

## 12. Deferred, in order of likely need

1. `progress` type, streamed from `session/update` chunks, for long turns.
2. Local web inbox page served by the daemon.
3. Nostr app support for owners who have one. Works today by accident, untested.
4. `settled` judgment: Noul "is this thread finished", to auto-close threads.
5. Plain shell-command handler for harnesses with no ACP adapter.
6. Our own default relay.
7. Keychain storage for the nsec.
8. NIP-90 job kinds as the marketplace layer, where Bittensor miners plug in.

## 13. Lifted from fez

`~/Projects/Fez/fez` is the same idea at 15k core lines plus 60k in packages. relayd copies four files out of it and imports nothing. Copy, not depend, so relayd stays one small package with no path back to the bloat.

| Take | From | Lines | Change |
|---|---|---|---|
| NIP-17 wrap and unwrap, self-copy, fuzz window, seal verification | `src/protocol/dm.ts` | 155 | add the `type` and `e` tags, keep `depth` |
| ACP client: spawn, `initialize`, `session/new`, `session/prompt` with streamed updates | `src/agent/harness.ts` around lines 780 to 950 | about 150 | drop fez's pool, workspaces, and memory prompt |
| TypeSafe Choice call with response validation | `packages/fez-orchestrator/src/typesafe.ts` | 75 | base of `decide.ts`, add Score and Noul |
| Relay reconnect with backoff and per-relay health | `src/protocol/relay.ts` | up to 100 of 625 | only if `SimplePool` from nostr-tools proves flaky |

Not taken: fez's 47xxx custom kinds and public task events (relayd uses DMs and kind 0), personas, extensions, communities, keychain (deferred), the TUI and desktop.

## 14. Prior art

- **Block Buzz.** Humans and agents in NIP-29 channels on a self-hosted relay with NIP-42 auth, Postgres, Redis, and an APNs gateway. Its `buzz-acp` harness drives Claude Code, Codex, Goose, and others over ACP, one prompt in flight per channel, queued events batched into one prompt, replay since last seen on reconnect, author gate modes owner-only, allowlist, anyone, nobody, and owner control words `!cancel`, `!rotate`, `!shutdown` that bypass the gate. Job protocol kinds 43001 to 43006: request, accepted, progress, result, cancel, error. Persona packs define agents in YAML frontmatter. We take the ACP approach, the gate modes, the control word, the queue rule, and the ack and cancel types. We skip the relay, the workspace, personas, and push. https://github.com/block/buzz
- **fez, `@fezchat/protocol`.** Our own earlier take: agents by name over Nostr, NIP-17 DMs, ACP harness, TypeSafe route choice, owner-only, anyone, or allowlist summon gating, depth-tag loop guards. Grew into a workspace with a relay, desktop, wallet, git, and 50 packages. relayd is the thin core of it, restarted. See section 13. https://github.com/KennethAshley/fez
- **Sortis AI Agent Messenger.** NIP-17 CLI with an ingest daemon and an orchestrator that runs an agent CLI per message. No MCP, discovery, consent, or triage. https://github.com/Sortis-AI/agent-messenger
- **ContextVM.** MCP JSON-RPC over Nostr, kind 25910, NIP PR open. Tools over Nostr, not agents tasking agents. https://github.com/ContextVM
- **NIP-90 Data Vending Machines.** Job request and result kinds. Buzz chose custom kinds over NIP-90 because it needs auth chains. We may not. https://github.com/nostr-protocol/nips/blob/master/90.md
- **AgentBus Relay Chat.** IRC-style agent channels over Nostr. https://aiskill.market/skills/agentbus-relay-chat

## 15. References

- Nostr NIPs: https://github.com/nostr-protocol/nips
- Agent Client Protocol: https://agentclientprotocol.com, SDK `@agentclientprotocol/sdk` 1.5.0, adapters `@agentclientprotocol/claude-agent-acp` 0.80.0 and `@agentclientprotocol/codex-acp` 1.12.0
- TypeSafe introduction: https://docs.typesafe.ai/introduction
- TypeSafe building guide: https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- TypeSafe confidence and routing: https://docs.typesafe.ai/confidence, https://docs.typesafe.ai/patterns/confidence-routing
- TypeSafe JS SDK: https://docs.typesafe.ai/sdk/javascript
- A2A, vocabulary reference only: https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- DeepSeek harness, distribution reference: https://github.com/deepseek-ai/deepseek-harness
- Honcho, one-config-many-plugins reference
