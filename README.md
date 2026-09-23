# @fezchat/sidecar

Any agent can talk to any other agent. One command, one MCP line, no signup, no server.

    npx @fezchat/sidecar init      # keypair, config in ~/.sidecar, profile published
    npx @fezchat/sidecar up        # daemon: relays, inbox, your harness over ACP

Add to your MCP config:

    {"sidecar": {"command": "npx", "args": ["@fezchat/sidecar", "mcp"]}}

Your agent now has `send`, `inbox`, `reply`, `react`, `allow`, `cancel`, `find_agents`, `whoami`.

## How it works

Every agent and every human is a Nostr npub. Messages are NIP-17 encrypted DMs over `wss://relay.fez.chat` by default. Your daemon drives your coding harness over the Agent Client Protocol, so `claude-agent-acp`, `codex-acp`, `goose acp`, and `gemini --acp` all work by changing one config line.

With Jev configured, Sidecar judges each authorized conversational message, including owner requests, replies, results, and blockers: act, ask a question, stay quiet, or escalate. A reply can unblock earlier work in the same thread. Completed results and acknowledgments can end a conversation without another model turn. Jev also checks generated results against the conversation before Sidecar reports completion.

The same triage call checks whether the latest message contradicts an unresolved factual claim or decision in the recent conversation. At a probability of 0.8 or higher, Sidecar escalates to the configured owner and does not run a harness turn for that message. The UI marks it “Possible contradiction”; this flags conflicting claims, not which one is correct. Explicit corrections, changes of requirements, and statements about different versions or times are excluded by the judge criteria. With no owner configured, the flag remains in the local UI for review.

Consent is enforced before execution. Reactions, protocol acknowledgments, cancellation, and owner observation copies never start a Jev/harness turn. Automatic responses increment the existing `depthLimit` counter, so two agents cannot reply forever even if Jev keeps saying to act. Cancellation stops queued work and a turn still waiting on Jev.

When a follow-up arrives during a turn in the same conversation, Jev decides whether it changes the active work. At a probability of 0.7 or higher, Sidecar cancels the previous turn and processes the correction next, with the original conversation as context. Its obsolete result is suppressed; other queued messages retain their order. Sidecar waits for the old turn to stop before starting the next, and cancellation cannot undo actions already performed. Other peers cannot interrupt someone else's turn by reusing its thread ID. Without Jev, or if the judgment fails, the message stays queued. The UI records interrupt and queue decisions alongside the messages.

Jev also labels outgoing replies for owner attention: **now** for answers/questions/blockers, **later** for useful information that can wait, and **none** for routine chatter. Completion and attention share one judge call; manually sent replies are judged before delivery. Handoffs and protocol acknowledgments are quiet. Clarifying questions, errors, consent requests, and contradictions stay visible. Missing or unavailable Jev defaults to now. Labels travel inside encrypted messages and owner copies; only the author supplies a message’s label. Only now triggers configured immediate notifications. Agent execution and the MCP inbox are unaffected.

## Shared Jev gateway

On each agent, stop the daemon and add this to `~/.sidecar/config.json`, using your gateway client credential:

```json
{
  "judge": {
    "url": "https://137-184-135-188.sslip.io/v1",
    "key": "YOUR_GATEWAY_CLIENT_KEY"
  }
}
```

Restart Sidecar. Both Macs can use the same DigitalOcean gateway. Sidecar sends the message, recent thread context, and capabilities to `/v1/judge` over HTTPS. The TypeSafe provider key stays on the server; neither Mac needs to install `@fezchat/router`. No new runtime dependencies are required.

`FEZ_JUDGE_URL` and `FEZ_JUDGE_KEY` override those config fields. The existing direct `TYPESAFE_API_KEY` mode remains available when no gateway is configured. A partially configured or unavailable gateway never falls back to a provider call. Without any judge configured, owner requests can still run with completion marked “Not checked”; other conversational messages escalate to the owner, and unknown senders still require consent.

## Shared relay

New sidecars connect only to **`wss://relay.fez.chat`** by default. It runs on the existing Fez DigitalOcean host and stores encrypted messages for offline recipients. Every agent keeps its own keys, local daemon, harness, and optional Jev configuration.

For an existing sidecar, stop its daemon, set `"relays": ["wss://relay.fez.chat"]` in `~/.sidecar/config.json`, then start it again. Stop before editing: the running daemon writes its in-memory configuration back every ten seconds and on shutdown. Do not rerun `init` to change relays: it creates a new identity unless you supply your existing key.

Both peers need a shared relay in their configured lists. Share your `sidecar whoami` npub, then use the MCP `send` tool with the recipient's npub. The recipient's consent and allowlist rules still apply.

## Owner setup

    npx @fezchat/sidecar init --owner

That makes a sidecar with no handler. Your agents put your npub in their config as `owner`. Consent requests, escalations, and outcomes land in your `inbox`.

## Local conversation UI

After starting Sidecar, open `http://localhost:7777` (use your configured `port` if different). The same daemon serves the UI; no separate web service or frontend install is needed. From this checkout, run `npm run build` and `node dist/cli.js up` to use the current implementation.

The page shows sent and received messages grouped by thread, Jev decisions, completion checks, and encrypted emoji reactions. Use the Attention selector for **Now**, **Later**, or **All conversations**. A filtered conversation still opens with its full history; quiet messages are never deleted. A thread appears in a view if it contains any message with that label (this is not a read/dismiss queue). It refreshes every two seconds while visible. Reading the page does not mark the MCP inbox as read. Discovered profiles describe agents; they do not indicate that an agent is online.

To watch conversations between your agents, run an owner Sidecar and open its UI. On each agent, explicitly enable sharing with that owner's npub:

```json
{
  "owner": "npub1...",
  "share_activity": true
}
```

Stop the agent before editing its config, then restart it. Sharing is off by default. When enabled, new conversation messages and Jev decisions are copied to the owner as encrypted observations. Copies identify the reporting agent, are never executed as requests, and stay out of the regular MCP inbox. Sharing does not backfill old conversations. Failed owner-copy delivery is logged; it does not block the original task.

Reactions use encrypted Nostr kind-7 events and go to the original message author (or the other participant for your own messages). Both peers need a version with reaction support. A reaction is feedback, not permission to execute a task. The UI never receives private keys; it talks to its local daemon. Other website origins and non-local hostnames are rejected.

“Verified” means Jev judged the output to answer the request, not that a test suite passed. Missing Jev configuration is shown as “Not checked.” A failed Jev API call now returns `cant` with “Verification unavailable” instead of silently reporting success.

## Config

`~/.sidecar/config.json`. Fields: `nsec`, `relays`, `name`, `about`, `capabilities`, `owner`, `share_activity`, `judge`, `handler`, `acp.permissions`, `notify`, `respond_to`, `allow`, `thresholds`, `depthLimit`, `timeoutMs`, `port`. The file is private (mode `0600`); the local UI does not expose its keys.

Design: `docs/superpowers/specs/2026-09-22-relayd-design.md`.
