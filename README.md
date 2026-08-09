# Lazarus Mesh

Lazarus Mesh is a local-first hackathon MVP for recovering legally authorized digital artifacts that still have a valid content commitment but no available complete copy.

The included mission starts with a bundled CC0 rainfall dataset at zero modeled replicas. The system discovers a provider, bargains with a local merchant model from a USD 12.00 reference ask to a policy-bound USD 9.75 reference quote, applies tightly bounded payment authority, reconstructs and verifies all 24 local fixture pieces, advances a demo bounty ledger, and models two replicas. Mission accounting is selectable in USD, EUR, GBP, CAD, or AUD using a fixed demo rate set.

## What is implemented

The release has two independent adapter selectors:

| Selector | Values | Effect |
| --- | --- | --- |
| `ADAPTER_MODE` | `local` (default), `rain-sandbox` | Selects local Rain simulation or authenticated Rain sandbox calls. |
| `MONAD_EXECUTION_MODE` | `local` (default), `x402-testnet` | Selects the x402-shaped local discovery simulation or a bounded real test-USDC x402 payment on Monad testnet. |

Merchant bargaining, artifact recovery, verifier roles, reseeding, and the complete Monad bounty lifecycle remain deterministic/local under every combination. `x402-testnet` swaps only the one-cent availability-discovery payment. Rain sandbox accepts USD mission accounting only and uses sandbox rUSD collateral. Monad x402 settles the official test-USDC asset; MON is Monad's native gas asset for the seller/facilitator that submits settlement.

The public production deployment is fully local-only. A separate Vercel branch preview can be armed for one protected x402 testnet run: a dedicated Privy payer server wallet signs, a distinct receive-only payee receives, and the co-located seller durably records payment identifiers in Neon. That preview requires Vercel Deployment Protection, branch-scoped secrets, an isolated state key, a fixed one-cent cap, and the single bundled mission; reset and arbitrary mission creation are disabled.

See [Hackathon Acceptance and Currency Model](docs/HACKATHON_ACCEPTANCE_AND_CURRENCY.md) for the exact rail, currency, and bounty-acceptance boundary.

## Who the merchants and agents are

The running app does **not** contact a real bargaining merchant or a network of autonomous agents:

- **Atlas Archive Cloud** is the single simulated seller model.
- **Atlas Archive Node** is a simulated provider identity backed by the bundled fixture file.
- **Lazarus buyer policy** is the deterministic orchestrator; it is not an LLM or free-form chat agent.
- **North, East, and West Verifier** are scripted local quorum roles.
- **Rain, Monad, and x402 are rails/infrastructure, not merchants or agents.**
- **Privy payer** is a server wallet used only to sign a tightly restricted test-USDC authorization in the protected preview; it does not bargain.
- **Receive-only payee** is a different wallet. The app needs only its public address and never needs its private key to receive.
- **Lazarus x402 seller** is a paid availability API enabled only in the protected preview. It is not the Atlas bargaining merchant.

Their offers, counters, quotes, verification decisions, and receipts are structured local state transitions. No external Atlas business, provider endpoint, marketplace, seeder network, or verifier service is contacted. See [Actors, Merchants, and Live Integration](docs/ACTORS_AND_MERCHANTS.md) for the complete boundary and the exact setup required for real agent-to-agent communication.

When public Monad RPC and x402 facilitator URLs are configured, `/api/health` can perform separate read-only readiness checks:

- Monad `eth_chainId` must report testnet chain `10143` (`eip155:10143`).
- The facilitator `/supported` response must advertise x402 v2, the `exact` scheme, and `eip155:10143`.
- The probe itself never signs or writes. `writesEnabled` becomes true only when `MONAD_EXECUTION_MODE=x402-testnet` successfully constructs the live x402 adapter; bounty writes remain false.

## The bargaining flow

The merchant negotiation is deterministic, local, and bounded. The following USD transcript is the reference flow; EUR, GBP, CAD, and AUD missions use fixed demo reference equivalents:

1. Atlas Archive Cloud asks `$12.00`.
2. The buyer offers its `$9.00` target.
3. Atlas counters at `$10.50`.
4. The buyer offers `$9.75`.
5. The Atlas model accepts and issues a 15-minute policy-bound demo quote.

Before simulated payment authorization, a separate fail-closed quote policy verifies the quote digest, session, merchant, MCC, content root, purpose, currency, amount, budget, terms, round count, approval threshold, and expiry. The accepted terms are one-time archival egress with no renewal, data sharing, or exclusivity. The local digest detects mutation; it is not a signature from a real merchant.

The USD reference result saves `$2.25`, or `18.75%`, from the initial ask. A Rain card is created only after the quote passes both quote validation and the general spending policy.

## Exact default USD economics

