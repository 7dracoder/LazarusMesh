# API and Testnet Integration Guide

Updated: 2026-08-08

This document describes the integration code that exists now. It distinguishes selectable mission accounting, Rain sandbox calls, an x402-shaped local simulation, an opt-in real Monad testnet x402 payment, and the still-local bounty lifecycle.

Never put real credential values in source control, browser code, API responses, screenshots, model input, or documentation. Any credential disclosed outside a secret manager should be rotated before use.

## Current capability matrix

`ADAPTER_MODE` and `MONAD_EXECUTION_MODE` are independent selectors.

| Component | Local selection | External selection | Exact boundary |
| --- | --- | --- | --- |
| Rain | `ADAPTER_MODE=local` uses `LocalRainAdapter` | `ADAPTER_MODE=rain-sandbox` uses `RainSandboxAdapter` | Rain's hackathon sandbox is USD-only and uses sandbox rUSD collateral; it is not a production card program. |
| x402 availability | `MONAD_EXECUTION_MODE=local` uses `LocalX402Adapter` | `MONAD_EXECUTION_MODE=x402-testnet` uses `MonadX402Adapter` | Local is only x402-shaped simulation. Testnet mode can sign and settle a capped official test-USDC payment on Monad. |
| Monad bounty | `LocalMonadAdapter` | No external implementation | Bounty creation, provider claim/collateral, attestations, and 70/90/100 releases remain local in every mode. |
| Merchant negotiation | `LocalNegotiationAdapter` | No external implementation | Structured deterministic bargaining; no merchant API or merchant-signed quote. |
| Recovery | `LocalRecoveryAdapter` | No external implementation | Real local fixture bytes/hashes/reconstruction; no DHT, archive provider, or persistent seeding. |
| Verifiers | Scripted local quorum | No external implementation | No independent verifier network. |
| Readiness | Optional Monad RPC plus facilitator probe | Read-only network requests | Probe status does not itself authorize a payment or bounty write. |

The public Vercel function enforces `ADAPTER_MODE=local` and `MONAD_EXECUTION_MODE=local`. Live sandbox/testnet calls must run from an access-controlled local Node runtime until durable external-operation reconciliation, authentication, tenancy, and rate limits exist.

## Currency and settlement model

Mission creation accepts `USD`, `EUR`, `GBP`, `CAD`, and `AUD`. All mission budget, bargaining, savings, reward, and policy values are integer minor units of the selected currency. The fixed `lazarus-demo-reference-v1` reference table is deterministic demo data, not live FX:

| Currency | Minor units per reference USD |
| --- | ---: |
| USD | 100 |
| EUR | 92 |
| GBP | 78 |
| CAD | 137 |
| AUD | 152 |

Conservative conversions round required reserves and debits upward and maximum limits downward. The API publishes the catalog and per-currency limits under `system.missionCreation`.

Settlement assets are not mission currencies:

- local adapters only simulate value movement;
- Rain sandbox authorizations are USD-denominated and collateral setup uses `currency: "rusd"`;
- Monad x402 settles official Monad test USDC with six decimals; and
- MON is Monad's native gas asset and is not a mission currency. In this x402 flow, the EIP-3009 buyer authorization is gasless; the seller/facilitator that submits settlement needs MON. Lazarus does not inspect or quantify the submitter's MON balance.

Rain sandbox mode rejects a non-USD mission before a Rain request. Monad x402 can serve any supported mission-accounting currency because the budget impact is recorded as its fixed reference equivalent while the chain transfer remains test USDC.

See [Hackathon Acceptance and Currency Model](HACKATHON_ACCEPTANCE_AND_CURRENCY.md) for the canonical acceptance matrix.

## Modes and runtime boundary

### Rain selection

- `ADAPTER_MODE=local`: local scoped-card simulation; no Rain request.
- `ADAPTER_MODE=rain-sandbox`: authenticated Rain sandbox collateral, card, authorization, settlement, reversal, and reconciliation calls.

