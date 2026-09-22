# relayd: agent sidecar over Nostr, managed by Jev

Date: 2026-09-22
Status: draft for review
Working name: `relayd`. One constant in `src/config.ts` plus the package name. Rename is two edits.

## 1. Problem

Agents on different harnesses (Claude Code, Codex, Hermes, DeepSeek harness, scripts) cannot talk to each other. Each harness is an island. Nobody watches the inbox, so whatever connects them must also decide what each message means and who needs to see it.

## 2. Decisions already made

| Question | Decision |
|---|---|
| Identity and delivery | Nostr. Every human and agent is an npub. Relays carry signed events. |
| Privacy | NIP-17 gift-wrapped DMs for every message. Relays see kind 1059 blobs only. |
| Meaning | Thin tags: recipient, thread, and a `type` of `ask`, `answer`, `done`, `cant`, `escalate`. |
| Decisions | Jev (TypeSafe System One) answers typed questions. Code owns control flow and every side effect. |
| Distribution | Standalone npm package. `npx relayd init` writes `~/.relayd/config.json`. Every harness plugin reads that one file. Not a subcommand of another CLI. |
| Harness integration | MCP server first. Localhost HTTP as fallback. |
| Wake-up | The sidecar is a daemon that spawns a configured handler command per message. |
| Consent | Strangers need one explicit yes from the owner. Known npubs go to Jev triage. |
| Owner surface | The owner's own harness and terminal. No Nostr app required. Push via a `notify` command. |
| Default relays | Public relays. Our own relay is deferred. Config overrides. |
| First harness | Claude Code via `claude -p`. |

## 3. Parties

- **Human owner.** Has an npub and a running sidecar, like an agent. Their handler is themselves: they read with `inbox` and answer with `reply` and `allow`.
- **Agent.** An npub plus a sidecar whose handler is a harness in non-interactive mode.
- **Relays.** Dumb pipes. Two or three per sidecar for redundancy. Queue events while a sidecar is offline.
- **Jev.** Not a party. A function inside each sidecar. Never sends, never executes.

## 4. Processes

- `relayd up`: the daemon. Holds the key, keeps relay sockets open, runs the control loop, serves a localhost HTTP endpoint for local clients. Daemonizes by default; `--foreground` for debugging.
- `relayd mcp`: thin stdio MCP server the harness spawns. Forwards every tool call to the daemon over localhost HTTP. Starts the daemon if it is not running.
- `relayd init | whoami | inbox | reply | allow`: CLI. `inbox`, `reply`, `allow` talk to the daemon; `init` and `whoami` read the config file.

HTTP is localhost only. Between machines it is always relays.

## 5. Wire format

Profile: kind 0 with tag `["t", "relayd"]`. Content JSON: `name`, `about`, `capabilities` (string array). `find_agents` queries `{kinds:[0], "#t":["relayd"]}` and filters client-side.

Message: NIP-17. Kind 14 rumor, sealed (kind 13), gift-wrapped (kind 1059) to the recipient and to self.

Rumor tags:

| Tag | Value |
|---|---|
| `p` | recipient pubkey |
| `e` | thread root rumor id, omitted on the first message of a thread |
| `type` | `ask`, `answer`, `done`, `cant`, `escalate` |

Content is plain text. Nothing richer in v1.

Inbox subscription: kind 1059 with `#p` = own pubkey, `since` = last seen minus two days, because gift-wrap timestamps are randomized backward by up to two days. Dedupe on rumor id.

## 6. Jev judgments

All questions go through `src/decide.ts`. Each function builds state, asks, and returns typed answers plus confidence. Thresholds come from config.

| Function | When | Questions (one request) | Used by code as |
|---|---|---|---|
| `triage(msg, thread, me)` | inbound from a known npub | Choice `action`: act, ask, escalate. Score `urgency`: low, normal, high, critical. Noul `in_scope`: is this inside `me.capabilities`. | act needs confidence ≥ `thresholds.act` (default 0.85), else degrade to ask; below `thresholds.ask` (0.5) degrade to escalate. `in_scope` false forces escalate. Urgency orders the queue. |
| `scope(msg, me)` | inbound from a stranger | Noul `in_scope` only | Recommendation text in the consent message to the owner. Never runs anything. |
| `verify(ask, output)` | handler exited 0 | Noul `answers_ask`: does the output complete the ask | true sends `done`, false sends `cant` with the output attached. |
| `route(request, candidates)` | `send` without `to` | Choice among candidate npubs plus `none` | confidence < `thresholds.route` (0.6) or `none` returns candidates to the caller and sends nothing. |

State fields are named JSON: `message.text`, `message.type`, `sender.profile`, `thread.messages[]`, `me.capabilities`. Give each question only what it needs.

No `TYPESAFE_API_KEY`: `triage` returns escalate, `scope` returns unknown, `verify` returns true, `route` returns `none`. The network still works; the owner does the judging.

## 7. Control loop

Inbound, on a new rumor addressed to me:

1. Append to `inbox.jsonl` with `read: false`. Run `notify` if the message is for the owner's attention (see step 3 and 4).
2. Sender is `owner`: spawn the handler. Skip triage.
3. Sender not in `allow`: call `scope`. Send the owner an `escalate` with one line: sender name, the ask, Jev's in-scope verdict and confidence. Park the message. Owner `allow <npub>` re-enters at step 4 with the parked message. Owner `reply` with `cant` forwards to the sender.
4. Sender in `allow`: call `triage`.
   - act: send `answer` "Got it, working." Spawn handler with the thread as stdin. On exit 0 call `verify`; send `done` or `cant`. On non-zero exit or timeout send `cant` with the last 2 KB of stderr.
   - ask: spawn handler with the thread and an instruction to reply with a clarifying question only. Send its output as `ask` back to the sender.
   - escalate: forward to the owner as `escalate` with Jev's reason fields.
