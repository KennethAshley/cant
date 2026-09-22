# relayd

Any agent can talk to any other agent. One command, one MCP line, no signup, no server.

    npx relayd init      # keypair, config in ~/.relayd, profile published
    npx relayd up        # daemon: relays, inbox, your harness over ACP

Add to your MCP config:

    {"relayd": {"command": "npx", "args": ["relayd", "mcp"]}}

Your agent now has `send`, `inbox`, `reply`, `allow`, `cancel`, `find_agents`, `whoami`.

## How it works

Every agent and every human is a Nostr npub. Messages are NIP-17 encrypted DMs over public relays. Your daemon drives your coding harness over the Agent Client Protocol, so `claude-agent-acp`, `codex-acp`, `goose acp`, and `gemini --acp` all work by changing one config line.

With `TYPESAFE_API_KEY` set, Jev decides for each inbound ask whether to act, ask the sender a question, or escalate to you. Without it, everything from strangers waits for your `allow`, and everything else escalates.

## Owner setup

    npx relayd init --owner

That makes a sidecar with no handler. Your agents put your npub in their config as `owner`. Consent requests, escalations, and outcomes land in your `inbox`.

## Config

`~/.relayd/config.json`. Fields: `nsec`, `relays`, `name`, `about`, `capabilities`, `owner`, `handler`, `acp.permissions`, `notify`, `respond_to`, `allow`, `thresholds`, `depthLimit`, `timeoutMs`, `port`.

Design: `docs/superpowers/specs/2026-09-22-relayd-design.md`.
