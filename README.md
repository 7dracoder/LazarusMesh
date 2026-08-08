# Lazarus Mesh

Lazarus Mesh is a local-first hackathon MVP for recovering legally authorized digital artifacts that still have a valid content commitment but no available complete copy.

The included mission starts with a bundled CC0 rainfall dataset at zero seeders. The system discovers an archive provider, bargains a `$12.00` ask down to a binding `$9.75` quote, creates tightly bounded payment authority, reconstructs and verifies all 24 pieces, releases a recovery bounty, and restores two seeders.

## What is implemented

The release has two explicit modes:

| Mode | Rain | Bargaining | Monad | x402 | Recovery |
| --- | --- | --- | --- | --- | --- |
| `local` (default) | Deterministic local scoped-card adapter | Deterministic local merchant | Local bounty ledger | Local HTTP 402 handshake | Real local bytes, hashes, and reconstruction |
| `rain-sandbox` | External Rain sandbox API for collateral simulation, scoped cards, authorization/decline, and settlement simulation | Deterministic local merchant | Local bounty ledger | Local HTTP 402 handshake | Real local bytes, hashes, and reconstruction |

`rain-sandbox` is therefore a hybrid sandbox mode. It makes authenticated external Rain sandbox calls, but it does not send real money. Monad bounty execution and x402 settlement remain local in both modes.

When public Monad RPC and x402 facilitator URLs are configured, `/api/health` performs read-only readiness checks:

- Monad `eth_chainId` must report testnet chain `10143` (`eip155:10143`).
- The facilitator `/supported` response must advertise x402 v2, the `exact` scheme, and `eip155:10143`.
- No transaction is signed, no contract is called, and `writesEnabled` remains `false` even if signing fields are present.

## The bargaining flow

Merchant negotiation is deterministic and bounded:

1. Atlas Archive Cloud asks `$12.00`.
2. The buyer offers its `$9.00` target.
3. Atlas counters at `$10.50`.
4. The buyer offers `$9.75`.
5. Atlas accepts and issues a 15-minute binding quote.

Before payment, a separate fail-closed quote policy verifies the quote digest, session, merchant, MCC, content root, purpose, currency, amount, budget, terms, round count, approval threshold, and expiry. The accepted terms are one-time archival egress with no renewal, data sharing, or exclusivity.

The result saves `$2.25`, or `18.75%`, from the initial ask. A Rain card is created only after the quote passes both quote validation and the general spending policy.

## Exact default economics

| Item | Amount | Counted in mission `spentMinor`? |
| --- | ---: | --- |
| Local x402 availability intelligence | `$0.01` | Yes |
| Negotiated archive purchase | `$9.75` | Yes |
| Blocked unrelated purchase | `$9.00` | No |
| Recovery bounty | `$5.00` | Tracked separately as local escrow/reward |
| Provider collateral requirement | `$2.00` | Tracked separately in the local Monad ledger |
| Default mission budget | `$20.00` | Budget ceiling |

Successful mission spend is exactly `$9.76`: one cent for discovery plus `$9.75` for the archive purchase. The `$5.00` bounty is released cumulatively at 70%, 90%, and 100%, corresponding to `$3.50`, then `$1.00`, then `$0.50` incremental releases.

In `rain-sandbox` mode, the adapter also simulates `$20.00` of rUSD collateral funding by default before its first card issuance. That is Rain sandbox setup, not mission spend, and no real funds move. Set `RAIN_AUTO_FUND_MINOR=0` only when the provisioned Rain contract already has enough sandbox collateral.

## Run locally

Requires Node.js 20 or later. There are no runtime package dependencies and no `npm install` step.

