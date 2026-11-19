# n8n-nodes-livekit

LiveKit control-plane nodes for n8n. No audio: the nodes call LiveKit's server
API and receive its webhook events. The agent worker that carries the call
stays outside n8n.

Status: 0.1.0. A community node package, built as-is for evaluation. It is not
an official n8n node, does not ship with n8n and carries no support commitment.
It is not affiliated with LiveKit.

## Contents

| Part | Type name | What it does |
|---|---|---|
| Credential | `liveKitApi` | Server URL, API key, API secret |
| Credential | `liveKitSipTrunkAuthApi` | Username and password for SIP trunk digest authentication |
| LiveKit | `liveKit` | Rooms, participants, SIP transfer and outbound call, agent dispatch, access tokens. Usable as an AI Agent tool. |
| LiveKit Trigger | `liveKitTrigger` | Starts a workflow on a LiveKit webhook event, signature verified |

## Operations

| Resource | Operations |
|---|---|
| SIP | Transfer Participant (REFER), Create Participant (outbound call) |
| SIP Trunk | Create (inbound or outbound), Get Many, Delete |
| SIP Dispatch Rule | Create (direct, individual, callee; optional agent dispatch), Get Many, Delete |
| Room | Create, Get Many, Delete, Update Metadata |
| Participant | Get, Get Many, Remove, Update, Send Data |
| Agent Dispatch | Create, Get Many, Delete |
| Access Token | Create (local signing, no request) |

Every API request carries a token signed for that request: 60 s lifetime, only
the grants the operation needs.

Trunk digest authentication takes its username and password from the
`liveKitSipTrunkAuthApi` credential, never from a node field. Trunk passwords
are stripped from every API response before it reaches the workflow.

Not covered: dispatch rule PINs.

## Trigger setup

LiveKit has no API to register a webhook URL. Copy the trigger's URL into
`webhook.urls` in the server config, or into the LiveKit Cloud project
settings. The trigger rejects any request whose token signature, issuer,
expiry or body hash does not check out (401, no execution).

## What has been tested

| Test | Result |
|---|---|
| Unit tests (token claims per operation, webhook signature accept and reject, request shapes) | 37 pass |
| `scripts/smoke.js` against LiveKit server 1.13.11 (self-hosted) and LiveKit Cloud | 27 of 27 checks |
| Loaded into n8n 2.35.5 (self-hosted, regular mode) through `N8N_CUSTOM_EXTENSIONS` | credential test, action node and trigger work |
| Trigger with real LiveKit events (`application/webhook+json`) | signed events start executions, unsigned requests get 401 |
| Browser participant joined with a token from the Access Token operation | update, room metadata, send data and remove work on it |
| SIP dispatch: inbound trunk and dispatch rule created with the node, real inbound call routed | works |
| SIP transfer (REFER) on a live call over a Twilio Elastic SIP trunk with call transfer enabled | `STS_TRANSFER_SUCCESSFUL`, transferred call answered |

Not tested: queue mode, use as an AI Agent tool, the outbound call operation
against a real carrier, any carrier other than Twilio.

## Known limits

- No operation for LiveKit's phone-number API. A number rented from LiveKit is
  bound to a dispatch rule in the LiveKit console.
- No update operation for trunks and dispatch rules; delete and create.
- LiveKit refuses a transfer on a number rented from LiveKit (403, "transfers
  are not supported for this phone number type"). Transfers need a SIP trunk
  whose provider accepts SIP REFER.
- Dispatch rule create sends the `dispatch_rule` message, not the older flat
  fields. An older LiveKit server may not accept it.
- n8n Cloud does not accept private custom nodes.

## Build and test

```
npm install --ignore-scripts
npm run build
npm test
```

Zero runtime dependencies. Signing uses Node `crypto`.

## Install

Self-hosted n8n only. Build, then put `package.json` and `dist/` in a folder
named `n8n-nodes-livekit` under the directory that `N8N_CUSTOM_EXTENSIONS`
points to, and restart n8n (`scripts/stage-lab.sh` builds and stages exactly
those files). The nodes then appear as LiveKit and LiveKit Trigger; in workflow
JSON their types are `CUSTOM.liveKit` and `CUSTOM.liveKitTrigger`. In queue
mode the package must be on main, every worker and every webhook process, same
version.

The server URL in the credential may be `https://` or `wss://`.

## Licence

MIT, see `LICENSE`.

## Source of the API facts

Method names, request fields and grants follow `livekit/protocol`
(`livekit_room.proto`, `livekit_sip.proto`, `livekit_agent_dispatch.proto`,
`livekit_webhook.proto`, `auth/grants.go`) and the grants used by
`livekit-server-sdk`, read 2026-11-17.