| Item | Amount | Counted in mission `spentMinor`? |
| --- | ---: | --- |
| Local x402 availability intelligence | `$0.01` | Yes |
| Negotiated archive purchase | `$9.75` | Yes |
| Blocked unrelated purchase | `$9.00` | No |
| Recovery bounty | `$5.00` | Tracked separately as local escrow/reward |
| Provider collateral requirement | `$2.00` | Tracked separately in the local Monad ledger |
| Default mission budget | `$20.00` | Budget ceiling |

Successful USD mission policy usage is exactly `$9.76`: one cent for discovery plus `$9.75` for the archive allocation. In local and deployed demo mode this is simulated accounting—`$0.00` is charged. With the minimum `$12.01` service cap, the UI therefore shows `$2.25` as **demo reserve remaining**. The Deal tab separately shows the same `$2.25` as **negotiated savings** from the `$12.00` ask; neither number means payment failed. The `$5.00` bounty is advanced locally at 70%, 90%, and 100%, corresponding to `$3.50`, then `$1.00`, then `$0.50` incremental demo-ledger entries.

For non-USD missions, every mission amount is stored and rendered in the selected currency's minor units. The fixed `lazarus-demo-reference-v1` table uses 100 USD cents, 92 euro cents, 78 pence, 137 Canadian cents, or 152 Australian cents per reference USD. These are deterministic demo values, not current market FX rates or a conversion service. Required reserves and debits round conservatively.

In `rain-sandbox` mode, the adapter can also simulate a configured amount of rUSD collateral funding before first card issuance. That is Rain sandbox setup, not mission spend or an account balance, and no real funds move. `RAIN_AUTO_FUND_MINOR` defaults to `0`; set a positive USD-cent amount only when deliberate sandbox provisioning is required.

## Deploy to Vercel with free Postgres

The repository now includes a Vercel serverless API (`api/index.js`) and a free Neon Postgres integration. A Vercel rewrite sends every nested `/api/*` route to that function while preserving the route for the Node request handler. The deployment stores the complete demo audit snapshot in Postgres instead of `.data/state.json`, reloads it before each API request, and rebuilds the deterministic local adapter ledgers before a mission continues. The browser uses five-second polling on Vercel because long-lived SSE connections are not a reliable serverless transport.

Deploy public production from the repository root after accepting the Neon marketplace terms and connecting the integration in Vercel:

```sh
vercel integration add neon --name lazarus-mesh-db --plan free_v3 -e production -e preview -e development -m region=iad1 -m auth=false
vercel --prod
```

The integration supplies `DATABASE_URL` automatically. Public production must keep:

```text
ADAPTER_MODE=local
MONAD_EXECUTION_MODE=local
X402_SELLER_ENABLED=false
ALLOW_EXTERNAL_WRITES_ON_VERCEL=false
LAZARUS_STATE_KEY=primary
```

Do not put Privy or Rain credentials in the production environment. Public production runs the verified fixture, selectable accounting currencies, local bargain, local Monad ledger, x402-shaped local simulation, and local scoped-card simulation.

### Protected one-shot branch preview

Create a branch-scoped Vercel Preview environment, enable Vercel Deployment Protection, and set placeholders like these through Vercel's encrypted environment-variable controls:

```text
ADAPTER_MODE=local
MONAD_EXECUTION_MODE=x402-testnet
ALLOW_EXTERNAL_WRITES_ON_VERCEL=true
LIVE_PREVIEW_BRANCH=<protected-branch>
LAZARUS_STATE_KEY=preview-<unique-run>
X402_SELLER_ENABLED=true

PRIVY_APP_ID=<server-side-app-id>
PRIVY_APP_SECRET=<encrypted-secret>
PRIVY_PAYER_WALLET_ID=<dedicated-test-wallet-id>
PRIVY_PAYER_ADDRESS=<payer-address>
MONAD_PAY_TO_ADDRESS=<different-payee-address>

MONAD_RPC_URL=<credential-free-https-rpc>
X402_EXPECTED_AMOUNT_ATOMIC=10000
X402_MAX_PAYMENT_ATOMIC=10000
X402_MAX_AUTHORIZATION_SECONDS=300
MONAD_X402_CONFIRMATIONS=6
```

Vercel supplies its deployment and branch host variables, and the runtime derives `X402_AVAILABILITY_BASE_URL` from that protected host. It also uses the isolated state key as the x402 payment-ID namespace, so a deliberately new preview cycle cannot collide with an older seller record. The runtime verifies the metadata, refuses production/development targets, forbids `MONAD_PRIVATE_KEY`, requires an isolated `preview-*` state key, and accepts only the single bundled mission. The immutable preview mission receives a 30-day demo window; reset and arbitrary mission creation remain disabled. The buyer reaches the co-located seller through an internal same-origin transport so it does not bypass Vercel Deployment Protection; the HTTP seller route remains protected for protocol inspection.