```sh
node server.js
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The default mode requires no `.env` file, makes no payment or chain network calls, and prints:

```text
Lazarus Mesh (local): http://127.0.0.1:4173
All payment and chain execution is local.
```

To use a different port:

```sh
PORT=5000 node server.js
```

The server always binds to `127.0.0.1`; changing `PORT` does not expose it to the LAN.

## Run with Rain sandbox

Copy `.env.example` to `.env`, set:

```text
ADAPTER_MODE=rain-sandbox
RAIN_API_KEY=...
RAIN_USER_ID=...
RAIN_TEAM_ID=...
RAIN_CONTRACT_ID=...
```

Then run:

```sh
node server.js
```

The built-in `.env` loader does not override values already supplied by the process environment. `.env` is ignored by source control.

The Rain sandbox adapter performs these documented calls:

```text
GET  /issuing/transactions                         authenticated health check
POST /simulate/collateral/fund                     sandbox rUSD collateral simulation
POST /issuing/users/{userId}/cards/scoped          scoped-card creation
POST /simulate/transactions/authorize              allowed or deliberate blocked authorization
POST /simulate/transactions/{id}/settle            capture approved archive authorization
POST /simulate/transactions/{id}/reverse           reverse an unexpected demo authorization
GET  /issuing/cards/{cardId}                        safe card-status reconciliation
```

Only safe metadata such as card ID, status, and last four digits enters application state. Rain's `encryptedPan` and `encryptedCvc` response fields are discarded immediately and never reach logs, JSON persistence, SSE, audit exports, the browser, or a model.

### Rain enforcement boundary

The public hackathon scoped-card endpoint directly accepts:

- requested amount;
- MCC allowlist; and
- absolute expiry.

Lazarus additionally enforces the exact binding quote, merchant identity, purpose, one-transaction rule, and task scope in deterministic application policy. The sandbox API does not expose those fields as scoped-card controls.

Rain applies a default 1.2× authorization buffer. For the accepted `$9.75` quote, the remote card may have up to an `$11.70` Rain ceiling, while Lazarus still permits only the exact `$9.75` quote. The public sandbox also has no documented card-cancel endpoint. At mission completion, Lazarus disables local authority and records `expiry_scheduled`; the remote card remains constrained by its short quote expiry.

The deliberate blocked demo uses an unrelated merchant and MCC. Merchant identity is rejected by Lazarus policy; the Rain sandbox request exercises the card's MCC control. If the sandbox unexpectedly authorizes the challenge, the adapter immediately requests an authorization reversal and still reports the policy violation.

Default Rain sandbox limits are 10 active scoped cards, 10 scoped cards created per user in a rolling 24-hour window, and `$5,000` approved scoped-card spend per user in a rolling 24-hour window. Repeated hybrid demos can consume the creation quota. Complete a mission before resetting; reset is blocked while an active sandbox card is present and does not remotely cancel cards.

## Test

Run the complete suite:

```sh
node --test
```

Check server syntax and then run all tests:

```sh
node --check server.js
node --test
```

Rain sandbox tests use injected fake `fetch` implementations and dummy credentials. The normal test suite never contacts Rain, Monad, or an x402 facilitator and never needs secrets.

## Demo workflow

1. Open the dashboard and confirm its `LOCAL` or `HYBRID SANDBOX` mode.
2. Review the CC0 rights evidence, `$20.00` budget, and bounded policy.
3. Select **Run full recovery**, or step through the nine actions.
4. Watch the `$12.00 → $9.00 → $10.50 → $9.75` negotiation transcript.
5. Confirm the one-cent x402 receipt and `$9.75` archive settlement.
6. Confirm the unrelated `$9.00` challenge is declined and does not count as spend.
7. Watch all 24 pieces become recovered and verified.
8. Confirm the reconstructed SHA-256 matches, the `$5.00` reward reaches 100%, and two seeders exist.
9. Export the audit JSON.
10. In local mode, reset freely. In hybrid mode, complete the mission before resetting.

See [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) for a four-minute presentation script.

## Architecture

```text
Browser dashboard
  -> loopback Node HTTP/REST/SSE server
  -> mission orchestrator
     -> deterministic quote policy + spending policy
     -> local bargaining adapter
     -> local Rain adapter OR external Rain sandbox adapter
     -> local Monad bounty ledger
     -> local x402 handshake
     -> local recovery engine operating on real fixture bytes
  -> JSON audit snapshot (.data/state.json)

Optional read-only health path
  -> Monad testnet RPC eth_chainId
  -> x402 facilitator /supported
