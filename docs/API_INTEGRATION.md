# API and Testnet Integration Guide

Updated: 2026-08-09

This document describes the integration code that exists now. It separates mission accounting, deterministic demo behavior, Rain sandbox calls, the Privy payer, the protected x402 seller, and the still-local recovery bounty.

Never put credential values, provider identifiers, wallet IDs, wallet addresses, seed phrases, or private keys in source control, browser code, API responses, screenshots, model input, or documentation. Rotate anything previously disclosed before using it again.

## Capability and deployment matrix

`ADAPTER_MODE` chooses the Rain adapter. `MONAD_EXECUTION_MODE` independently chooses the x402 buyer.

| Component | Local selection | External selection | Exact boundary |
| --- | --- | --- | --- |
| Rain | `ADAPTER_MODE=local` | `ADAPTER_MODE=rain-sandbox` | The remote path calls Rain's hackathon sandbox, accepts USD mission accounting, and uses sandbox rUSD collateral. It is not a production card program. |
| x402 buyer | `MONAD_EXECUTION_MODE=local` | `MONAD_EXECUTION_MODE=x402-testnet` | Local is x402-shaped simulation. Testnet mode can sign and settle the pinned test-USDC payment on Monad. |
| x402 seller | Disabled by default | `X402_SELLER_ENABLED=true` | Enabled only with the protected testnet preview/local integration; it requires a durable settlement store. Public production disables it. |
| Payer custody | None | Privy server wallet; raw private key is local-only fallback | Vercel live mode requires Privy and refuses `MONAD_PRIVATE_KEY`. |
| Payee custody | None | Distinct receive-only address | No payee private key or seed phrase is required or stored. |
| Monad bounty | `LocalMonadAdapter` | No external implementation | Bounty, collateral, attestations, and releases remain local in every mode. |
| Merchant bargaining | `LocalNegotiationAdapter` | No external implementation | Structured deterministic bargaining; no merchant API or merchant-signed quote. |
| Recovery/verifiers | Local fixture and scripted quorum | No external implementation | Real byte hashing/reconstruction; no remote provider, independent verifier, or seeding network. |

### Vercel profiles

| Profile | Buyer | Seller | Mutations |
| --- | --- | --- | --- |
| Public Production | Local | Disabled | Normal local-demo missions and reset; no payment or chain writes. |
| Protected branch Preview | Privy-backed testnet buyer | Durable co-located seller | One fixed bundled mission; reset and arbitrary mission creation are disabled. |

The preview must use Vercel Deployment Protection. Runtime host/branch checks are defense in depth, not authentication. The buyer uses an internal same-origin seller transport, so it does not bypass or depend on calling through Vercel's external protection challenge. The x402 HTTP route remains available behind the same deployment protection for protocol inspection.

## Currency and settlement model

Mission creation accepts `USD`, `EUR`, `GBP`, `CAD`, and `AUD`. Budget, bargaining, savings, reward, and policy values are integer minor units of the selected currency. The fixed `lazarus-demo-reference-v1` table is deterministic demo data, not live FX:

| Currency | Minor units per reference USD |
| --- | ---: |
| USD | 100 |
| EUR | 92 |
| GBP | 78 |
| CAD | 137 |
| AUD | 152 |

Settlement assets are separate from accounting currencies:

- local adapters simulate value;
- Rain sandbox uses USD-denominated authorizations and sandbox rUSD collateral;
- Monad x402 always settles the pinned test-USDC asset; and
- MON is gas for the facilitator/settlement submitter, not a mission currency.

Rain sandbox rejects non-USD missions. Monad x402 may serve any supported accounting currency because the mission records a fixed-reference budget impact while the chain transfer remains test USDC. Selecting EUR, GBP, CAD, or AUD does not create a native payment in that currency.

## Environment variables actually read

Use an ignored local `.env` or Vercel's encrypted environment-variable controls. Examples below contain names and constraints only.

### Runtime and Rain

| Variable | Use |
| --- | --- |
| `PORT` | Loopback HTTP port; default `4173`. |
| `ADAPTER_MODE` | `local` or `rain-sandbox`. Vercel supports only `local`. |
| `RAIN_API_BASE_URL` | HTTPS Rain sandbox base URL. |
| `RAIN_API_KEY` | Server-side Rain sandbox credential. |
| `RAIN_USER_ID` | Provider-issued issuing-user UUID. |
| `RAIN_TEAM_ID` | Optional provider-issued team UUID used by health queries. |
| `RAIN_CONTRACT_ID` | Provider-issued collateral/contract UUID; not a Monad address. |
| `RAIN_AUTO_FUND_MINOR` | Sandbox rUSD collateral setup amount; default `0`. |
| `RAIN_TIMEOUT_MS` | Bounded request timeout. |