5. Every `done` and `cant` sent by an agent is also sent to the owner, unless the owner is the recipient already.

Outbound, on `send`:

1. `to` given: build rumor, wrap, publish to all relays, return rumor id as thread id.
2. `to` omitted: `find_agents`, `route`, then as above, or return candidates with no send.

An empty `handler` means never spawn: messages wait in the inbox. That is the owner's own sidecar.

Handler contract: command from config, thread messages as JSON lines on stdin, plain text on stdout, exit 0 means completed. Timeout from config, default 20 minutes. One handler per thread at a time; later messages on a running thread queue.

## 8. Files

`~/.relayd/`

| File | Contents |
|---|---|
| `config.json` | `nsec`, `relays[]`, `name`, `about`, `capabilities[]`, `owner` (npub), `handler` (string), `notify` (string), `allow[]`, `thresholds{act, ask, route}`, `timeoutMs`, `port`. Mode 600. |
| `inbox.jsonl` | one message per line: rumor id, thread, from, type, text, received at, Jev answers, `read` |
| `runs/<thread>.log` | handler stdout and stderr per thread |

Defaults from `init`: relays `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`; handler `claude -p`; notify on macOS `osascript -e 'display notification "$MSG" with title "relayd"'`, elsewhere empty; port 7777.

`init` prompts for name, capabilities, owner npub, and whether to import an nsec. `--yes` takes defaults. Publishes the profile on completion.

## 9. Tools

MCP and HTTP expose the same five:

| Tool | Args | Returns |
|---|---|---|
| `send` | `to?`, `text`, `type` (default `ask`), `thread?` | `{thread, id}` or `{candidates[]}` |
| `inbox` | `unread_only` (default true), `waiting_on_me` (default false) | messages with Jev fields, marks returned ones read |
| `reply` | `thread`, `text`, `type` (default `answer`) | `{id}` |
| `allow` | `npub` | `{allowed: true, resumed: n}` |
| `find_agents` | `query?` | profiles |

Plus `whoami` returning npub and capabilities.

## 10. Failure rules

- Relay socket drops: reconnect with exponential backoff, cap 60 s. Publish to every configured relay; success if any accepts.
- Nothing is sent twice. Outbound keyed on rumor id, inbound deduped on rumor id.
- Handler crash, non-zero exit, or timeout: `cant` to sender and owner, log kept.
- Jev API error: treat as no key for that call.
- Daemon crash: inbox file is the source of truth. On start, resubscribe from last seen minus two days and resume any thread whose last inbound has no outbound.

## 11. Testing

`test.ts`, plain `node --test`, no framework:

1. Wrap then unwrap a rumor with two generated keys. Text and tags survive.
2. Each `decide` function with a canned Jev response: thresholds degrade act to ask to escalate as designed; no key path returns the documented defaults.
3. Control loop with a fake relay in memory and `handler: "cat"`: stranger parks and notifies, `allow` resumes, known sender with act reaches `done`, timeout reaches `cant`.

Smoke test: two config dirs on one machine via `RELAYD_HOME`, real public relays, `handler: "claude -p"`. Send an ask from one, see `done` in the other's inbox.

## 12. Deferred, in order of likely need

1. Local web inbox page served by the daemon.
2. Nostr app support for owners who have one. Works today by accident, untested.
3. `settled` judgment: Noul "is this thread finished", to auto-close threads.
4. Our own default relay.
5. Keychain storage for the nsec.
6. NIP-90 job kinds as the marketplace layer, where Bittensor miners plug in.
7. Support for `dsh`, Codex, Hermes handlers. Only the handler string changes.

## 13. Prior art

- Sortis AI Agent Messenger: NIP-17 CLI with ingest daemon and agent orchestrator. No MCP, discovery, consent, or triage. https://github.com/Sortis-AI/agent-messenger
- Block Buzz and Hermes integration: NIP-29 channels, self-hosted relay, allowlist gating. A workspace product, not a sidecar. https://github.com/block/buzz/blob/main/NOSTR.md
- ContextVM: MCP JSON-RPC over Nostr, kind 25910, NIP PR open. Tools over Nostr, not agents tasking agents. https://github.com/ContextVM
- NIP-90 Data Vending Machines: job request and result kinds. https://github.com/nostr-protocol/nips/blob/master/90.md
- AgentBus Relay Chat: IRC-style agent channels over Nostr. https://aiskill.market/skills/agentbus-relay-chat

## 14. References

- Nostr NIPs: https://github.com/nostr-protocol/nips
- TypeSafe introduction: https://docs.typesafe.ai/introduction
- TypeSafe building guide: https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- TypeSafe confidence and routing: https://docs.typesafe.ai/confidence, https://docs.typesafe.ai/patterns/confidence-routing
- TypeSafe JS SDK: https://docs.typesafe.ai/sdk/javascript
- A2A, vocabulary reference only: https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- DeepSeek harness, distribution reference: https://github.com/deepseek-ai/deepseek-harness
- Honcho, one-config-many-plugins reference
