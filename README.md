# Lazarus Mesh

Lazarus Mesh is a local-first hackathon MVP for recovering legally authorized digital artifacts that still have a valid content commitment but no available complete copy.

- **Live remote-merchant demo:** [lazarus-mesh-merchant-demo.vercel.app](https://lazarus-mesh-merchant-demo.vercel.app)
- **Merchant operator console:** [lazarus-merchant.vercel.app](https://lazarus-merchant.vercel.app) — enter the private `OPERATOR_TOKEN` from the merchant project's Vercel Production environment. The merchant API token is server-to-server only and must never be entered in the browser.

The included mission starts with a known CC0 artifact at zero modeled replicas. In local mode, the system bargains with the deterministic Atlas model and verifies a bundled 24-piece fixture. In remote mode, it talks to the independently deployed [Lazarus Merchant Service](https://lazarus-merchant.vercel.app) over authenticated HTTPS, verifies an Ed25519-signed quote, downloads an eight-piece sponsor-pinned artifact, and checks every piece plus the reconstructed content hash. Both modes then advance the still-local demo bounty ledger and model two replicas.

The deployed hybrid integration has completed an end-to-end USD acceptance run: two bargaining rounds produced a signed `$9.75` quote, all `8/8` provider pieces verified, and the reconstructed artifact matched the pinned manifest and root. Rain's sandbox ledger independently confirmed the matching `$9.75` settlement and the deliberate `$9.00` unrelated-merchant decline. Those are sandbox card operations, so no real money or chain value moved. Core local mission accounting remains selectable in USD, EUR, GBP, CAD, or AUD using a fixed demo rate set; the deployed merchant accepts one configured currency at a time and is currently configured for USD.

## What is implemented

The release has three independent adapter selectors:

| Selector | Values | Effect |
| --- | --- | --- |
| `ADAPTER_MODE` | `local` (default), `rain-sandbox` | Selects local Rain simulation or authenticated Rain sandbox calls. |
| `MONAD_EXECUTION_MODE` | `local` (default), `x402-testnet` | Selects the x402-shaped local discovery simulation or a bounded real test-USDC x402 payment on Monad testnet. |
| `MERCHANT_MODE` | `local` (default), `remote` | Selects the local Atlas fixture or the authenticated merchant/provider API with a pinned signing key and trusted manifest. |

Remote merchant mode makes bargaining and provider-byte retrieval external. The public hybrid Production profile can also execute the archive allocation in Rain's sandbox, while verifier roles, reseeding, and the complete Monad bounty lifecycle remain deterministic/local. `x402-testnet` swaps only the one-cent availability-discovery payment and cannot be combined with remote merchant mode in the current Vercel safety profile. Rain sandbox accepts USD mission accounting only and uses sandbox rUSD collateral. Monad x402 settles the official test-USDC asset; MON is Monad's native gas asset for the seller/facilitator that submits settlement.

The public deployment runs the remote merchant/provider together with Rain sandbox; Monad x402, the bounty, verifiers, and reseeding remain local in that profile. Rain is allowed on Vercel only with an explicit isolated state key. A separate Vercel branch Preview is armed for one protected x402 testnet run with the pinned local fixture: exactly one dedicated payer signer is configured (a complete Privy server-wallet configuration is preferred, or a dedicated low-value 32-byte raw key), a distinct receive-only payee receives, and the co-located seller durably records payment identifiers in Neon. The verified Preview also used Rain sandbox for its scoped archive allocation; remote merchant/provider mode stayed disabled. That Preview requires Vercel Deployment Protection, branch-scoped secrets, an isolated state key, a fixed one-cent cap, and the single bundled mission; reset and arbitrary mission creation are disabled.

See [Hackathon Acceptance and Currency Model](docs/HACKATHON_ACCEPTANCE_AND_CURRENCY.md) for the exact rail, currency, and bounty-acceptance boundary.

## Who the merchants and agents are

The running app supports one real merchant/provider counterpart, while the buyer and remaining roles stay deterministic:

- **Lazarus Recovery Merchant** is the independently deployed merchant and artifact provider used by `MERCHANT_MODE=remote`. It receives structured offers, counters deterministically, and signs binding quotes with Ed25519.
- **Lazarus Recovery Merchant Console** shows merchant settings, negotiation sessions, signed deals, and audit events. Lazarus includes the proposed bounty as non-settling offer context, but the current merchant service does not persist or display that field.
- **Atlas Archive Cloud / Node** remain the local fallback seller and bundled-fixture provider.
- **Lazarus buyer policy** is the deterministic orchestrator; it is not an LLM or free-form chat agent.
- **North, East, and West Verifier** are scripted local quorum roles.
- **Rain, Monad, and x402 are rails/infrastructure, not merchants or agents.**
- **x402 payer signer** is either a complete Privy server-wallet configuration (preferred) or one dedicated low-value 32-byte raw key. Exactly one signer is allowed, and it does not bargain. The verified Preview transaction used the raw-key fallback.
- **Receive-only payee** is a different wallet. The app needs only its public address and never needs its private key to receive.
- **Lazarus x402 seller** is a paid availability API enabled only in the protected preview. It is separate from the remote bargaining merchant.

Remote offers, counters, signed quotes, manifests, and artifact pieces cross the merchant HTTPS API. In the hybrid Production profile, card issuance, authorization, decline, and settlement also cross Rain's sandbox API. The bounty lifecycle, verifier decisions, and reseeding remain local state transitions, and no independent verifier or seeder network is contacted. See [Actors, Merchants, and Live Integration](docs/ACTORS_AND_MERCHANTS.md) for the complete boundary.

When public Monad RPC and x402 facilitator URLs are configured, `/api/health` can perform separate read-only readiness checks:

- Monad `eth_chainId` must report testnet chain `10143` (`eip155:10143`).
- The facilitator `/supported` response must advertise x402 v2, the `exact` scheme, and `eip155:10143`.
- The probe itself never signs or writes. `writesEnabled` becomes true only when `MONAD_EXECUTION_MODE=x402-testnet` successfully constructs the live x402 adapter; bounty writes remain false.

## The bargaining flow

The merchant negotiation is deterministic and bounded in both local and remote modes. The verified remote USD flow is:

1. Lazarus Recovery Merchant asks `$12.00`.
2. The buyer offers its `$9.00` target.
3. The merchant counters at `$10.50`.
4. The buyer offers `$9.75`.
5. The merchant accepts and issues a 15-minute Ed25519-signed binding quote.

Before simulated payment authorization, the remote adapter pins the merchant's Ed25519 key, recomputes the canonical quote digest, and verifies the signature. A separate fail-closed quote policy then verifies the session, merchant, MCC, content root, purpose, currency, amount, budget, terms, round count, approval threshold, and expiry. The accepted terms are one-time archival egress with no renewal, data sharing, or exclusivity.

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

Successful USD mission policy usage is exactly `$9.76`: one cent for discovery plus `$9.75` for the archive allocation. Local mode records both as simulated accounting. Hybrid Production records the archive operation in Rain's sandbox but charges `$0.00` in real money; its discovery cent remains local. The verified protected Preview settled the discovery cent in test USDC and recorded the `$9.75` archive allocation in Rain's sandbox; neither rail moved production money. With the minimum `$12.01` service cap, the UI therefore shows `$2.25` as **demo reserve remaining**. The Deal tab separately shows the same `$2.25` as **negotiated savings** from the `$12.00` ask; neither number means payment failed. The `$5.00` bounty is advanced locally at 70%, 90%, and 100%, corresponding to `$3.50`, then `$1.00`, then `$0.50` incremental demo-ledger entries.

For non-USD missions, every mission amount is stored and rendered in the selected currency's minor units. The fixed `lazarus-demo-reference-v1` table uses 100 USD cents, 92 euro cents, 78 pence, 137 Canadian cents, or 152 Australian cents per reference USD. These are deterministic demo values, not current market FX rates or a conversion service. Required reserves and debits round conservatively.

In `rain-sandbox` mode, the adapter can also simulate a configured amount of rUSD collateral funding before first card issuance. That is Rain sandbox setup, not mission spend or an account balance, and no real funds move. `RAIN_AUTO_FUND_MINOR` defaults to `0`; set a positive USD-cent amount only when deliberate sandbox provisioning is required.

## Deploy to Vercel with free Postgres

The repository now includes a Vercel serverless API (`api/index.js`) and a free Neon Postgres integration. A Vercel rewrite sends every nested `/api/*` route to that function while preserving the route for the Node request handler. The deployment stores the complete demo audit snapshot in Postgres instead of `.data/state.json`, reloads it before each API request, and rebuilds the deterministic local adapter ledgers before a mission continues. The browser uses five-second polling on Vercel because long-lived SSE connections are not a reliable serverless transport.

Vercel accepts `ADAPTER_MODE=local` or `ADAPTER_MODE=rain-sandbox`. A `rain-sandbox` deployment must also set an explicit, isolated `LAZARUS_STATE_KEY`, so a snapshot written by a local-mode deployment can never be adopted as sandbox card authority.

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

Do not put Privy payer credentials or any raw private key in the production environment; live payment execution belongs only on the protected preview.

Rain sandbox credentials are a deliberate exception. The deployed hybrid profile sets `ADAPTER_MODE=rain-sandbox` plus the `RAIN_*` names and an isolated `LAZARUS_STATE_KEY`, which lets the public demo issue real sandbox scoped cards. That is a sandbox card program, so no real money can move, but it does consume the tenant's sandbox quota (10 active cards, 10 created per user per 24 hours). Keep the key encrypted and server-side, and rotate it after the event.

The safe local profile runs the bundled fixture and local bargain. The verified hybrid Production profile enables authenticated remote merchant negotiation, provider downloads, and Rain sandbox card operations; Monad x402, verifier, bounty, and reseeding execution remain local there.

### Remote merchant/provider profile

The deployed counterpart is [https://lazarus-merchant.vercel.app](https://lazarus-merchant.vercel.app). Configure these names only through ignored local environment files or Vercel's encrypted server-side controls:

```text
MERCHANT_MODE=remote
LAZARUS_STATE_KEY=merchant-<unique-deployment-name>
MERCHANT_BASE_URL=<https-origin>
MERCHANT_API_TOKEN=<server-side-secret>
MERCHANT_EXPECTED_KEY_ID=<pinned-ed25519-fingerprint>
MERCHANT_CURRENCY=USD
MERCHANT_TRUSTED_MANIFEST_JSON=<complete-pinned-manifest>
MERCHANT_TIMEOUT_MS=15000
MERCHANT_RESPONSE_LIMIT_BYTES=<bounded-response-limit>
MERCHANT_MAXIMUM_PIECE_BYTES=<bounded-piece-limit>
MERCHANT_MAXIMUM_TOTAL_BYTES=<bounded-artifact-limit>
```

Remote mode fails closed unless it has an isolated `merchant-*` state namespace, the URL is HTTPS, the API token exists, the expected Ed25519 fingerprint is pinned, the accounting currency is supported, and the complete trusted manifest is supplied. The manifest is sponsor-pinned configuration: Lazarus compares the provider's live manifest to that exact copy before downloading pieces, then checks each piece hash, total size, Merkle root, and reconstructed artifact hash. Never bootstrap trust by accepting a root solely because the provider returned it.

The current merchant deployment is configured for USD and an eight-piece artifact. It issues quotes with a 15-minute lifetime; Lazarus also rejects future-dated, overlong, expired, mission-mismatched, or replayed sessions and quotes. Although the core local application supports USD, EUR, GBP, CAD, and AUD, a remote deployment advertises exactly one configured currency at a time. Changing it requires coordinated merchant settings and Lazarus configuration; this is not live FX.

### Protected one-shot branch preview

Create a branch-scoped Vercel Preview environment, enable Vercel Deployment Protection, and set placeholders like these through Vercel's encrypted environment-variable controls:

```text
ADAPTER_MODE=local
MONAD_EXECUTION_MODE=x402-testnet
ALLOW_EXTERNAL_WRITES_ON_VERCEL=true
LIVE_PREVIEW_BRANCH=<protected-branch>
LAZARUS_STATE_KEY=preview-<unique-run>
X402_SELLER_ENABLED=true

MONAD_PAY_TO_ADDRESS=<different-payee-address>

MONAD_RPC_URL=<credential-free-https-rpc>
X402_EXPECTED_AMOUNT_ATOMIC=10000
X402_MAX_PAYMENT_ATOMIC=10000
X402_MAX_AUTHORIZATION_SECONDS=300
MONAD_X402_CONFIRMATIONS=6
```

Configure exactly one payer signer. The preferred managed choice is all four `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_PAYER_WALLET_ID`, and `PRIVY_PAYER_ADDRESS` values. The alternative is one dedicated low-value 32-byte `MONAD_PRIVATE_KEY`. Never configure both signer types or an incomplete Privy set.

Vercel supplies its deployment and branch host variables, and the runtime derives `X402_AVAILABILITY_BASE_URL` from that protected host. It also uses the isolated state key as the x402 payment-ID namespace, so a deliberately new Preview cycle cannot collide with an older seller record. The runtime verifies the metadata, refuses Production/Development targets, requires exactly one valid signer, requires an isolated `preview-*` state key, and accepts only the single bundled mission. The immutable Preview mission receives a 30-day demo window; reset and arbitrary mission creation remain disabled. The buyer reaches the co-located seller through an internal same-origin transport so it does not bypass Vercel Deployment Protection; the HTTP seller route remains protected for protocol inspection.

The payee is receive-only: do not upload its seed phrase or private key. Fund only the chosen dedicated payer with the capped test USDC needed for the run. If Privy is selected, attach a restrictive wallet policy. Keep every signer secret branch-scoped. A live Preview is still a testnet integration demo, not a production payment service.

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

Rain sandbox is armed and verified. An end-to-end run against `api-dev.raincards.xyz` issued a real scoped card, settled the `$9.75` archive authorization at MCC `5734`, and had the deliberate `$9.00` unrelated-merchant attempt declined — all confirmed independently in Rain's own `/issuing/transactions` ledger. The collateral/contract identifier was validated against the provider before use: the real contract returns `202 {"success":true}` from `/simulate/collateral/fund` while a well-formed but unknown UUID returns `404`.

Treat any sandbox key that has been pasted into a chat, terminal transcript, or ticket as disclosed, and rotate it at Rain when the demo is over.

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

The sponsor starter also documents Rain `/payment-routes` and `/simulate/payment-routes` calls. Lazarus does not implement or claim that optional cross-rail flow; this mission uses the scoped-card issuance, authorization, decline, and settlement path above.

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

Configure exactly one signer type: either the complete four-value Privy configuration (preferred) or one dedicated low-value 32-byte `MONAD_PRIVATE_KEY`. The protected Vercel Preview accepts either choice and rejects both together, an incomplete Privy set, or an invalid raw key.

The payer must be a dedicated low-value wallet funded with the required test USDC, the payee must be a different wallet, and the seller must return the expected x402 v2 exact requirement and durable payment-identifier result. Defaults cap discovery at 10,000 USDC atomic units (test USDC 0.01) and require six confirmations. Lazarus first builds and validates the signed authorization, then durably records the pending payment immediately before transmission. A signature or persistence failure sends no paid request; after the durable gate exists, an ambiguous result blocks reset, fresh startup, and another transmission until reconciliation. The protected Vercel preview additionally disables reset and new mission creation even after success.

The protected Preview has completed this path. Transaction [`0x204f66f2cc3180e619babc9c341ddc71805ca8240a556d4665cf449bfb15300d`](https://testnet.monadscan.com/tx/0x204f66f2cc3180e619babc9c341ddc71805ca8240a556d4665cf449bfb15300d) succeeded on chain `10143`; independent RPC checks confirmed receipt success and the exact 10,000-atomic (test USDC `0.01`) Transfer of the official Monad test-USDC token from the dedicated payer to the distinct payee. That verified run used the dedicated raw-key signer fallback and separately recorded the `$9.75` archive allocation in Rain's sandbox. The transaction proves paid discovery only; the full bounty, verifiers, and reseeding remained local.

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
4. Watch the reference `$12.00 → $9.00 → $10.50 → $9.75` negotiation transcript. In remote mode, confirm the merchant session and Ed25519 signature; the deployed merchant currently accepts USD only.
5. Confirm the one-cent-reference x402 receipt and the accepted archive settlement in the selected mission currency.
6. Confirm the unrelated challenge is declined and does not count as spend.
7. Watch all pieces become recovered and verified: `24/24` for the local fixture or `8/8` for the current remote provider.
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
     -> local bargaining adapter OR authenticated remote merchant adapter
     -> local Rain adapter OR external Rain sandbox adapter
     -> local Monad bounty ledger (always; full registry is not deployed)
     -> x402-shaped local simulation OR opt-in Monad testnet x402 buyer
     -> local recovery engine OR authenticated remote provider with sponsor-pinned manifest
  -> local: JSON audit snapshot (.data/state.json)
  -> Vercel: Neon Postgres JSONB audit snapshot (optimistic revision check)

Protected Vercel preview only
  -> exactly one payer signer: complete Privy (preferred) or dedicated 32-byte raw key
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
src/services/negotiation-remote.js     HTTPS merchant API + pinned Ed25519 quote verification
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
src/services/recovery-remote.js        Pinned remote manifest, bounded piece download, reconstruction
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
- Rain sandbox is armed and verified against the provider; it remains a sandbox card program, so no real money can move.
- The local x402 adapter is only x402-shaped simulation. `MONAD_EXECUTION_MODE=x402-testnet` can move capped test USDC; it must use a dedicated payer, distinct payee, protected seller, and durable payment-ID uniqueness.
- Public Production may contact the authenticated merchant/provider and Rain sandbox. Monad x402, bounty, verifier, reseeding, and chain paths remain local there. Rain on Vercel requires an explicit isolated state key. Live x402 buyer and seller are permitted only together with the pinned local fixture on the explicitly armed, deployment-protected, one-shot branch Preview.
- Exactly one Preview payer signer is allowed: complete Privy configuration (preferred) or a dedicated low-value 32-byte raw key. Every signer secret stays encrypted, server-side, and branch-scoped. The payee is receive-only and does not require a stored private key.
- Application policy accepts only the pinned Monad testnet USDC `TransferWithAuthorization` envelope and verifies that the returned signature matches the configured payer, regardless of signer type.
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

Hybrid hackathon MVP. Multi-currency local accounting, authenticated remote merchant bargaining, Ed25519-signed quotes, sponsor-pinned provider recovery, an armed Rain sandbox adapter, an exactly-one-signer x402 payer, a durable x402 seller, and an opt-in Monad testnet availability payment are implemented.

Verified so far: the remote USD acceptance run completed two bargaining rounds, accepted a signed `$9.75` quote, and verified `8/8` pieces plus the reconstructed root. Rain sandbox is armed and proven end-to-end — a real scoped card settled `$9.75` at MCC `5734` and declined the `$9.00` unrelated-merchant challenge, both visible in Rain's own ledger. The deployed hybrid Production profile runs the remote merchant/provider and Rain sandbox together. The protected Preview separately completed transaction `0x204f…00d`; independent RPC checks verified receipt success on Monad testnet and the exact test-USDC `0.01` Transfer.

Still local in every profile: the full Monad bounty lifecycle, verifier independence, and reseeding. The Rain archive spend is sandbox-only, and the x402 proof moved test USDC rather than production money. Rain `/payment-routes` is not implemented or claimed. It is not production-ready.

See [Production readiness](docs/PRODUCTION_READINESS.md) for the exact live/simulated boundary, current configuration gaps, crash-safety requirements, and the staged path to a testnet-live release.