Rain activation is currently blocked. The prior API credential was disclosed and must be rotated, and the supplied collateral/contract value was not a valid UUID. Do not guess, trim, or mutate it. Keep `ADAPTER_MODE=local` until Rain supplies both a new key and a valid provider-issued UUID.

### Monad/x402 common values

| Variable | Use |
| --- | --- |
| `MONAD_EXECUTION_MODE` | `local` or `x402-testnet`; default `local`. |
| `MONAD_NETWORK` | Display/readiness label; the live adapters pin Monad testnet independently. |
| `MONAD_CHAIN_ID` | Display/readiness value; the live adapters independently require testnet. |
| `MONAD_RPC_URL` | Credential-free HTTPS RPC for readiness, balance, and receipt checks. |
| `X402_FACILITATOR_URL` | Credential-free HTTPS facilitator used by readiness and the seller. |
| `MONAD_PROBE_TIMEOUT_MS` | Readiness-probe timeout. |
| `MONAD_USDC_ADDRESS` | Readiness-presence metadata; live code pins the official test token. |
| `MONAD_BOUNTY_CONTRACT` | Readiness-presence metadata only; it does not enable bounty writes. |

### x402 buyer and signer

| Variable | Requirement and guardrail |
| --- | --- |
| `X402_AVAILABILITY_BASE_URL` | Required HTTPS seller directory for local testnet mode. Vercel Preview derives the co-located `/api/x402/availability/` URL from its protected host. |
| `MONAD_PAY_TO_ADDRESS` | Distinct receive-only seller recipient. |
| `PRIVY_APP_ID` | Privy server app identifier; branch-scoped on Vercel. |
| `PRIVY_APP_SECRET` | Privy server app secret; encrypted, server-side, preview-only. |
| `PRIVY_PAYER_WALLET_ID` | Dedicated low-value payer server-wallet ID; never expose to the browser. |
| `PRIVY_PAYER_ADDRESS` | Public address expected to sign; must differ from payee. |
| `MONAD_PRIVATE_KEY` | Local-only alternative to Privy. Configure one signer type, never both. Forbidden in Vercel live preview. |
| `X402_EXPECTED_AMOUNT_ATOMIC` | Exact price. Protected preview pins it to `10000` atomic test-USDC units. |
| `X402_MAX_PAYMENT_ATOMIC` | Hard cap. Protected preview pins it to the same `10000` value. |
| `X402_MAX_AUTHORIZATION_SECONDS` | Short authorization ceiling; protected preview allows at most `300`. |
| `X402_TIMEOUT_MS` | Bounded seller/signing/confirmation timeout. |
| `X402_PREFLIGHT_TTL_MS` | Maximum age of a verified 402 requirement. |
| `X402_RESPONSE_LIMIT_BYTES` | Paid-response size cap. |
| `MONAD_X402_CONFIRMATIONS` | Receipt confirmations; protected preview requires at least `6`. |
| `X402_EXPECTED_PROVIDER_ID` | Exact provider identity required in the paid response. |

Privy configuration is all-or-nothing. Missing one of the four `PRIVY_*` payer values fails closed. The signer object exposes only its public address; app secret and wallet ID remain private fields.

### x402 seller and Vercel preview gate

| Variable | Requirement and guardrail |
| --- | --- |
| `X402_SELLER_ENABLED` | `true` only on the protected preview/local integration; `false` in production. |
| `DATABASE_URL` | Required for the durable Neon settlement/replay store. |
| `ALLOW_EXTERNAL_WRITES_ON_VERCEL` | Must be exactly `true` to arm the protected Preview; `false` in Production. |
| `LIVE_PREVIEW_BRANCH` | Must exactly match Vercel's current Git branch metadata. |
| `LAZARUS_STATE_KEY` | Production uses `primary`; live preview requires a unique `preview-*` key. |

Vercel supplies deployment environment, target, branch, and host metadata. Live mode starts only when all of these invariants hold:

1. the runtime is a Vercel Preview, never Production or Development;
2. the opt-in flag is exactly true;
3. the Git branch matches `LIVE_PREVIEW_BRANCH`;
4. the state key is isolated and starts with `preview-`;
5. price and cap are both exactly `10000` atomic test-USDC units;
6. authorization is no longer than 300 seconds;
7. at least six confirmations are required;
8. all Privy payer values exist and no raw private key exists;
9. the request host is the deployment or branch host; and
10. persisted state contains only the fixed bundled demo mission.