The payee is receive-only: do not upload its seed phrase or private key. Fund only the Privy payer with the capped test USDC needed for the run. Attach a restrictive Privy wallet policy, and keep every secret branch-scoped. A live preview is still a testnet integration demo, not a production payment service.

## Run locally

Requires Node.js 20 or later.

```sh
npm install
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

Current activation blocker: leave `ADAPTER_MODE=local` until the previously disclosed sandbox API credential has been rotated and Rain supplies a valid collateral/contract UUID. The previously supplied collateral value is not UUID-valid; do not guess or edit it into a plausible identifier. The adapter is implemented and tested, but deployment configuration is intentionally not armed while either prerequisite is missing.

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

Rain sandbox mission creation is intentionally USD-only. Select local Rain mode to demonstrate EUR, GBP, CAD, or AUD accounting; those currencies are not sent to Rain's hackathon card sandbox.

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

## Run one real Monad x402 testnet discovery payment

This is an opt-in, capped integration mode. It can move official Monad test USDC. The EIP-3009 authorization is gasless for the buyer; the submitting seller/facilitator needs testnet MON for chain gas. It does not make the bounty registry live.

```text
MONAD_EXECUTION_MODE=x402-testnet
MONAD_RPC_URL=https://...
MONAD_PRIVATE_KEY=...
MONAD_PAY_TO_ADDRESS=0x...
X402_AVAILABILITY_BASE_URL=https://seller.example/availability
```

For local development, `MONAD_PRIVATE_KEY` is a fallback. A managed signer can instead use the four `PRIVY_*` variables shown above; configure one signer type, never both. Vercel live preview forbids raw private keys and requires Privy.

The payer must be a dedicated low-value wallet funded with the required test USDC, the payee must be a different wallet, and the seller must return the expected x402 v2 exact requirement and durable payment-identifier result. Defaults cap discovery at 10,000 USDC atomic units (test USDC 0.01) and require six confirmations. Lazarus first builds and validates the signed authorization, then durably records the pending payment immediately before transmission. A signature or persistence failure sends no paid request; after the durable gate exists, an ambiguous result blocks reset, fresh startup, and another transmission until reconciliation. The protected Vercel preview additionally disables reset and new mission creation even after success.

Do not enable this mode on public production. See [API and Testnet Integration Guide](docs/API_INTEGRATION.md) for every guardrail variable and [Hackathon Acceptance and Currency Model](docs/HACKATHON_ACCEPTANCE_AND_CURRENCY.md) for the acceptance checklist.

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
2. Review the CC0 rights evidence, selected-currency budget, and bounded policy.
3. Select **Run full recovery**, or step through the nine actions.
4. Watch the reference `$12.00 → $9.00 → $10.50 → $9.75` negotiation transcript, converted to the selected demo accounting currency.
5. Confirm the one-cent-reference x402 receipt and the accepted archive settlement in the selected mission currency.
6. Confirm the unrelated challenge is declined and does not count as spend.
7. Watch all 24 pieces become recovered and verified.
8. Confirm the reconstructed SHA-256 matches, the selected-currency demo reward reaches 100%, and two replicas are modeled.
9. Export the audit JSON.
10. In local mode, reset freely. In hybrid mode, complete the mission before resetting.

See [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) for a four-minute presentation script.

## Architecture

```text
Browser dashboard
  -> local: loopback Node HTTP/REST/SSE server
  -> Vercel: serverless API with same-origin mutation guard + polling
  -> mission orchestrator
     -> deterministic quote policy + spending policy
     -> local bargaining adapter
     -> local Rain adapter OR external Rain sandbox adapter
     -> local Monad bounty ledger (always; full registry is not deployed)
     -> x402-shaped local simulation OR opt-in Monad testnet x402 buyer
     -> local recovery engine operating on real fixture bytes
  -> local: JSON audit snapshot (.data/state.json)
  -> Vercel: Neon Postgres JSONB audit snapshot (optimistic revision check)

Protected Vercel preview only
  -> Privy payer server wallet with typed-data allowlist
  -> internal same-origin x402 seller transport
  -> protected x402 availability HTTP route
  -> facilitator verify/settle on Monad testnet
  -> distinct receive-only payee
  -> Neon payment-ID settlement/replay table

Optional read-only readiness path
  -> Monad testnet RPC eth_chainId
  -> x402 facilitator /supported
