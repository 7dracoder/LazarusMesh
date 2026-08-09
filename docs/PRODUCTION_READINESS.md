# Lazarus Mesh Production-Readiness Boundary

Updated: 2026-08-09

## Executive status

Lazarus Mesh is a deployment-ready public local demo plus a separately protected, one-shot Monad testnet preview. It is **not** a production payment, wallet, foreign-exchange, marketplace, or recovery service.

| Component | Executed today | Production boundary |
| --- | --- | --- |
| Mission currencies | Fixed-reference accounting in USD, EUR, GBP, CAD, and AUD | No live FX, conversion, custody, spread/fee disclosure, or refund reconciliation |
| Rain | Implemented local and sandbox adapters | Sandbox is currently unarmed: the exposed key must be rotated and the supplied collateral/contract value is not a valid UUID |
| Monad x402 buyer | Local simulation in Production; capped real test-USDC path in protected Preview | Preview only, one fixed mission, Privy signer, one-cent cap, six confirmations |
| Monad x402 seller | Durable protected-Preview seller with Neon payment-ID records | Disabled in public Production; no unrestricted public paid endpoint |
| Wallets | Dedicated Privy payer and distinct receive-only payee | Testnet-only; no payee secret is stored; no raw private key is accepted by Vercel live mode |
| Monad bounty | Local deterministic bounty ledger | Reference Solidity is not compiled, deployed, called, or audited by the app |
| Bargaining | Deterministic local offers/counters and quote policy | No authenticated merchant session or merchant signature |
| Recovery | Real fixture hashing/reconstruction | No remote provider transfer, independent verifier, durable storage, or persistent reseeding |

## Deployment safety model

### Public Production

Production is fully local-only:

- `ADAPTER_MODE=local`;
- `MONAD_EXECUTION_MODE=local`;
- `X402_SELLER_ENABLED=false`;
- `ALLOW_EXTERNAL_WRITES_ON_VERCEL=false`;
- no Privy payer or Rain secrets; and
- the primary Neon state key.

It can create/reset demo missions, bargain locally, simulate payment rails, verify fixture bytes, and persist the sanitized demo state. It cannot sign, settle, receive, or verify a live payment.

### Protected branch Preview

The live testnet Preview is allowed only when all controls agree:

1. Vercel identifies both environment and target as Preview.
2. Vercel Deployment Protection is enabled.
3. The current Git branch exactly matches the configured live branch.
4. External writes are explicitly armed.
5. State uses a unique `preview-*` key, namespaces payment IDs with that key, and contains only the bundled mission.
6. Price and cap are both exactly 10,000 atomic test-USDC units.
7. Authorization is no longer than 300 seconds and confirmations are at least six.
8. All Privy payer variables exist and no raw private key exists.
9. Buyer and receive-only payee are different addresses.
10. The durable x402 seller and Neon settlement store are enabled in the same protected deployment.

The preview disables reset and arbitrary mission creation and gives its immutable mission a 30-day demo lifetime. The buyer uses an internal same-origin seller transport to avoid bypassing Vercel Deployment Protection; the HTTP seller route remains behind that protection.

Host/branch checks and one-shot state are defense in depth. They do not replace deployment authentication, Privy policy, application policy, budget caps, or operator monitoring.

## Wallet and signing boundary

The Privy payer holds only the test USDC required for the demo. The payee is receive-only from the application's perspective, so Vercel needs only its public address—not its seed phrase, private key, or wallet API secret.

Attach a restrictive Privy wallet policy. Lazarus independently rejects any typed data that is not the exact approved EIP-3009 `TransferWithAuthorization` envelope. It pins schema, Monad testnet, test-USDC domain/contract, payer, payee, amount cap, nonce, and short lifetime, then verifies Privy's returned signature against the configured payer.

A leaked Privy app secret could still be dangerous within whatever Privy policy allows. Keep it encrypted, preview/branch-scoped, rotated, monitored, and out of production.

## Currency boundary

Mission accounting and settlement are different layers:

- USD/EUR/GBP/CAD/AUD are fixed demo accounting currencies;
- Rain sandbox, once configured, accepts USD and uses sandbox rUSD collateral;
- x402 settles the pinned Monad test-USDC token; and
- MON pays settlement-submitter gas.

The selector does not exchange currency or make the external rail multi-currency. A production multi-currency product still needs authoritative rates, price locks, spreads/fees, rounding, provider-supported settlement currencies, treasury/custody, disclosures, refunds, disputes, tax/accounting treatment, and reconciliation.

## Rain activation blocker