```

The browser uses plain HTML, CSS, and JavaScript. The server uses Node built-ins. `.data/state.json` is an audit snapshot, not a resumable external-payment ledger; every server start creates a fresh coherent application session.

## Important files

```text
server.js                              HTTP, REST, SSE, adapter selection, health
src/config.js                          .env loading and safe configuration mapping
src/orchestrator.js                    Nine-step recovery and negotiation workflow
src/demo-state.js                      Default mission, economics, and policies
src/services/negotiation-local.js      Deterministic bounded bargaining
src/services/rain-local.js             Local scoped-card simulation
src/services/rain-sandbox.js           External Rain sandbox adapter
src/services/monad-local.js            Local bounty/collateral/reward ledger
src/services/monad-network.js          Read-only Monad/x402 readiness probes
src/services/x402-local.js             Local HTTP 402 payment handshake
src/services/recovery-local.js         Real byte splitting and reconstruction
src/domain/negotiation-policy.js       Binding quote digest and validation
src/domain/policy.js                   Deterministic spending authorization
public/                                Dashboard
contracts/RecoveryBountyRegistry.sol   Future Solidity reference, not deployed
tests/                                 Local, sandbox-adapter, and HTTP tests
fixtures/cc0-rainfall-dataset/         Bundled CC0 artifact
```

## API routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Adapter status, Rain authentication check, and optional read-only Monad/x402 readiness |
| `GET` | `/api/state` | Public application state |
| `GET` | `/api/events` | Server-sent state updates |
| `POST` | `/api/demo/reset` | Reset local state; blocked while recorded hybrid Rain authority can still be live remotely |
| `POST` | `/api/missions` | Create a verified fixture-backed mission with explicit rights and published budget limits |
| `POST` | `/api/missions/:id/step` | Execute the next recovery step |
| `POST` | `/api/missions/:id/run` | Execute all remaining steps |
| `GET` | `/api/missions/:id/negotiation` | Read the mission negotiation record |
| `POST` | `/api/missions/:id/negotiation` | Execute/replay bargaining after discovery |
| `POST` | `/api/missions/:id/blocked-purchase` | Exercise an additional policy challenge |
| `GET` | `/api/missions/:id/export` | Download mission audit JSON |

Mission creation requires explicit rights attestation. The current fixture flow publishes a conservative minimum recovery-service spend cap of `1201` minor units even though the deterministic negotiated run spends `976` minor units. The provider bounty is a separate commitment, so maximum authorized exposure is the service cap plus the bounty. Limits are available in `GET /api/state` under `system.missionCreation`; the API returns stable codes plus human-readable messages and no longer silently clamps out-of-range values or ignores mismatched content roots.

## Safety and operational boundaries

- The included artifact is synthetic and CC0.
- Use only public-domain, openly licensed, creator-authorized, or enterprise-owned content.
- This is not a torrent search engine and must not recover unauthorized copyrighted, leaked, malicious, or access-controlled data.
- Secrets stay in server-side environment variables; never place API keys or private keys in source, browser code, prompts, logs, screenshots, or audit exports.
- All external Rain writes use stable 64-character idempotency keys, bounded retries, timeouts, and same-origin redirect checks.
- Application policy remains mandatory even when Rain independently enforces supported controls.
- `rain-sandbox` means external sandbox behavior, not production cards or real funds.
- Monad/x402 readiness checks are informational and read-only. The current runtime never signs Monad transactions or settles a live x402 payment.
- The Solidity contract is an unaudited future reference and is not used by the server.
- The server is loopback-only and applies host/origin checks, request-size limits, security headers, and path-containment checks.

## Further documentation

- [Complete project guide](PROJECT_GUIDE.md)
- [Live API integration guide](docs/API_INTEGRATION.md)
- [Production-readiness boundary](docs/PRODUCTION_READINESS.md)
- [Master product blueprint](LAZARUS_MESH_MASTER_PLAN.md)
- [Rain + Monad dossier](RAIN_MONAD_DOSSIER.md)
- [Original build brief](HACKATHON_BUILD_BRIEF.md)

## Status

Hybrid hackathon MVP. Rain sandbox integration is implemented. Bargaining, Monad settlement, x402 settlement, and recovery-provider networking remain deterministic/local except for optional read-only Monad/x402 readiness probes. It is not production-ready.

See [Production readiness](docs/PRODUCTION_READINESS.md) for the exact live/simulated boundary, current configuration gaps, crash-safety requirements, and the staged path to a testnet-live release.
