# API and Testnet Integration Guide

Updated: 2026-08-09

This document describes the integration code that exists now. It separates mission accounting, authenticated remote merchant/provider traffic, deterministic demo behavior, Rain sandbox calls, the exactly-one-signer x402 payer, the protected x402 seller, and the still-local recovery bounty.

Never put credential values, provider identifiers, wallet IDs, wallet addresses, seed phrases, or private keys in source control, browser code, API responses, screenshots, model input, or documentation. Rotate anything previously disclosed before using it again.

## Capability and deployment matrix

`ADAPTER_MODE` chooses the Rain adapter, `MONAD_EXECUTION_MODE` independently chooses the x402 buyer, and `MERCHANT_MODE` chooses local or remote merchant/provider behavior.

| Component | Local selection | External selection | Exact boundary |
| --- | --- | --- | --- |
| Rain | `ADAPTER_MODE=local` | `ADAPTER_MODE=rain-sandbox` (armed and verified; allowed on Vercel with an isolated state key) | The remote path calls Rain's hackathon sandbox, accepts USD mission accounting, and uses sandbox rUSD collateral. It is not a production card program. |
| x402 buyer | `MONAD_EXECUTION_MODE=local` | `MONAD_EXECUTION_MODE=x402-testnet` | Local is x402-shaped simulation. Testnet mode can sign and settle the pinned test-USDC payment on Monad. |
| x402 seller | Disabled by default | `X402_SELLER_ENABLED=true` | Enabled only with the protected testnet preview/local integration; it requires a durable settlement store. Public production disables it. |
| Payer custody | None | Complete Privy server wallet (preferred) or one dedicated 32-byte raw key | The protected Preview requires exactly one signer type and rejects both together, incomplete Privy, or an invalid raw key. |
| Payee custody | None | Distinct receive-only address | No payee private key or seed phrase is required or stored. |
| Monad bounty | `LocalMonadAdapter` | No external implementation | Bounty, collateral, attestations, and releases remain local in every mode. |
| Merchant bargaining | `LocalNegotiationAdapter` | `RemoteNegotiationAdapter` | Remote mode uses an authenticated HTTPS API, pins an Ed25519 key, and verifies signed binding quotes. |
| Recovery | 24-piece bundled fixture | `RemoteRecoveryAdapter` with eight-piece sponsor-pinned manifest | Remote HTTPS transfer and cryptographic verification are real; durable artifact storage/reseeding are not. |
| Verifiers | Scripted local quorum | No external implementation | Independent verifier services remain future scope in every profile. |

### Vercel profiles

| Profile | Buyer | Seller | Mutations |
| --- | --- | --- | --- |
| Public Production | Local | Disabled | Verified hybrid may use remote merchant/provider plus Rain sandbox with isolated state; no real-money or chain writes. |
| Protected branch Preview | Exactly-one-signer testnet buyer | Durable co-located seller | One fixed bundled local-fixture mission; the verified run also used Rain sandbox; reset and arbitrary mission creation are disabled. |

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

The remote merchant/provider accepts exactly one configured accounting currency at a time. The deployed service is currently USD. Core local mode continues to support all five accounting currencies.

## Environment variables actually read

Use an ignored local `.env` or Vercel's encrypted environment-variable controls. Examples below contain names and constraints only.

### Runtime and Rain

| Variable | Use |
| --- | --- |
| `PORT` | Loopback HTTP port; default `4173`. |
| `ADAPTER_MODE` | `local` or `rain-sandbox`. Vercel accepts both; `rain-sandbox` additionally requires an explicit isolated `LAZARUS_STATE_KEY`. |
| `RAIN_API_BASE_URL` | HTTPS Rain sandbox base URL. |
| `RAIN_API_KEY` | Server-side Rain sandbox credential. |
| `RAIN_USER_ID` | Provider-issued issuing-user UUID. |
| `RAIN_TEAM_ID` | Optional provider-issued team UUID used by health queries. |
| `RAIN_CONTRACT_ID` | Provider-issued collateral/contract UUID; not a Monad address. |
| `RAIN_AUTO_FUND_MINOR` | Sandbox rUSD collateral setup amount; default `0`. |
| `RAIN_TIMEOUT_MS` | Bounded request timeout. |