The one-shot preview returns `LIVE_PREVIEW_ONE_SHOT` for reset or new-mission creation. It also allows at most one unresolved x402 payment across all missions.

## Privy signer policy

Use a dedicated payer server wallet with only the test USDC needed for the demonstration. Attach a restrictive Privy wallet policy; do not grant general transaction or arbitrary typed-data signing authority.

Lazarus adds an independent code-level allowlist before every Privy signing request. It permits only:

- `eth_signTypedData_v4` for `TransferWithAuthorization`;
- the exact EIP-3009 field schema;
- USDC domain name and version pinned by the protocol;
- Monad testnet and the pinned test-USDC verifying contract;
- the configured payer as `from` and distinct payee as `to`;
- a positive amount no greater than `X402_MAX_PAYMENT_ATOMIC`;
- `validAfter` equal to zero and a short `validBefore` window; and
- a canonical 32-byte nonce.

Any other chain, token, signer, recipient, amount, lifetime, method, or schema is rejected before Privy is called. Responses are size/time bounded, upstream errors are sanitized, and the returned signature is cryptographically verified against the configured payer address.

The payee remains receive-only. Do not create or upload payee signing credentials merely to receive test USDC.

## Protected x402 seller

Implementation: `src/services/x402-seller.js`. Durable store: `src/services/x402-seller-store.js`.

`GET /api/x402/availability/:contentRoot` is enabled only in the protected testnet deployment. An unpaid request returns x402 v2 `402 Payment Required` for one exact pinned test-USDC payment. A paid request must include the required payment-identifier extension.

The seller:

1. validates the canonical content-root route;
2. issues one exact Monad-testnet USDC requirement to the configured payee;
3. decodes and binds the payment identifier to the exact payment fingerprint and resource;
4. reserves that identifier in Neon before facilitator settlement;
5. asks the facilitator to verify and settle;
6. stores the successful settlement and availability response; and
7. returns the stored paid result for an exact replay without a second charge.

Reusing a payment ID for another payload/resource returns a conflict. A processing or uncertain outcome returns `X402_RECONCILIATION_REQUIRED`; it is never blindly retried. If settlement may have succeeded but persistence fails, the record is marked uncertain and operator reconciliation is required.

The seller returns deterministic Atlas availability metadata. It does not bargain, sell the `$9.75` archive service, stream provider bytes, or make the Atlas merchant live.

## Live Monad x402 buyer

Implementation: `src/services/x402-monad.js`.

Before signing, the buyer:

1. verifies Monad testnet chain identity;
2. requests the exact content-root resource;
3. requires a valid x402 v2 exact 402 contract;
4. pins network, test-USDC contract/name/version, amount, payee, resource, expiry, provider, and payment-identifier extension;
5. checks payer test-USDC balance; and
6. builds, signs, validates, and encodes the authorization, then durably records the pending payment immediately before transmission.

It then obtains the EIP-3009 signature, sends `PAYMENT-SIGNATURE`, validates `PAYMENT-RESPONSE`, bounds the paid body, waits for confirmations, and independently verifies the exact test-USDC `Transfer` from payer to payee.

A definitive Privy signing, payload-validation, header-encoding, or pending-state persistence failure happens before any paid seller request. An ambiguous timeout or response after the durable gate and transmission leaves the pending record in place. Reset, fresh startup, or another paid transmission is refused until an operator reconciles the stable namespaced payment ID and chain evidence.

## Rain sandbox adapter