### Monad/x402 selection

- `MONAD_EXECUTION_MODE=local`: x402-shaped local requirement and synthetic receipt; no valid x402 authorization or chain transfer.
- `MONAD_EXECUTION_MODE=x402-testnet`: real x402 v2 buyer flow for the availability resource on Monad testnet. Test USDC can move; the buyer signs gaslessly and the submitting seller/facilitator pays MON gas.

Unknown values fail startup. There is no silent fallback from an external mode to local execution.

The local server binds to `127.0.0.1`, validates loopback `Host`, and rejects cross-site or mismatched-origin browser mutations. It has no user authentication and must not be exposed directly to a public network.

## Environment variables actually read

Use an ignored local `.env` or an approved secret manager. Examples below show names and safe defaults only.

### Runtime and Rain

| Variable | Use |
| --- | --- |
| `PORT` | Loopback HTTP port; default `4173`. |
| `ADAPTER_MODE` | `local` or `rain-sandbox`. |
| `RAIN_API_BASE_URL` | Required HTTPS Rain sandbox base URL in `rain-sandbox`. |
| `RAIN_API_KEY` | Required server-side Rain API credential. |
| `RAIN_USER_ID` | Required Rain UUID for issuing-user operations. |
| `RAIN_TEAM_ID` | Optional Rain UUID included in health queries. |
| `RAIN_CONTRACT_ID` | Required Rain funding-contract UUID. It is not a Monad contract address. |
| `RAIN_AUTO_FUND_MINOR` | Sandbox rUSD collateral amount; default is `0` in `.env.example`. Set deliberately. |
| `RAIN_TIMEOUT_MS` | Request timeout; default `12000`, with runtime validation and an upper bound. |

### Monad/x402 selection and readiness

| Variable | Use |
| --- | --- |
| `MONAD_EXECUTION_MODE` | `local` or `x402-testnet`; default `local`. |
| `MONAD_NETWORK` | Display/readiness label; default `eip155:10143`. It does not choose the live adapter's pinned network. |
| `MONAD_CHAIN_ID` | Display/readiness value; default `10143`. The live adapter and probe independently require Monad testnet. |
| `MONAD_RPC_URL` | Credential-free HTTPS Monad RPC. Used by the readiness probe and required by live x402. |
| `X402_FACILITATOR_URL` | Credential-free HTTPS facilitator origin used by the read-only `/supported` probe. The buyer adapter does not call it directly. |
| `MONAD_PROBE_TIMEOUT_MS` | Readiness-probe timeout; default `5000`. |
| `MONAD_USDC_ADDRESS` | Readiness-presence metadata only. The live adapter pins the official Monad test-USDC address in code. |
| `MONAD_BOUNTY_CONTRACT` | Readiness-presence metadata only. It does not activate bounty writes. |

### Live x402 buyer

| Variable | Required/default | Guardrail |
| --- | --- | --- |
| `X402_AVAILABILITY_BASE_URL` | Required | Credential-free HTTPS directory URL for the seller's availability resources. Query strings and fragments are rejected. |
| `MONAD_PAY_TO_ADDRESS` | Required | Expected seller recipient; must be a valid address distinct from the payer. |
| `MONAD_PRIVATE_KEY` | Required | Dedicated low-value testnet payer key. It remains server-side and must have test USDC. The buyer's EIP-3009 authorization is gasless. |
| `X402_EXPECTED_AMOUNT_ATOMIC` | Default `10000` | Exact official test-USDC amount expected from the seller; default is test USDC 0.01. |
| `X402_MAX_PAYMENT_ATOMIC` | Defaults to expected amount | Hard policy ceiling. Startup also refuses a ceiling above 1 test USDC. |
| `X402_MAX_AUTHORIZATION_SECONDS` | Default `300` | Seller authorization-window ceiling; maximum accepted configuration is 900 seconds. |
| `X402_TIMEOUT_MS` | Default `12000` | Seller and confirmation timeout; maximum 30 seconds. |
| `X402_PREFLIGHT_TTL_MS` | Default `60000` | Maximum age of the verified 402 requirement; maximum five minutes. |
| `X402_RESPONSE_LIMIT_BYTES` | Default `65536` | Paid resource response cap; maximum 1 MiB. |
| `MONAD_X402_CONFIRMATIONS` | Default `6` | Required independent transaction confirmations; maximum 32. |
| `X402_EXPECTED_PROVIDER_ID` | Default `provider_atlas_archive` | Provider identity required in the paid response. |

