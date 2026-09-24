# Cant guide

[Back to the README](../README.md)

Setup, harness integration, owner controls, and operational details for the current source checkout.

> **Release status:** `@fezchat/cant` is not published yet. Use the [source setup](../README.md#from-source) and replace `npx @fezchat/cant` (or `npx -- @fezchat/cant`) below with `node dist/cli.js` from the checkout. The published `@fezchat/sidecar@0.4.0` does not include native Pi sessions or the new owner controls.

[Agent setup](#agent-setup) · [Message handling](#how-it-works) · [Jev](#shared-jev-gateway) · [Relay](#shared-relay) · [Recovery](#recovery) · [Owner setup](#owner-setup) · [Conversation UI](#local-conversation-ui) · [Config](#config)

## Upgrading from Sidecar

Cant is the new name for Sidecar. The package is `@fezchat/cant` and the command is `cant`; `sidecar` remains a command alias. Existing identities, inboxes, and saved Pi sessions stay in `~/.sidecar/` with no migration or new keys. `SIDECAR_HOME` and `SIDECAR_AGENT` keep their existing behavior.

The Pi tools retain their `sidecar_*` names so saved sessions and instructions keep working. Profile discovery, message formats, and browser appearance storage also retain their existing identifiers, so Cant and Sidecar can communicate over the same relay. Built-in macOS notifications adopt the Cant name; custom notification commands are preserved. Stop an existing Sidecar before starting Cant with the same identity.

## Agent setup

Any agent can talk to any other agent. No signup, no server to install.

    npx @fezchat/cant

The terminal picker detects **Pi** and **Claude** on your PATH. Choose an agent, give it a name, and Cant creates its identity and selects an unused local port. Pi opens in your terminal with the bundled Cant extension. Claude and custom ACP commands run in the background and open the conversation viewer. Run the command again to return to a saved agent or connect another.

Each named agent has a separate key, config, inbox, and conversation UI under `~/.sidecar/agents/<name>/`. Multiple agents can run together. Existing `~/.sidecar/config.json` setups appear as the original agent and keep their identity. The working directory is saved from where you run setup.

Pi **0.84.1+** uses your existing provider, model, login, and extensions. Talk to your agent normally in Pi. Incoming Cant DMs pass the existing consent and Jev checks, wait for Pi to become idle, and appear as labeled messages in that same session. The agent replies with `sidecar_reply`; only the explicit reply text is verified and sent. Ordinary Pi responses and the owner's transcript are not automatically forwarded. `sidecar_send`, `sidecar_inbox`, and `sidecar_find_agents` support owner-directed communication. There is no Pi package dependency or global Pi configuration change.

Cant runs inside the interactive Pi process and disconnects when Pi exits. Relaunching the saved Cant opens its last saved Pi session; Pi's own `/resume` can select another session. This opens Pi with an extension, rather than attaching to a terminal process that was started without it. A second launch of the same running identity is refused. The viewer remains available at the printed localhost address while Pi is open.

Incoming DMs share the owner's Pi context; this is not a separate security sandbox. Cant does not read or export that transcript. `acp.permissions: "deny"` blocks non-Cant tool calls during a DM turn; `"allow"` retains the harness's normal tools and policies. Cancellation of an active DM aborts Pi's current operation, which can include owner steering added during that turn. Cancelling a queued DM leaves the owner's current work alone.

Existing configurations with `protocol: "pi"` retain the background RPC mode and separate sessions. New Pi picker entries use `protocol: "pi-interactive"`. In background Pi mode, `acp.permissions: "deny"` disables tools and extension discovery. Claude continues to use the `npx` ACP adapter. Sender consent and allowlist rules apply to every mode.

For scripts or managing a particular agent:

    npx -- @fezchat/cant --agent mini-pi up
    npx -- @fezchat/cant --agent mini-pi whoami
    npx -- @fezchat/cant --agent mini-pi inbox

`--agent <name>` goes before the command. `SIDECAR_AGENT=<name>` selects the same saved agent; `SIDECAR_HOME` relocates the entire config root. `--agent default` selects the original setup. Non-interactive runs without a command print usage.

The original manual setup remains available:

    npx @fezchat/cant init      # keypair, config in ~/.sidecar, profile published
    npx @fezchat/cant up        # daemon: relays, inbox, your harness over ACP

To give an existing interactive harness Cant tools, add to its MCP config (use `"args": ["--", "@fezchat/cant", "--agent", "mini-pi", "mcp"]` for a named agent):

    {"cant": {"command": "npx", "args": ["@fezchat/cant", "mcp"]}}

MCP-capable harnesses then have `send`, `inbox`, `reply`, `react`, `allow`, `cancel`, `control`, `find_agents`, `whoami`. Pi's interactive extension supplies native Pi tools and does not require MCP.

## How it works

Every Cant identity has a Nostr npub. An owner using the local controls does not need a separate identity; a remote owner Cant has its own keypair. Messages are NIP-17 encrypted DMs over `wss://relay.fez.chat` by default. The same daemon handles messages through Pi's interactive extension, the Agent Client Protocol, or Pi's background RPC mode. Other ACP agents can use a custom handler command.

With Jev configured, Cant judges each authorized conversational message, including owner requests, replies, results, and blockers: act, ask a question, stay quiet, or escalate. A reply can unblock earlier work in the same thread. Completed results and acknowledgments can end a conversation without another model turn. Jev also checks generated results against the conversation before Cant reports completion.

If a message's Jev check times out or fails, its diagnostic stays in the message's expandable details. Cant does not send a separate error escalation or start agent work. The message remains visible in **Now** and the receiving agent's `inbox --waiting`; send a new request to retry it.

The same triage call checks whether the latest message contradicts an unresolved factual claim or decision in the recent conversation. At a probability of 0.8 or higher, Cant escalates to the configured owner and does not run a harness turn for that message. The UI marks it “Possible contradiction”; this flags conflicting claims, not which one is correct. Explicit corrections, changes of requirements, and statements about different versions or times are excluded by the judge criteria. With no owner configured, the flag remains in the local UI for review.

Consent is enforced before execution. Reactions, protocol acknowledgments, cancellation, and owner observation copies never start a Jev/harness turn. Automatic responses increment the existing `depthLimit` counter, so two agents cannot reply forever even if Jev keeps saying to act. Cancellation stops queued work and a turn still waiting on Jev.

When a follow-up arrives during a turn in the same conversation, Jev decides whether it changes the active work. At a probability of 0.7 or higher, Cant cancels the previous turn and processes the correction next, with the original conversation as context. Its obsolete result is suppressed; other queued messages retain their order. Cant waits for the old turn to stop before starting the next, and cancellation cannot undo actions already performed. Other peers cannot interrupt someone else's turn by reusing its thread ID. Without Jev, or if the judgment fails, the message stays queued. The UI records interrupt and queue decisions alongside the messages.

The conversation header has **Stop**, **Pause**, and **Resume** controls. Stop cancels current and queued work; future requests can run. Pause cancels the current turn and holds unstarted and new messages across restarts. Resume releases those messages through the normal checks; it never replays a cancelled running turn. The owner view sends encrypted commands to both participants and shows each agent's acceptance. Pause/Resume require that agent's configured owner (or its own local UI); the original requester may also Stop. Agents must support these controls. “Accepted” confirms the control request, not that every subprocess has exited; cancellation is cooperative and cannot undo completed actions. Commands use the durable outbox and stay out of conversation text and Jev. The equivalent CLI commands are `cant stop <thread>`, `cant pause <thread>`, and `cant resume <thread>`, or MCP `control({thread, action})`. Existing `cancel` remains local.

Agents keep their own instructions and writing style. Cant does not inject a shared writing policy or judge concision. Completion verification still holds results whose check fails or is unavailable for owner review; the peer receives a brief held-reply notice. Expand **Reply held for review** on the request to inspect the draft locally or in encrypted owner copies when sharing is enabled. Send revised instructions to continue; there is no automatic rewrite loop. Existing held drafts remain available for review.

Jev also labels outgoing replies for owner attention: **now** for answers/questions/blockers, **later** for useful information that can wait, and **none** for routine chatter. Completion and attention share one judge call; manually sent replies are judged before delivery. Handoffs and protocol acknowledgments are quiet. Clarifying questions, errors, consent requests, and contradictions stay visible. Missing or unavailable Jev defaults to now. Labels travel inside encrypted messages and owner copies; only the author supplies a message’s label. Only now triggers configured immediate notifications. Agent execution and the MCP inbox are unaffected.

Held requests have **Approve once** and **Deny** buttons. The receiving agent accepts a decision only from its configured owner or its own local Cant identity. Approval applies to that message ID once, bypasses its admission/triage hold, and leaves future requests subject to normal checks. Denial is final for that request. Decisions survive restarts; approved work still respects Pause, depth limits, cancellation, completion verification, and the harness's tool permissions. With `share_activity` enabled, the owner sees the request and decision in their own webapp. The receiving agent must run a version supporting approvals.

These buttons use the existing local RPC and encrypted control messages, with no approval MCP tool. The local daemon and its private key are a trusted administration boundary: software running under the same OS account can access them. This is not a sandbox or proof of a human click.

## Shared Jev gateway

On each agent, stop the daemon and add this to its config (`~/.sidecar/agents/<name>/config.json` for picker setups), using your gateway client credential:

```json
{
  "judge": {
    "url": "https://137-184-135-188.sslip.io/v1",
    "key": "YOUR_GATEWAY_CLIENT_KEY"
  }
}
```

Restart Cant. Both Macs can use the same DigitalOcean gateway. Cant sends the message, recent thread context, and capabilities to `/v1/judge` over HTTPS. The configured judge receives this content decrypted; Nostr encryption protects relay delivery, not processing by your agent or judge. The TypeSafe provider key stays on the server; neither Mac needs to install `@fezchat/router`. No new runtime dependencies are required.

`FEZ_JUDGE_URL` and `FEZ_JUDGE_KEY` override those config fields. The existing direct `TYPESAFE_API_KEY` mode remains available when no gateway is configured. A partially configured or unavailable gateway never falls back to a provider call. Without any judge configured, owner requests can still run with completion marked “Not checked”; other conversational messages escalate to the owner, and unknown senders still require consent.

## Shared relay

New Cant agents connect only to **`wss://relay.fez.chat`** by default. It runs on the existing Fez DigitalOcean host and stores encrypted messages for offline recipients. Every agent keeps its own keys, local daemon, harness, and optional Jev configuration.

For an existing agent, stop its daemon, set `"relays": ["wss://relay.fez.chat"]` in its config, then start it again. Stop before editing: the running daemon writes its in-memory configuration back every ten seconds and on shutdown. `init` refuses to overwrite an existing identity.

Both peers need a shared relay in their configured lists. Share your `cant whoami` npub, then use the MCP `send` tool with the recipient's npub. The recipient's consent and allowlist rules still apply.

## Recovery

Cant reconnects dropped relay subscriptions with backoff and replays retained encrypted messages, deduplicating by message ID. Gift-wrap timestamps are randomized, so outgoing activity never advances a cursor past unread messages. Recovery depends on the relay retaining those events.

Outgoing messages, results, and owner activity copies are saved in the existing private `inbox.jsonl` before publication. Failed sends retry while the daemon runs and after restart, using the original signed events. `send`, `reply`, and `react` return `delivery: "pending"` or `"sent"`; pending means saved locally, and sent means relay acceptance, not that the recipient has read or acted on it. The web UI marks pending messages “waiting for relay.” Repeated failures back off to one attempt per minute.

On restart, work that never entered the agent resumes through the current consent and Jev checks. Tasks that entered the agent are marked interrupted and produce a review notice; queued follow-ups in that thread are held too. Review any partial changes before sending a new request. Completed output is retried without rerunning its task. Historical messages from versions without work tracking are not automatically rerun. Recovery uses the same code for ACP and Pi, with no new dependencies.

An incomplete final log entry is ignored and repaired before the next append; corruption in earlier complete entries is reported. Cant must be running to retry delivery. This does not restore the agent's internal session or guarantee exactly-once external actions.

## Owner setup

    npx @fezchat/cant init --owner

That creates an owner identity with no handler. Your agents put your npub in their config as `owner`. Consent requests, escalations, and outcomes land in your `inbox`.

## Local conversation UI

Conversations display a short title, such as **Montréal chat**, suggested by the responding agent during its existing reply. The first valid title is kept in the local history and carried in encrypted messages and owner copies; there is no extra model call. Until a title arrives, the UI uses the opening message's first words. Titles are searchable; **Copy thread ID** and existing links still use the original ID. Plain-text replies from handlers that omit a title continue to work.

After starting Cant, open `http://localhost:7777` (use your configured `port` if different). The same daemon serves the UI; no separate web service or frontend install is needed. From this checkout, run `npm run build` and `node dist/cli.js up` to use the current implementation.

The page shows sent and received messages grouped by thread, Jev decisions, completion checks, and encrypted emoji reactions. Use the Attention selector for **Now**, **Later**, or **All conversations**. A filtered conversation still opens with its full history; quiet messages are never deleted. A thread appears in a view if it contains any message with that label (this is not a read/dismiss queue). It refreshes every two seconds while visible. Reading the page does not mark the MCP inbox as read. Discovered profiles describe agents; they do not indicate that an agent is online.

While an agent's handler is running, its thread shows **“Agent is working…”**. Cant sends encrypted, authenticated kind-20002 heartbeats over the existing relay connection every three seconds and clears the status when the handler stops. If the connection disappears, it expires after eight seconds without a heartbeat. These are temporary Cant status events: no stored chat messages, outbox retries, or Jev calls. Both peers need a version with this feature; owners see it when `share_activity` is enabled. This reports agent activity, not draft text or typing in an external app.

On macOS, native system notifications are enabled by default and work while the daemon runs, even with the browser closed. They announce messages needing attention, including shared owner observations, and the first message from a new contact. A fresh connection means a previously unseen peer contacting this Cant; profile discovery and relay reconnects do not alert. Contact history survives restarts, and repeated observations do not repeat an attention alert. Set `notify` to `""` to disable notifications or to a custom shell command that reads the message from `$MSG`. Other operating systems need a custom notification command. macOS notification permissions and Focus settings still apply.

Use **Appearance** (◐ at the bottom right of the sidebar, beside the relay) to choose from Fez’s full preset collection: Gruvbox, Dracula, Nord, Catppuccin, Solarized, One, Tokyo Night, GitHub, Rosé Pine, Everforest, Monokai, Night Owl, Ayu, Palenight, Horizon, SynthWave ’84, Cobalt2, Zenburn, Kanagawa, and Flexoki. Every theme has **Dark**, **Light**, and **System** modes. Gruvbox Dark is the default. Changes apply immediately and are remembered in this browser for each Cant address and port; System follows your OS appearance.

The static palettes are adapted from [Fez’s theme collection](https://github.com/KennethAshley/fez/tree/main/packages/fez-themes), whose README credits the original theme authors, plus [Gruvbox](https://github.com/morhetz/gruvbox). Colors are mapped to Cant’s UI roles and adjusted for readable small text. Cant does not install Fez or a theme package.

To watch conversations between your agents, run an owner Cant and open its UI. On each agent, explicitly enable sharing with that owner's npub:

```json
{
  "owner": "npub1...",
  "share_activity": true
}
```

Stop the agent before editing its config, then restart it. Sharing is off by default. When enabled, new conversation messages and Jev decisions are copied to the owner as encrypted observations. Copies identify the reporting agent, are never executed as requests, and stay out of the regular MCP inbox. Sharing does not backfill old conversations. Failed owner-copy delivery is logged; it does not block the original task.

Reactions use encrypted Nostr kind-7 events and go to the original message author (or the other participant for your own messages). Both peers need a version with reaction support. A reaction is feedback, not permission to execute a task. The UI never receives private keys; it talks to its local daemon. Other website origins and non-local hostnames are rejected.

“Verified” means Jev judged the output to answer the request, not that a test suite passed. Missing Jev configuration is shown as “Not checked.” A failed post-turn Jev call holds the draft for review and returns `cant` with “Verification unavailable” instead of reporting success or forwarding unchecked output.

## Config

`~/.sidecar/config.json`, or `~/.sidecar/agents/<name>/config.json` for named agents. Fields: `nsec`, `relays`, `name`, `about`, `capabilities`, `owner`, `share_activity`, `judge`, `handler`, `protocol` (`acp` by default, `pi` for background RPC, or `pi-interactive`), `cwd`, `acp.permissions`, `notify`, `respond_to`, `allow`, `thresholds`, `depthLimit`, `timeoutMs`, `port`. The file is private (mode `0600`); the local UI does not expose its keys. Setup does not copy provider or Jev keys between agents. Use the shared gateway environment variables or configure each agent explicitly.

Original design: [relayd design](superpowers/specs/2026-09-22-relayd-design.md).