```

The browser uses plain HTML, CSS, and JavaScript. The server uses Node built-ins. `.data/state.json` is primarily an audit snapshot, not a general external-payment ledger. Normal local startup creates a fresh coherent session, but it fails closed instead when the prior snapshot contains unexpired Rain sandbox authority or an unresolved Monad x402 pending-payment record.

## Important files

```text
server.js                              HTTP, REST, SSE/polling selection, adapter selection, health
api/index.js                           Vercel serverless API + durable request wrapper
src/neon-state.js                      Neon Postgres JSONB state/revision repository
src/rehydrate-local.js                 Rebuilds local demo adapter state per serverless request
src/config.js                          .env loading and safe configuration mapping
src/orchestrator.js                    Nine-step recovery and negotiation workflow
src/demo-state.js                      Default mission, economics, and policies
src/domain/currency.js                 Fixed demo accounting currencies and conservative conversion
src/services/negotiation-local.js      Deterministic bounded bargaining
src/services/rain-local.js             Local scoped-card simulation
src/services/rain-sandbox.js           External Rain sandbox adapter
src/services/monad-local.js            Local bounty/collateral/reward ledger
src/services/monad-network.js          Read-only Monad/x402 readiness probes
src/services/x402-local.js             x402-shaped local discovery simulation
src/services/x402-monad.js             Opt-in bounded Monad testnet x402 buyer
src/services/x402-internal-fetch.js    Preview-only buyer-to-seller transport
src/services/privy-signer.js           Restricted Privy EIP-3009 signer adapter
src/services/x402-seller.js            Protected Monad testnet x402 seller
src/services/x402-seller-store.js      Durable Neon payment-ID settlement store
src/vercel-policy.js                    Production/preview execution safety gate
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
| `GET` | `/api/x402/availability/:contentRoot` | Protected-preview paid availability resource; disabled in public production |
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

Mission creation requires explicit rights attestation and a supported accounting currency. The USD reference minimum service cap is `1201` cents and the successful reference run uses `976` cents; the API publishes conservative currency-specific equivalents and limits in `GET /api/state` under `system.missionCreation`. The provider bounty is separate, so maximum authorized exposure is the service cap plus the bounty. Rain sandbox mode rejects non-USD missions. The API returns stable codes plus human-readable messages and does not silently clamp out-of-range values or ignore mismatched content roots.

## Safety and operational boundaries

- The included artifact is synthetic and CC0.
- Use only public-domain, openly licensed, creator-authorized, or enterprise-owned content.
- This is not a torrent search engine and must not recover unauthorized copyrighted, leaked, malicious, or access-controlled data.
- Secrets stay in server-side environment variables; never place API keys or private keys in source, browser code, prompts, logs, screenshots, or audit exports.
- All external Rain writes use stable 64-character idempotency keys, bounded retries, timeouts, and same-origin redirect checks.
- Application policy remains mandatory even when Rain independently enforces supported controls.
- `rain-sandbox` means external sandbox behavior, not production cards or real funds.
- Rain sandbox is currently unarmed until a rotated API key and valid provider-issued collateral/contract UUID are supplied.
- The local x402 adapter is only x402-shaped simulation. `MONAD_EXECUTION_MODE=x402-testnet` can move capped test USDC; it must use a dedicated payer, distinct payee, protected seller, and durable payment-ID uniqueness.
- Public production is fully local-only. Live testnet buyer and seller are permitted only together on the explicitly armed, deployment-protected, one-shot branch preview.
- The Privy app secret and payer wallet ID stay server-side. The payee is receive-only and does not require a stored payee private key.
- Vercel live mode forbids raw private keys. The Privy signer accepts only the pinned Monad testnet USDC `TransferWithAuthorization` envelope and verifies the returned signature.
- Monad bounty creation, claims, verifier attestations, and tranche releases remain local even when live x402 discovery is enabled.
- The Solidity contract is an unaudited future reference and is not used by the server.
- The server is loopback-only and applies host/origin checks, request-size limits, security headers, and path-containment checks.

## Further documentation

- [Complete project guide](PROJECT_GUIDE.md)
- [Live API integration guide](docs/API_INTEGRATION.md)
- [Production-readiness boundary](docs/PRODUCTION_READINESS.md)
- [Hackathon acceptance and currency model](docs/HACKATHON_ACCEPTANCE_AND_CURRENCY.md)
- [Master product blueprint](LAZARUS_MESH_MASTER_PLAN.md)
- [Rain + Monad dossier](RAIN_MONAD_DOSSIER.md)
- [Original build brief](HACKATHON_BUILD_BRIEF.md)

## Status

Hybrid hackathon MVP. Multi-currency mission accounting, a Rain sandbox adapter, a Privy-backed testnet payer, a durable x402 seller, and an opt-in real Monad testnet availability payment are implemented. Rain is currently configuration-blocked pending a rotated key and valid provider-issued UUID. Bargaining, the archive purchase, the full Monad bounty, recovery-provider networking, verifier independence, and reseeding remain deterministic/local. Public production is fully local-only; the live buyer/seller path is restricted to a protected, one-shot branch preview. It is not production-ready.

See [Production readiness](docs/PRODUCTION_READINESS.md) for the exact live/simulated boundary, current configuration gaps, crash-safety requirements, and the staged path to a testnet-live release.