`RAIN_WEBHOOK_SECRET` may appear in older notes, but the current server does not read it and exposes no Rain webhook route.

## `GET /api/health`

Health returns selected adapter modes and safe booleans, never secret values.

- Local Rain returns healthy local status without a network request.
- Rain sandbox sends a bounded authenticated transaction-list query; failure returns HTTP `503`.
- The readiness probe runs only when both `MONAD_RPC_URL` and `X402_FACILITATOR_URL` are present. It requires chain `10143` and x402 v2 exact support on `eip155:10143`.
- The probe never signs or writes. Its success does not prove the payer balance, seller requirement, recipient, price, or eventual settlement.
- In local x402 mode, health reports `local-handshake` and `liveSettlementEnabled: false`.
- In testnet mode, health reports `monad-testnet`, `liveSettlementEnabled: true`, `x402PaymentWritesEnabled: true`, and `bountyWritesEnabled: false`.
- `signerConfigured`, `contractConfigured`, `payToConfigured`, and `resourceConfigured` are configuration-presence signals, not proof of custody, bytecode, seller correctness, or balance.

The top-level `networkAccess` field means only that some configured component may contact an external origin. It does not mean every integration is live.

## Rain sandbox adapter

Implementation: `src/services/rain-sandbox.js`. Provider reference: [Rain hackathon sandbox documentation](https://rain-sandbox-trial.mintlify.site/). Use only the sandbox contract and credentials issued to the team; never substitute a production key in this demo runtime.

### Endpoint mapping

Every request uses server-memory credentials, HTTPS, same-origin redirect enforcement, timeouts, response limits, and sanitized errors. Mutating operations receive deterministic 64-character SHA-256 idempotency keys.

| Adapter operation | Rain sandbox request | Mapping |
| --- | --- | --- |
| `health()` | `GET /issuing/transactions` | Queries one transaction for the configured user and optional team. |
| `fundCollateral()` | `POST /simulate/collateral/fund` | Sends the Rain contract UUID, `currency: "rusd"`, and integer amount. This is sandbox setup, not mission spend. |
| `createScopedCard()` | `POST /issuing/users/:userId/cards/scoped` | Sends USD cents, absolute expiry, allowed MCCs, and encrypted session material. |
| `authorizePurchase()` | `POST /simulate/transactions/authorize` | Sends card ID, exact USD amount, merchant, and MCC after local policy checks. |
| Automatic settlement | `POST /simulate/transactions/:id/settle` | Settles the approved archive authorization with the exact amount. |
| Negative-control reversal | `POST /simulate/transactions/:id/reverse` | Reverses an unexpected sandbox authorization during the deliberate control exercise. |
| `getCard()` | `GET /issuing/cards/:id` | Reconciles safe card status metadata. |
| `retireCard()` | No remote request | Disables local authority and records scheduled expiry; the current sandbox flow exposes no cancel endpoint. |

The scoped-card request sends the exact accepted USD amount, expiry, and MCC allowlist. Rain may apply its sandbox authorization buffer to the remote ceiling. Lazarus separately enforces the unbuffered exact quote, merchant, mission purpose, one-transaction count, rights, budget, and approval policy both before card creation and before authorization.

Rain responses may include encrypted PAN/CVC values. The adapter discards them immediately. They never enter state, persistence, logs, SSE, audit exports, browser code, or model context.

This repository has no signed Rain webhook ingestion, reconciliation worker, refund/dispute workflow, production issuer program, or immediate remote card cancellation. An unexpired recorded Rain sandbox card blocks destructive reset/startup state replacement until its recorded expiry.

## Merchant bargaining and binding quotes

The application bargains, but only with a deterministic local Atlas merchant. Rain, Monad, and x402 are rails, not merchants or conversational agents.

The USD reference transcript is USD 12.00 ask, USD 9.00 buyer counter, USD 10.50 seller counter, and USD 9.75 accepted quote. Other supported currencies use fixed reference equivalents. The quote commits to merchant/provider identities, MCC, content root, purpose, selected mission currency, amount, terms, session, issuance, and expiry.

`quoteDigest` is SHA-256 over canonical local JSON. It catches mutation; it is not a merchant signature. `evaluateQuote()` rejects wrong identity, session, resource, purpose, currency, amount, budget, terms, round count, approval state, digest, or expiry. A valid quote must still pass general payment policy.

The replaceable merchant surface remains:

```text
getOffers({ missionId, contentRoot, providerId, requirements, idempotencyKey })
sendCounterOffer({ sessionId, offerId, amountMinor, terms, idempotencyKey })
getBindingQuote({ sessionId, quoteId })
getSession(sessionId)
```

A future live adapter must authenticate the merchant and return signed/verifiable, expiring, replay-protected quotes while preserving deterministic policy as the payment authority.

## Local Monad bounty ledger

`src/services/monad-local.js` remains the bounty adapter in every runtime mode. It returns deterministic synthetic receipts for bounty creation, provider claim/collateral, verifier attestations, and tranche release. No RPC write occurs and its transaction hashes are not explorer transactions.

The local ledger records mission currency separately from its synthetic USDC settlement references so non-USD missions reconcile exactly. This does not turn the ledger into a token transfer.

`contracts/RecoveryBountyRegistry.sol` is a reference contract only. The application does not compile, deploy, verify, configure, call, or audit it. Its real state machine also differs from the simplified local 70/90/100 method surface, so a future writer requires a dedicated adapter, not a mode flag around `LocalMonadAdapter`.

## x402-shaped local simulation

`src/services/x402-local.js` returns a local HTTP-402-style requirement and an idempotent synthetic availability receipt. The receipt includes a synthetic transaction hash and a 10,000-atomic test-USDC reference for the one-cent discovery accounting impact.

This is not a complete x402 v2 exchange. It has no real seller, payer signature, EIP-3009 authorization, token transfer, facilitator settlement, gas spend, or explorer receipt. Use the phrase **x402-shaped local simulation**, not “live x402.”

## Live Monad x402 buyer

`src/services/x402-monad.js` is enabled only by `MONAD_EXECUTION_MODE=x402-testnet`. It swaps availability discovery only.

### Preflight

Before signing, it:

1. verifies the configured RPC reports Monad testnet chain `10143`;
2. requests the exact content-root resource from the configured HTTPS seller;
3. requires HTTP `402` plus a valid x402 v2 `PAYMENT-REQUIRED` contract;
4. accepts exactly one `exact` requirement on `eip155:10143`;
5. requires the pinned official test-USDC contract, name/version, expected amount, configured payee, bounded timeout, exact resource URL, and required payment-identifier extension; and
6. caches that verified requirement only for the configured preflight TTL.

### Payment and independent verification

On settlement, it rechecks chain and payer balance, derives a stable payment ID from mission and content root, and durably stores a pending-payment record **before** signature creation or transmission. It then signs a bounded gasless EIP-3009 payment, sends `PAYMENT-SIGNATURE` to the seller, validates `PAYMENT-RESPONSE`, limits the paid response body, waits for the required confirmations, and independently requires the exact test-USDC `Transfer` from payer to configured payee.

It refuses automatic recovery/retry behavior. If a paid request times out or returns ambiguous settlement evidence, the durable pending record remains. Reset, fresh local startup, and repeat authorization fail with `X402_RECONCILIATION_REQUIRED` until an operator reconciles the stable payment ID and chain evidence. A confirmed matching receipt clears the pending record.

### Seller responsibilities

The buyer does not directly call `X402_FACILITATOR_URL`. The HTTPS seller must:

- generate the matching x402 v2 exact requirement;
- enforce the payment-identifier extension;
- call a compatible facilitator for verification/settlement and ensure the settlement submitter has MON for gas;
- durably make payment IDs unique;
- return the same paid result for an exact duplicate rather than charge twice; and
- include a trustworthy settlement response and bounded provider-availability payload.

The buyer's durable pending gate prevents a crash from silently permitting a second signature, but this release has no automated reconciliation/clearance endpoint. Durable seller payment-ID uniqueness, paid-result persistence, operator reconciliation, and normalized buyer operation history remain release requirements.

## HTTP API routes

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/api/health` | Safe adapter status plus optional readiness probe. |
| `GET` | `/api/state` | Sanitized public demo state, currency catalog, and mode truth. |
| `GET` | `/api/events` | SSE locally; disabled in the polling-based Vercel runtime. |
| `POST` | `/api/demo/reset` | Reset local state; blocked while recorded Rain authority may still be live or an x402 payment needs reconciliation. |
| `POST` | `/api/missions` | Create a verified-fixture mission with rights, selected currency, budget, and reward checks. |
| `POST` | `/api/missions/:id/step` | Execute the next mission step. |
| `POST` | `/api/missions/:id/run` | Execute all remaining steps with an in-process mission lock. |
| `GET` | `/api/missions/:id/negotiation` | Read stored bargaining state. |
| `POST` | `/api/missions/:id/negotiation` | Execute/idempotently replay bargaining after discovery. |
| `POST` | `/api/missions/:id/blocked-purchase` | Exercise an additional denied policy purchase. |
| `GET` | `/api/missions/:id/export` | Download sanitized mission audit JSON. |

There are no direct browser proxy routes for Rain, wallet keys, contracts, RPC, sellers, or facilitators.

## Capped testnet run checklist

1. Rotate any key or credential that has appeared in chat, screenshots, logs, or commits.
2. Use an access-controlled local runtime and a dedicated low-value payer wallet.
3. Put only the required test USDC in the payer wallet. Confirm the chosen seller/facilitator can fund MON gas; do not assume the buyer needs MON unless that service explicitly requires it.
4. Configure a separate payee wallet; payer and payee must never be the same.
5. Use an HTTPS seller with durable payment-ID uniqueness and an independently configured compatible facilitator.
6. Set the exact amount and maximum to the smallest demo value; keep the default one-cent amount unless the seller contract requires another explicitly approved value.
7. Confirm `/api/health` reports `monad-testnet`, x402 payment writes enabled, and bounty writes disabled.
8. Run one mission, retain the payment ID, settlement response, transaction hash, block/confirmation evidence, and explorer URL.
9. Reconcile any ambiguous result before retrying.
10. State that bargaining, full bounty execution, recovery networking, verifier independence, and reseeding remain local.

## Path to production

- Normalize persistence into missions, operation attempts, idempotency records, receipts, webhooks, and reconciliation jobs.
- Add authentication, tenancy, RBAC, rate limits, secret management, custody policy, audit retention, alerting, and incident response.
- Add signed Rain webhooks and complete production card lifecycle handling.
- Compile, test, fuzz, audit, deploy, and verify the bounty registry; implement a separate Monad writer with simulation, nonce/fee policy, confirmation, replacement, and reorg handling.
- Replace local merchants/providers/verifiers with authenticated services and verifiable statements.
- Add isolated recovery workers, malware/content controls, durable artifact storage, and actual availability/reseeding evidence.
- Define any real multi-currency card/FX product with provider-supported rails, exchange-rate source, spread/fees, disclosures, refunds, disputes, and accounting reconciliation.

Until those items exist, `x402-testnet` is a capped hackathon testnet path and Rain remains a sandbox path. Neither makes Lazarus Mesh a production financial or recovery service.