Implementation: `src/services/rain-sandbox.js`. Provider reference: [Rain hackathon sandbox documentation](https://rain-sandbox-trial.mintlify.site/).

| Adapter operation | Sandbox request | Meaning |
| --- | --- | --- |
| Health | `GET /issuing/transactions` | Bounded authenticated check. |
| Collateral setup | `POST /simulate/collateral/fund` | Sandbox rUSD provisioning, not mission spend. |
| Scoped card | `POST /issuing/users/:userId/cards/scoped` | Accepted USD amount, expiry, MCC list, and encrypted session material. |
| Authorization | `POST /simulate/transactions/authorize` | Allowed or deliberate negative-control attempt after local policy. |
| Settlement | `POST /simulate/transactions/:id/settle` | Captures the approved sandbox authorization. |
| Reversal | `POST /simulate/transactions/:id/reverse` | Reverses an unexpected negative-control authorization. |
| Card lookup | `GET /issuing/cards/:id` | Safe status reconciliation. |

Every external request uses HTTPS, same-origin redirect checks, bounded timeouts/bodies, sanitized errors, and deterministic idempotency. Encrypted PAN/CVC response fields are discarded immediately and never enter state, Neon, logs, SSE, audit export, browser code, or model context.

Rain receives amount, MCC, and expiry controls. Lazarus independently enforces exact merchant, quote, purpose, task scope, rights, budget, and one-use rules. The sandbox has no documented remote cancel route; completion disables local authority and relies on short expiry.

## Merchant bargaining and binding quotes

Rain, Privy, Monad, and x402 do not bargain. The current Atlas transcript is a deterministic in-process state machine: reference ask, buyer target, seller counter, and accepted quote.

The quote commits to merchant/provider identities, MCC, content root, purpose, mission accounting currency, amount, terms, session, issue time, and expiry. Its SHA-256 digest detects local mutation but is not a merchant signature. A future merchant adapter must authenticate and verify a signed quote while preserving the deterministic quote and payment policies.

## Local Monad bounty and recovery

`LocalMonadAdapter` remains the bounty adapter in every mode. Bounty creation, provider claim/collateral, verifier attestations, and 70/90/100 releases are deterministic local transitions with synthetic hashes. The Solidity file is a reference only and is not compiled, deployed, called, or audited by the app.

Recovery reads the bundled CC0 fixture, verifies 24 piece hashes, reconstructs the file, validates the full commitment, and requires two scripted passing verifiers. The cryptographic work is real; networking and verifier independence are not.

## HTTP routes

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/api/health` | Safe adapter/seller status and optional read-only readiness. |
| `GET` | `/api/state` | Sanitized public state and currency catalog. |
| `GET` | `/api/events` | SSE locally; Vercel uses polling. |
| `GET` | `/api/x402/availability/:contentRoot` | Protected paid seller resource; disabled in public production. |
| `POST` | `/api/demo/reset` | Local reset; disabled in one-shot live preview and blocked by unresolved external authority. |
| `POST` | `/api/missions` | Fixture-backed mission creation; disabled in one-shot live preview. |
| `POST` | `/api/missions/:id/step` | Execute the next mission step. |
| `POST` | `/api/missions/:id/run` | Execute remaining steps. |
| `GET/POST` | `/api/missions/:id/negotiation` | Read or execute local bargaining. |
| `POST` | `/api/missions/:id/blocked-purchase` | Exercise an additional denied purchase. |
| `GET` | `/api/missions/:id/export` | Download sanitized audit JSON. |

There are no browser proxy routes for Privy credentials, wallet signing, raw Rain card data, or RPC secrets.

## End-to-end protected-preview checklist

1. Rotate every credential previously exposed outside a secret manager.
2. Keep public Production local-only with seller disabled and no Privy/Rain secrets.
3. Enable Vercel Deployment Protection on the branch Preview.
4. Scope every live variable to that branch Preview; use a unique `preview-*` state key.
5. Create a dedicated Privy payer and a different receive-only payee.
6. Attach a restrictive Privy wallet policy and fund the payer with only the capped test USDC.
7. Enable the durable seller, configure the protected availability base URL, and confirm Neon is connected.
8. Confirm `/api/health` reports testnet buyer and seller truthfully while bounty writes remain false.
9. Run only the bundled mission once. Retain the payment ID, settlement response, transaction hash, confirmations, exact Transfer evidence, and explorer link.
10. Reconcile any uncertain result before changing the state key or retrying.
11. State that bargaining, archive payment, bounty, provider network, verifier network, and reseeding remain local.

Rain is a separate demo path. Do not enable it until the rotated key and valid provider UUID are available.

## Path to production

- Add authenticated users, tenancy, RBAC, quotas/rate limits, audit signing, monitoring, incident response, and managed custody.
- Replace snapshots with normalized operation attempts, receipts, idempotency, reconciliation jobs, and append-only events.
- Complete Rain production onboarding, signed webhooks, cancellation, refunds, disputes, and transaction reconciliation.
- Compile, test, fuzz, audit, deploy, and verify the Monad bounty contract and implement a dedicated writer.
- Replace local merchant/provider/verifiers with authenticated services and signed statements.
- Define real FX, fees, disclosures, refunds, custody, accounting, and reconciliation before claiming production multi-currency support.
- Add isolated recovery workers, content controls, durable artifact storage, and real reseeding evidence.

Until then, the protected branch preview is a capped testnet demonstration, Rain remains an unarmed sandbox integration, and public production remains fully local-only.
