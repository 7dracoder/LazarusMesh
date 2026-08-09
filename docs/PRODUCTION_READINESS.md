# Lazarus Mesh Production-Readiness Boundary

Updated: 2026-08-08

## Executive status

Lazarus Mesh is a deployment-ready public demo plus access-controlled sandbox/testnet integration paths. It is **not** a production payment, foreign-exchange, wallet, marketplace, or recovery service.

| Component | Executed today | Production boundary |
| --- | --- | --- |
| Mission currencies | Fixed-reference accounting in USD, EUR, GBP, CAD, and AUD | No live FX feed, conversion, custody, fee/spread disclosure, refund FX, or financial ledger |
| Rain | Local simulation or authenticated Rain sandbox calls for rUSD collateral setup, scoped-card issuance, authorization simulation, settlement simulation, reversal, and status lookup | USD-only hackathon sandbox; no production card program, signed webhooks, disputes/refunds, or immediate remote freeze/close |
| Monad x402 | x402-shaped local simulation, or opt-in bounded x402 v2 test-USDC buyer on Monad testnet | Testnet path only; requires a dedicated payer, distinct payee, HTTPS seller, durable payment-ID uniqueness, and reconciliation |
| Monad bounty | Local deterministic bounty ledger | `RecoveryBountyRegistry.sol` is not compiled, deployed, called, or audited by the app |
| Bargaining | Deterministic policy-bounded local offers/counters and binding-quote validation | No authenticated merchant session or merchant-signed binding quote |
| Recovery | Real hashing, piece verification, reconstruction, and root validation over the bundled CC0 fixture | No external provider transfer, durable artifact storage, independent verifier service, or persistent reseeding |

The public Vercel deployment uses free managed Neon Postgres for a versioned JSONB audit-state snapshot. It reloads that state before each request and rehydrates deterministic local adapters. That supports a durable public **local demo**; it is not an external-operation ledger.

Vercel explicitly rejects `ADAPTER_MODE` other than `local` and `MONAD_EXECUTION_MODE` other than `local`. It must not receive Rain credentials, payer keys, production cards, real funds, or live financial traffic. Browser mutations require same-origin requests, but the app still has no user authentication, tenant isolation, RBAC, rate limiting, or production reconciliation.

## Currency boundary

The mission selector supports USD, EUR, GBP, CAD, and AUD through the fixed `lazarus-demo-reference-v1` table. Those values are deterministic demo references, not current market rates. Required reserves and debits round conservatively.

Accounting currency is separate from settlement asset:

- local adapters simulate all value;
- Rain sandbox missions must use USD and collateral setup uses sandbox rUSD;
- opt-in Monad x402 settles official Monad test USDC; its EIP-3009 buyer authorization is gasless, while the submitting seller/facilitator uses MON for gas; and
- the local Monad bounty records selected mission currency plus synthetic settlement references without moving tokens.

Supporting a production multi-currency product would require provider-supported settlement currencies, authoritative FX sources, price-lock windows, fee/spread disclosures, rounding policy, treasury/custody, refunds, disputes, tax/accounting treatment, and end-to-end reconciliation.

## Runtime modes and truth labels

| Configuration | External action possible | Required label |
| --- | --- | --- |
| `ADAPTER_MODE=local`, `MONAD_EXECUTION_MODE=local` | None during mission execution | Local deterministic demo |
| `ADAPTER_MODE=rain-sandbox` | Rain sandbox writes | Hybrid sandbox; no real funds |
| `MONAD_EXECUTION_MODE=x402-testnet` | Capped official test-USDC transfer on Monad testnet | Testnet x402 plus local bounty |
| Both external selections | Rain sandbox calls plus capped Monad x402 testnet payment | Access-controlled integration demo; not production |
| Public Vercel | External selections rejected | Public local-only demo |

`MONAD_EXECUTION_MODE=x402-testnet` swaps only availability discovery. It does not activate the bounty registry, merchant API, provider network, verifier network, or reseeding service.

Do not say a real transaction occurred unless a specific run produced a confirmed transaction hash and the exact official test-USDC `Transfer` was independently verified. The presence of configuration or a successful readiness probe is not transaction evidence.

## Mission-creation contract

The mission form and API publish currency-specific limits through `state.system.missionCreation`. The USD reference limits are:

- verified source: bundled 24-piece CC0 fixture;
- minimum recovery-service spend cap: USD 12.01;
- maximum recovery-service spend cap: USD 5,000.00;
- provider reward range: USD 1.00 to USD 1,000.00;
- default recovery spend cap: USD 20.00; and
- default provider reward: USD 5.00.

The service cap and provider bounty are separate commitments. The USD 12.01 reserve covers the USD 12.00 maximum local archive quote plus a one-cent discovery reference. The successful local bargain is USD 9.75, so the default demonstrated service accounting is USD 9.76. Other mission currencies use deterministic reference equivalents.

Mission creation fails closed for unsupported currencies, rights, content root, piece count, license, budget, or reward. Rain sandbox additionally rejects non-USD missions.

## Capped x402 testnet prerequisites

Before setting `MONAD_EXECUTION_MODE=x402-testnet`:

1. Rotate every credential that has appeared in chat, logs, screenshots, or a commit.
2. Use a dedicated low-value payer key in an access-controlled local runtime.
3. Fund the payer with only the required official Monad test USDC. Confirm the submitting seller/facilitator can fund MON gas; do not require MON in the buyer wallet unless that service explicitly does.
4. Configure a distinct payee wallet; payer and payee must not be the same.
5. Use a credential-free HTTPS Monad RPC and HTTPS seller resource.
6. Require the seller to return the exact x402 v2 requirement for `eip155:10143`, pinned official test USDC, configured payee, expected resource, expected price, and required payment identifier.
7. Enforce durable uniqueness for the payment identifier on the seller and persist paid results. Exact duplicates must return the existing result without a second charge.
8. Use the implemented durable buyer pending-payment record: it is written before signing/transmission and blocks reset, fresh startup, and repeat authorization. Reconcile and deliberately clear any unknown outcome before proceeding.
9. Retain the settlement response, transaction hash, confirmation evidence, exact token `Transfer` log, explorer link, and payment ID.
10. Keep public Vercel in local mode.

The current adapter performs fail-closed requirement validation, amount/asset/network/payee/resource checks, payer balance checks, a durable pre-sign pending-payment gate, bounded signing, stable payment identifiers, response limits, confirmation waiting, and independent receipt-log verification. Those controls make the testnet demo bounded; they do not provide an automated operator reconciliation/clearance workflow or normalized production ledger.

## Crash-safety and idempotency boundary

Every external operation must be a resumable saga:

1. durably create a pending operation before signing or sending;
2. assign a stable idempotency/payment identifier;
3. persist remote identifiers and receipts immediately;
4. reconcile before retrying a timeout or ambiguous response;
5. make seller-side payment identifiers globally unique; and
6. test process termination after every external mutation.

The local CLI snapshot durably stores the x402 pending-payment gate before signing and restores the fail-closed block after restart. It and the Vercel JSONB demo snapshot are still not normalized external-operation journals, and the public Vercel runtime disables live x402. The Rain sandbox path similarly checkpoints known card/authorization state and blocks destructive replacement while recorded card authority may remain live. Neither path is a complete automated webhook/reconciliation saga.

## Required path to a production release

1. Replace snapshot persistence with normalized transactional missions, operation attempts, idempotency records, receipts, reconciliation state, and append-only audit events.
2. Add authentication, tenant isolation, RBAC, rate limits, quotas, telemetry redaction, backups, incident response, and managed secret/custody boundaries.
3. Add signed Rain webhooks with replay protection, transaction reconciliation, refunds/reversals, disputes, and a real freeze/close lifecycle; complete production issuer/compliance onboarding.
4. Compile, test, fuzz, audit, deploy, and verify `RecoveryBountyRegistry.sol`; implement a separate Monad writer with chain/code checks, simulation, nonce/fee policy, confirmation, replacement, reorg, dispute, and restart reconciliation.
5. Operate a durable x402 seller/facilitator boundary and buyer reconciliation system; test duplicate, unknown-outcome, outage, wrong-chain/token/payee/amount, expiry, and insufficient-funds cases.
6. Replace the local Atlas merchant with an authenticated negotiation API whose binding quote is independently signed/verifiable.
7. Add authenticated provider streaming, signed manifests, isolated recovery workers, malware/content controls, durable artifact storage, independent verifier services, persistent reseeding, and ongoing availability evidence.
8. Define and obtain approval for the complete multi-currency/FX, fee, refund, custody, disclosure, accounting, and compliance model.
9. Run capped sandbox/testnet pilots before any mainnet or production-card use.

## Go-live tests

- multi-currency rounding, limit, refund, and reconciliation properties;
- Solidity unit, invariant, fuzz, fork, malicious-token, deadline, dispute, and replay tests;
- Monad nonce, fee, confirmation, replacement, and reorg tests;
- x402 wrong-chain, wrong-token, wrong-payee, overprice, expiry, duplicate, unknown-outcome, seller/facilitator outage, and insufficient-funds tests;
- Rain sandbox/production contract tests plus signed-webhook replay and reordering tests;
- merchant identity, signature, replay, expiry, and term-tampering tests;
- provider corruption, truncation, timeout, partial failure, and reseeding-availability tests;
- crash/restart tests after every external mutation; and
- authentication, tenant-boundary, SSRF, payment-drain, custody, and card-data security reviews.

## Current protocol references

- [Monad network information](https://docs.monad.xyz/developer-essentials/network-information)
- [Monad testnet information](https://docs.monad.xyz/developer-essentials/testnet)
- [Monad x402 guide](https://docs.monad.xyz/guides/x402)
- [x402 v2 client/server flow](https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works)
- [x402 facilitator responsibilities](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)

Monad mainnet uses chain ID `143`; this project intentionally pins the live x402 adapter to testnet chain ID `10143`. See [Hackathon Acceptance and Currency Model](HACKATHON_ACCEPTANCE_AND_CURRENCY.md) for the concise demo truth table and [API and Testnet Integration Guide](API_INTEGRATION.md) for exact configuration.