### Remote merchant/provider

The current remote counterpart is [https://lazarus-merchant.vercel.app](https://lazarus-merchant.vercel.app). Values belong only in ignored local configuration or encrypted Vercel server-side variables.

| Variable | Use |
| --- | --- |
| `MERCHANT_MODE` | `local` or `remote`; remote settings are rejected unless explicitly selected. |
| `LAZARUS_STATE_KEY` | Remote Vercel Production requires an explicit isolated `merchant-*` namespace. Local Production uses `primary`. |
| `MERCHANT_BASE_URL` | HTTPS merchant/provider origin; loopback HTTP is allowed only for local development. |
| `MERCHANT_API_TOKEN` | Shared server-to-server bearer credential; never exposed to the browser. |
| `MERCHANT_EXPECTED_KEY_ID` | Sponsor-pinned Ed25519 public-key fingerprint. |
| `MERCHANT_CURRENCY` | The one accounting currency accepted by this remote deployment. |
| `MERCHANT_TRUSTED_MANIFEST_JSON` | Complete sponsor-pinned artifact manifest; not learned from the provider at runtime. |
| `MERCHANT_TIMEOUT_MS` | Bounded merchant/provider request timeout. |
| `MERCHANT_RESPONSE_LIMIT_BYTES` | Maximum JSON response size. |
| `MERCHANT_MAXIMUM_PIECE_BYTES` | Maximum individual artifact piece size. |
| `MERCHANT_MAXIMUM_TOTAL_BYTES` | Maximum aggregate artifact size. |

Rain activation is complete. Authenticated health passes and the collateral/contract UUID was confirmed against the provider by control (real identifier `202`, unknown well-formed UUID `404`). Do not guess, trim, or mutate a provider identifier — verify it. Rotate any key that has been disclosed outside a secret manager.

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
| `MONAD_PRIVATE_KEY` | Dedicated low-value 32-byte alternative to complete Privy. The protected Preview accepts it; configure exactly one signer type, never both. |
| `X402_EXPECTED_AMOUNT_ATOMIC` | Exact price. Protected preview pins it to `10000` atomic test-USDC units. |
| `X402_MAX_PAYMENT_ATOMIC` | Hard cap. Protected preview pins it to the same `10000` value. |
| `X402_MAX_AUTHORIZATION_SECONDS` | Short authorization ceiling; protected preview allows at most `300`. |
| `X402_TIMEOUT_MS` | Bounded seller/signing/confirmation timeout. |
| `X402_PREFLIGHT_TTL_MS` | Maximum age of a verified 402 requirement. |
| `X402_RESPONSE_LIMIT_BYTES` | Paid-response size cap. |
| `MONAD_X402_CONFIRMATIONS` | Receipt confirmations; protected preview requires at least `6`. |
| `X402_EXPECTED_PROVIDER_ID` | Exact provider identity required in the paid response. |

Privy configuration is all-or-nothing. Missing one of the four `PRIVY_*` payer values fails closed. The signer object exposes only its public address; app secret and wallet ID remain private fields. Live Preview policy accepts either that complete Privy set or one valid 32-byte raw key and rejects both together.

### x402 seller and Vercel preview gate

| Variable | Requirement and guardrail |
| --- | --- |
| `X402_SELLER_ENABLED` | `true` only on the protected preview/local integration; `false` in production. |
| `DATABASE_URL` | Required for the durable Neon settlement/replay store. |
| `ALLOW_EXTERNAL_WRITES_ON_VERCEL` | Must be exactly `true` to arm the protected Preview; `false` in Production. |
| `LIVE_PREVIEW_BRANCH` | Must exactly match Vercel's current Git branch metadata. |
| `LAZARUS_STATE_KEY` | Local Production uses `primary`; remote Production requires a unique `merchant-*` key; live preview requires a unique `preview-*` key. |

Vercel supplies deployment environment, target, branch, and host metadata. Live mode starts only when all of these invariants hold:

1. the runtime is a Vercel Preview, never Production or Development;
2. the opt-in flag is exactly true;
3. the Git branch matches `LIVE_PREVIEW_BRANCH`;
4. the state key is isolated and starts with `preview-`;
5. price and cap are both exactly `10000` atomic test-USDC units;
6. authorization is no longer than 300 seconds;
7. at least six confirmations are required;
8. exactly one signer is valid: all four Privy payer values (preferred) or one dedicated low-value 32-byte raw key;
9. the request host is the deployment or branch host; and
10. persisted state contains only the fixed bundled demo mission.

The one-shot preview returns `LIVE_PREVIEW_ONE_SHOT` for reset or new-mission creation. It also allows at most one unresolved x402 payment across all missions.

## Payer signer policy

Use a dedicated payer with only the test USDC needed for the demonstration. Prefer a complete Privy server wallet with a restrictive policy; the protected Preview also accepts a dedicated 32-byte raw key fallback. Configure exactly one signer and do not grant or fund general authority.

Lazarus applies the same independent code-level allowlist before either signer is used. It permits only:

- `eth_signTypedData_v4` for `TransferWithAuthorization`;
- the exact EIP-3009 field schema;
- USDC domain name and version pinned by the protocol;
- Monad testnet and the pinned test-USDC verifying contract;
- the configured payer as `from` and distinct payee as `to`;
- a positive amount no greater than `X402_MAX_PAYMENT_ATOMIC`;
- `validAfter` equal to zero and a short `validBefore` window; and
- a canonical 32-byte nonce.

Any other chain, token, signer, recipient, amount, lifetime, method, or schema is rejected before signing. Managed-signer responses are size/time bounded, upstream errors are sanitized, and every returned signature is cryptographically verified against the configured payer address.

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

A definitive signing, payload-validation, header-encoding, or pending-state persistence failure happens before any paid seller request. An ambiguous timeout or response after the durable gate and transmission leaves the pending record in place. Reset, fresh startup, or another paid transmission is refused until an operator reconciles the stable namespaced payment ID and chain evidence.

The protected Preview completed transaction [`0x204f66f2cc3180e619babc9c341ddc71805ca8240a556d4665cf449bfb15300d`](https://testnet.monadscan.com/tx/0x204f66f2cc3180e619babc9c341ddc71805ca8240a556d4665cf449bfb15300d) using the raw-key fallback. Independent RPC checks confirmed chain `10143`, a successful receipt, and the exact 10,000-atomic (test USDC `0.01`) Transfer of the official Monad test-USDC token from the dedicated payer to the distinct payee. The same run recorded the archive payment in Rain's sandbox. The transaction proves only paid availability discovery with the local fixture; bounty, verifiers, and reseeding remained local.

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

The sponsor starter also lists `/payment-routes` and `/simulate/payment-routes`. Lazarus does not implement or claim that separate cross-rail flow; its Rain integration is the scoped-card path shown above.

Rain receives amount, MCC, and expiry controls. Lazarus independently enforces exact merchant, quote, purpose, task scope, rights, budget, and one-use rules. The sandbox has no documented remote cancel route; completion disables local authority and relies on short expiry.

## Merchant bargaining and binding quotes

Rain, Privy, Monad, and x402 do not bargain. Local mode uses the deterministic Atlas state machine. Remote mode sends structured offers and counters to the independently deployed merchant API.

The remote quote commits to merchant/provider identities, MCC, content root, purpose, mission accounting currency, amount, terms, session, issue time, and expiry. Lazarus recomputes the canonical SHA-256 digest, pins the merchant's Ed25519 key fingerprint, and verifies the signature before applying its independent quote and payment policies.

The verified USD acceptance run completed two counteroffer rounds and accepted a signed `$9.75` quote. Lazarus includes the proposed recovery bounty as non-settling context in the offer request, but the merchant currently does not persist it. Its console displays the negotiation/session and signature evidence, not bounty, provider-claim, wallet, or release state.

## Local Monad bounty and recovery

`LocalMonadAdapter` remains the bounty adapter in every mode. Bounty creation, provider claim/collateral, verifier attestations, and 70/90/100 releases are deterministic local transitions with synthetic hashes. The Solidity file is a reference only and is not compiled, deployed, called, or audited by the app.

Local recovery reads the bundled CC0 fixture and verifies 24 pieces. Remote recovery first compares the live provider manifest with the complete sponsor-pinned copy, then bounds and verifies each downloaded piece, total size, reconstructed SHA-256, and root. The completed end-to-end run verified `8/8` remote pieces. Provider networking is real in that profile; verifier independence and persistent reseeding are not.

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
| `GET/POST` | `/api/missions/:id/negotiation` | Read or execute local or authenticated remote bargaining. |
| `POST` | `/api/missions/:id/blocked-purchase` | Exercise an additional denied purchase. |
| `GET` | `/api/missions/:id/export` | Download sanitized audit JSON. |

There are no browser proxy routes for Privy credentials, wallet signing, raw Rain card data, or RPC secrets.

## End-to-end protected-preview checklist

1. Rotate every credential previously exposed outside a secret manager.
2. Keep public Production x402-local with seller disabled and no payer signer. Rain secrets are allowed only for the isolated-state hybrid sandbox profile.
3. Enable Vercel Deployment Protection on the branch Preview.
4. Scope every live variable to that branch Preview; use a unique `preview-*` state key.
5. Create a dedicated low-value payer and a different receive-only payee; configure complete Privy (preferred) or one 32-byte raw key, never both.
6. If Privy is selected, attach a restrictive policy. Fund the chosen payer with only the capped test USDC.
7. Enable the durable seller, configure the protected availability base URL, and confirm Neon is connected.
8. Confirm `/api/health` reports testnet buyer and seller truthfully while bounty writes remain false.
9. Run only the bundled mission once. Retain the payment ID, settlement response, transaction hash, confirmations, exact Transfer evidence, and explorer link.
10. Reconcile any uncertain result before changing the state key or retrying.
11. State the selected profile precisely: the verified x402 Preview keeps bargaining/provider/bounty/verifiers/reseeding local but uses Rain sandbox for archive payment, while hybrid Production uses the remote merchant/provider and Rain sandbox but keeps x402/bounty/verifiers/reseeding local.

Rain is armed in the hybrid Production demo and was independently verified in its ledger: `$9.75` completed at MCC `5734`, while the deliberate `$9.00` MCC `5944` attempt was declined. It remains sandbox-only and requires an isolated Vercel state key.

## Path to production

- Add authenticated users, tenancy, RBAC, quotas/rate limits, audit signing, monitoring, incident response, and managed custody.
- Replace snapshots with normalized operation attempts, receipts, idempotency, reconciliation jobs, and append-only events.
- Complete Rain production onboarding, signed webhooks, cancellation, refunds, disputes, and transaction reconciliation.
- Compile, test, fuzz, audit, deploy, and verify the Monad bounty contract and implement a dedicated writer.
- Productionize the authenticated merchant/provider services and add independent verifier services and signed statements.
- Define real FX, fees, disclosures, refunds, custody, accounting, and reconciliation before claiming production multi-currency support.
- Add isolated recovery workers, content controls, durable artifact storage, and real reseeding evidence.

Until then, the protected branch Preview is a capped testnet demonstration; hybrid Production performs authenticated merchant/provider calls and Rain sandbox writes but no real-money, Monad-payment, bounty, or chain write. The full bounty, verifier network, and reseeding remain local in every profile.
