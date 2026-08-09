# Lazarus Mesh Production-Readiness Boundary

Updated: 2026-08-09

## Executive status

Lazarus Mesh is a deployment-ready demo with an authenticated remote merchant/provider profile, a local-only fallback, and a separately protected one-shot Monad testnet preview. It is **not** a production payment, wallet, foreign-exchange, marketplace, or durable recovery service.

| Component | Executed today | Production boundary |
| --- | --- | --- |
| Mission currencies | Fixed-reference accounting in USD, EUR, GBP, CAD, and AUD | No live FX, conversion, custody, spread/fee disclosure, or refund reconciliation |
| Rain | Implemented local and sandbox adapters; sandbox armed and verified end-to-end against the provider | Still a sandbox card program: simulated issuing/authorization endpoints, no production money movement, no card-cancel route |
| Monad x402 buyer | Local simulation in Production; capped real test-USDC path in protected Preview | Preview only, one fixed mission, Privy signer, one-cent cap, six confirmations |
| Monad x402 seller | Durable protected-Preview seller with Neon payment-ID records | Disabled in public Production; no unrestricted public paid endpoint |
| Wallets | Dedicated Privy payer and distinct receive-only payee | Testnet-only; no payee secret is stored; no raw private key is accepted by Vercel live mode |
| Monad bounty | Local deterministic bounty ledger | Reference Solidity is not compiled, deployed, called, or audited by the app |
| Bargaining | Local Atlas fallback or authenticated HTTPS merchant sessions | Remote quotes are Ed25519-signed and key-pinned; checkout/payment remains local demo |
| Recovery | Bundled 24-piece fixture or authenticated remote eight-piece provider | Remote bytes and hash/root verification are real; no independent verifier, durable artifact storage, or persistent reseeding |

## Deployment safety model

### Public Production

Production keeps all financial execution local, while optionally allowing the remote merchant/provider:

- `ADAPTER_MODE=local`;
- `MONAD_EXECUTION_MODE=local`;
- `MERCHANT_MODE=local` or the explicitly configured `remote` profile;
- `X402_SELLER_ENABLED=false`;
- `ALLOW_EXTERNAL_WRITES_ON_VERCEL=false`;
- no Privy payer or Rain secrets; and
- `primary` for local Production or an explicit isolated `merchant-*` Neon state key for remote Production.

In remote mode it can create authenticated merchant sessions, verify Ed25519-signed quotes, download provider pieces over HTTPS, and validate them against a sponsor-pinned manifest. The verified USD run completed two bargaining rounds at `$9.75`, verified `8/8` pieces and the reconstructed root, charged `$0.00`, and made no chain write. Production still cannot sign, settle, receive, or verify a live payment.

Remote configuration uses only these server-side environment names:

```text
MERCHANT_MODE
LAZARUS_STATE_KEY
MERCHANT_BASE_URL
MERCHANT_API_TOKEN
MERCHANT_EXPECTED_KEY_ID
MERCHANT_CURRENCY
MERCHANT_TRUSTED_MANIFEST_JSON
MERCHANT_TIMEOUT_MS
MERCHANT_RESPONSE_LIMIT_BYTES
MERCHANT_MAXIMUM_PIECE_BYTES
MERCHANT_MAXIMUM_TOTAL_BYTES
```

The current merchant at `https://lazarus-merchant.vercel.app` accepts USD. A remote deployment supports one configured accounting currency at a time even though local core accounting supports USD, EUR, GBP, CAD, and AUD.

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

The preview disables reset and arbitrary mission creation and gives its immutable mission a 30-day demo lifetime. The buyer uses an internal same-origin seller transport to avoid bypassing Vercel Deployment Protection; the HTTP seller route remains behind that protection. Current safety policy forbids combining this live x402 profile with remote merchant mode.

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

## Rain activation status

The code validates provider-issued UUIDs and fails closed. Both prerequisites are now satisfied and were checked against the provider rather than assumed:

- authenticated health (`GET /issuing/transactions`) returns `200` for the configured tenant;
- the collateral/contract UUID was confirmed by control: the real identifier returns `202 {"success":true}` from `/simulate/collateral/fund`, while a well-formed but unknown UUID returns `404 not found`; and
- a complete mission issued a real scoped card, settled `$9.75` at MCC `5734`, and had the `$9.00` unrelated-merchant challenge declined, all reflected in Rain's own transaction ledger.

Operational rules that still apply:

- never guess or transform a provider identifier — validate it against the provider;
- keep the key in encrypted server-side configuration only;
- rotate any key that has been pasted into a chat, transcript, or ticket; and
- respect the sandbox quota (10 active scoped cards, 10 created per user per rolling 24 hours), which a public deployment shares.

A verified sandbox run is still not proof of production-money movement. Rain's `/simulate/*` endpoints model issuing and transaction behavior.

## x402 crash safety and idempotency

The buyer builds, signs, validates, and encodes the authorization first, then persists an unresolved operation immediately before any paid seller request. Concurrent requests may create unused signatures, but only the durable state-write/CAS winner can transmit. A definitive signing, validation, encoding, or persistence failure sends no paid request. Only one unresolved transmitted buyer payment may exist across the state. Ambiguous post-transmission results block reset, fresh payment, and automatic retry until reconciled.

The seller reserves each namespaced payment ID in Neon before settlement and binds it to a fingerprint and content root. Exact settled replays return the stored response without a second charge. Conflicts, processing records, and uncertain outcomes fail closed. A successful settlement whose response cannot be durably saved becomes an operator-reconciliation incident. The buyer commits the confirmed receipt, cleared pending gate, bargaining result, and step index together; a failure before that final commit leaves the durable gate in place instead of recording a half-applied step.

These safeguards are suitable for one controlled testnet run. Production still requires normalized transactional operations, horizontally safe locking, explicit reconciliation/clearance tooling, alerting, backups, and incident procedures.

## What remains local

Even after a verified remote merchant run or confirmed preview transaction:

- remote merchant bargaining and provider downloads may be external, but the local Atlas fallback remains available;
- the `$9.75` archive allocation is local unless a separately configured Rain sandbox run is performed;
- the remote provider serves real bytes from its configured fixture, but no durable recovery network is created;
- the full Monad bounty/collateral/reward lifecycle is local;
- verifier independence is scripted; and
- two seeders are modeled rather than started.

The merchant offer request includes the proposed bounty as non-settling context. The merchant service currently does not persist it, so its console shows negotiation/session state and the signed deal but has no bounty field, wallet, claim control, or release history. The merchant sale price and provider recovery bounty remain separate concepts.

Do not say the marketplace or bounty is onchain merely because the discovery payment is.

## Required path to production

1. Add authenticated users, tenant isolation, RBAC, per-tenant budgets, rate limits, quotas, audit signing, monitoring, backups, and incident response.
2. Replace JSONB snapshots with normalized missions, attempts, idempotency records, receipts, reconciliation state, and append-only audit events.
3. Complete Rain production onboarding; add signed webhooks, replay handling, remote cancellation, refunds/reversals, disputes, and ledger reconciliation.
4. Compile, test, fuzz, audit, deploy, and verify the Monad bounty contract; add a separate writer with simulation, nonce/fee policy, confirmations, replacement, reorg, and recovery logic.
5. Productionize x402 custody, policies, quotas, seller locks, reconciliation, facilitator failover, and mainnet/token review.
6. Productionize the authenticated merchant API with tenant identity, key rotation, quote/payment reconciliation, operator controls, rate limits, and a separately designed bounty-status contract.
7. Extend authenticated provider delivery with isolated workers, malware/content controls, independent verifier services, durable artifact storage, and real reseeding evidence.
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

Public Production may prove authenticated bargaining and remote artifact transfer, but its money, bounty, verifier, and reseeding paths remain local. The protected Preview separately proves, at most, one bounded test-USDC discovery settlement. Neither profile is production readiness.
