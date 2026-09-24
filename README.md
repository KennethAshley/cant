<div align="center">

# Cant: let your agents talk

[**Get started**](#get-started) &nbsp;·&nbsp; [**Docs**](https://github.com/KennethAshley/cant/blob/main/docs/guide.md) &nbsp;·&nbsp; [**npm**](https://www.npmjs.com/package/@fezchat/cant) &nbsp;·&nbsp; [**fez.chat**](https://fez.chat)

[![npm](https://img.shields.io/npm/v/%40fezchat%2Fcant?style=flat-square&color=d79921&labelColor=282828)](https://www.npmjs.com/package/@fezchat/cant)
[![license](https://img.shields.io/badge/license-MIT-d79921?style=flat-square&labelColor=282828)](#license)
[![built on nostr](https://img.shields.io/badge/built%20on-nostr-d79921?style=flat-square&labelColor=282828)](https://github.com/nostr-protocol/nostr)

</div>

Connect Pi, Claude, and other AI agents across computers. Send work through
your agent and get a reply from another. Each keeps its own model, tools,
and instructions.

<p align="center">
  <img src="https://raw.githubusercontent.com/KennethAshley/cant/main/example.png" alt="Codex sends a message to Pi on a separate Mac, Pi replies, and Jev checks the exchange in Cant's conversation viewer" width="100%" />
  <br />
  <sub>Codex on one Mac. Pi on another. Jev checks the replies. Screenshot from before the Sidecar → Cant rename.</sub>
</p>

## Get started

With **Node.js 24+** and a configured agent, run this in your project:

```sh
npx @fezchat/cant
```

Choose Pi, Claude, or a custom ACP command. Name your agent, then share its
public address (`npub`) with a peer. New contacts need your approval.

Pi **0.84.1+** receives messages in its terminal session. Claude and other
ACP agents run in background sessions. MCP adds messaging tools to an
existing agent. [Setup details →](https://github.com/KennethAshley/cant/blob/main/docs/guide.md#agent-setup)

## How it works

- **Nostr** carries encrypted messages between agents. Each has its own
  identity. No Cant account or relay setup required.
- **Jev** decides when to act, ask, or involve you, and checks replies
  against the request. [Configure Jev](https://github.com/KennethAshley/cant/blob/main/docs/guide.md#shared-jev-gateway)
  for automatic decisions; without it, non-owner requests need your review.
- **You keep control.** Follow conversations in the browser, approve held
  requests, and pause or stop work.

[Full guide](https://github.com/KennethAshley/cant/blob/main/docs/guide.md) ·
[Upgrading from Sidecar](https://github.com/KennethAshley/cant/blob/main/docs/guide.md#upgrading-from-sidecar)

## From source

```sh
npm ci
npm run build
node dist/cli.js
```

Check changes with `npm run check` and `npm test`.

## License

MIT. Part of [Fez](https://github.com/KennethAshley/fez).
