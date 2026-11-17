# n8n-nodes-livekit

LiveKit control-plane nodes for n8n. No audio: the nodes call LiveKit's server
API and receive its webhook events. The agent worker that carries the call
stays outside n8n.

Status: 0.1.0, unit-tested, not yet run against a LiveKit server.

## Contents

| Part | Type name | What it does |
|---|---|---|
| Credential | `liveKitApi` | Server URL, API key, API secret |
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

Not covered: trunk digest authentication (username and password) and dispatch
rule PINs. Both are secrets and would need a credential type, not a node field.
Restrict inbound trunks by allowed addresses or numbers instead.

## Trigger setup

LiveKit has no API to register a webhook URL. Copy the trigger's URL into
`webhook.urls` in the server config, or into the LiveKit Cloud project
settings. The trigger rejects any request whose token signature, issuer,
expiry or body hash does not check out (401, no execution).

## Build and test

```
npm install --ignore-scripts
npm run build
npm test
```

Zero runtime dependencies. Signing uses Node `crypto`.

## Install

Self-hosted n8n only. Mount `dist/` and `package.json` under the directory in
`N8N_CUSTOM_EXTENSIONS`. In queue mode the package must be on main, every
worker and every webhook process, same version.

## Source of the API facts

Method names, request fields and grants follow `livekit/protocol`
(`livekit_room.proto`, `livekit_sip.proto`, `livekit_agent_dispatch.proto`,
`livekit_webhook.proto`, `auth/grants.go`) and the grants used by
`livekit-server-sdk`, read 2026-11-17.