The code validates provider-issued UUIDs and fails closed. The currently supplied collateral/contract value is not UUID-valid, and the previously shared API key must be rotated. Therefore:

- leave Rain disabled in Vercel and local demos by default;
- never guess or transform the identifier;
- obtain a new sandbox key and valid UUID from Rain;
- store them only in an access-controlled server-side secret manager; and
- run authenticated health before the first sandbox mutation.

The adapter being implemented and unit-tested is not proof that the current Rain tenant is authenticated or funded.

## x402 crash safety and idempotency

The buyer builds, signs, validates, and encodes the authorization first, then persists an unresolved operation immediately before any paid seller request. Concurrent requests may create unused signatures, but only the durable state-write/CAS winner can transmit. A definitive signing, validation, encoding, or persistence failure sends no paid request. Only one unresolved transmitted buyer payment may exist across the state. Ambiguous post-transmission results block reset, fresh payment, and automatic retry until reconciled.

The seller reserves each namespaced payment ID in Neon before settlement and binds it to a fingerprint and content root. Exact settled replays return the stored response without a second charge. Conflicts, processing records, and uncertain outcomes fail closed. A successful settlement whose response cannot be durably saved becomes an operator-reconciliation incident. The buyer commits the confirmed receipt, cleared pending gate, bargaining result, and step index together; a failure before that final commit leaves the durable gate in place instead of recording a half-applied step.

These safeguards are suitable for one controlled testnet run. Production still requires normalized transactional operations, horizontally safe locking, explicit reconciliation/clearance tooling, alerting, backups, and incident procedures.

## What remains local

Even after a confirmed preview transaction:

- Atlas merchant bargaining is local;
- the `$9.75` archive allocation is local unless a separately configured Rain sandbox run is performed;
- provider discovery metadata is deterministic;
- the full Monad bounty/collateral/reward lifecycle is local;
- provider data retrieval uses the bundled fixture;
- verifier independence is scripted; and
- two seeders are modeled rather than started.

Do not say the marketplace or bounty is onchain merely because the discovery payment is.

## Required path to production

1. Add authenticated users, tenant isolation, RBAC, per-tenant budgets, rate limits, quotas, audit signing, monitoring, backups, and incident response.
2. Replace JSONB snapshots with normalized missions, attempts, idempotency records, receipts, reconciliation state, and append-only audit events.
3. Complete Rain production onboarding; add signed webhooks, replay handling, remote cancellation, refunds/reversals, disputes, and ledger reconciliation.
4. Compile, test, fuzz, audit, deploy, and verify the Monad bounty contract; add a separate writer with simulation, nonce/fee policy, confirmations, replacement, reorg, and recovery logic.
5. Productionize x402 custody, policies, quotas, seller locks, reconciliation, facilitator failover, and mainnet/token review.
6. Replace Atlas with an authenticated merchant API and independently verifiable binding quotes.
7. Add authenticated provider streaming, signed manifests, isolated workers, malware/content controls, independent verifier services, durable artifact storage, and real reseeding evidence.
8. Define the complete FX, fee, refund, custody, disclosure, accounting, tax, and compliance model.

## Go-live tests

- Privy policy-denial and code-level wrong-method/chain/token/payee/amount/lifetime tests;
- preview-to-production environment isolation and Deployment Protection tests;
- one-shot state, host/branch, reset, and mission-creation denial tests;
- buyer and seller payment-ID replay/conflict/unknown-outcome/restart tests;
- x402 wrong chain, token, payee, amount, resource, expiry, facilitator outage, and insufficient-balance tests;
- Rain UUID/authentication, sandbox contract, webhook, reversal, and reordering tests;
- merchant identity/signature/replay/expiry/term tests;
- multi-currency rounding, refund, and reconciliation properties;
- Solidity unit, invariant, fuzz, fork, dispute, and replay tests;
- provider corruption/timeout/partial-failure/reseeding tests; and
- authentication, tenant-boundary, SSRF, payment-drain, custody, and card-data security reviews.

## Current protocol references

- [Monad network information](https://docs.monad.xyz/developer-essentials/network-information)
- [Monad x402 guide](https://docs.monad.xyz/guides/x402)
- [x402 buyer flow](https://docs.x402.org/getting-started/quickstart-for-buyers)
- [x402 seller flow](https://docs.x402.org/getting-started/quickstart-for-sellers)
- [Privy create server wallet API](https://docs.privy.io/api-reference/wallets/create)

Public Production remains entirely local-only. The protected Preview proves, at most, one bounded test-USDC discovery settlement—not production readiness.
