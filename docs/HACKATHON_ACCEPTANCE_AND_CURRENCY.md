# Hackathon Acceptance and Currency Model

Updated: 2026-08-09

This is the canonical truth table for the hackathon demo. It explains what the currency selector means, which deployment can move testnet value, and which parts are still deterministic models.

Never add API keys, app secrets, wallet IDs, wallet addresses, seed phrases, Rain tenant identifiers, or card data to this file. Rotate any credential previously disclosed outside a secret manager.

## One-sentence boundary

Lazarus Mesh supports fixed-reference local accounting in USD, EUR, GBP, CAD, and AUD; Production can bargain with an authenticated remote merchant and verify its eight-piece provider artifact while all value and chain execution remain local; a separate protected Preview can settle one capped x402 discovery payment with the pinned local fixture; Rain remains blocked on a rotated key and valid UUID; the full bounty remains local.

## Three kinds of value

| Layer | Values | Meaning |
| --- | --- | --- |
| Mission accounting | USD, EUR, GBP, CAD, AUD | Display, budget, bargaining, savings, policy, and local reward amounts in integer minor units |
| External settlement | x402: test USDC; Rain: USD sandbox authorization/rUSD collateral | Rail-specific test or sandbox value, separate from mission currency |
| Chain gas/collateral | MON | Settlement-submitter gas; native provider collateral exists only in the undeployed reference contract |

Multi-currency accounting does not mean every rail accepts every currency. USDC and MON are not selectable mission-accounting currencies.

The remote merchant accepts one configured currency at a time and is currently USD. It does not make the external service simultaneously multi-currency.

## Fixed demo references

The rate set is `lazarus-demo-reference-v1`, not live foreign exchange:

| Mission currency | Minor units per reference USD |
| --- | ---: |
| USD | 100 |
| EUR | 92 |
| GBP | 78 |
| CAD | 137 |
| AUD | 152 |

Debits and required reserves round conservatively upward; maxima round downward. The USD reference story is a 12.00 ask bargained to 9.75, 0.01 discovery accounting, and 2.25 savings. Other currencies show deterministic equivalents, not a market conversion.

## Rail and deployment matrix

| Runtime | Rain | x402 buyer/seller | Monad bounty | Currency boundary |
| --- | --- | --- | --- | --- |
| Local defaults | Local scoped-card simulation | Local x402-shaped simulation; seller disabled | Local ledger | USD/EUR/GBP/CAD/AUD; no value moves |
| Local Rain sandbox | Authenticated sandbox calls after credentials are fixed | Local unless independently enabled | Local ledger | USD only; sandbox rUSD collateral |
| Local x402 testnet | Local Rain simulation | Dedicated signer plus configured seller | Local ledger | Any accounting currency; settlement remains test USDC |
| Public Vercel Production | Local, or armed Rain sandbox with an isolated state key | Local buyer; seller disabled | Local ledger | Local mode supports all five; current remote merchant is USD; no payment/chain writes |
| Protected Vercel branch Preview | Local | Privy buyer plus durable co-located seller | Local ledger | One fixed mission; capped test-USDC discovery settlement |

Rain, Monad, and merchant selectors remain independent within policy constraints, but Vercel never permits Rain sandbox. Public Production never permits either live x402 side. The protected Preview permits buyer and seller only together behind Deployment Protection and the runtime's one-shot gates, and it forbids remote merchant mode.

## What “x402” means

### Local mode

`LocalX402Adapter` returns a 402-shaped requirement and synthetic receipt. It does not sign, call a facilitator, move a token, pay gas, or produce an explorer transaction.

### Protected testnet Preview

The Preview performs the buyer and seller sides of x402 v2 exact:

1. the bundled mission requests the exact availability resource;
2. the co-located protected seller returns a pinned test-USDC requirement;
3. the Privy payer signs only the approved EIP-3009 typed data;
4. the buyer validates and encodes it, then durably records a pending payment immediately before transmission;
5. the seller asks the facilitator to verify and settle;
6. Neon durably stores payment-ID/fingerprint/resource/settlement/replay state; and
7. the buyer waits for confirmations and verifies the exact token Transfer to the distinct payee.

The default price and cap are both 10,000 token atomic units, representing test USDC 0.01. The buyer's authorization is gasless; the settlement submitter needs testnet MON.

The buyer uses an internal same-origin seller transport so it does not bypass Vercel Deployment Protection. The HTTP seller route remains behind that protection and is disabled in Production.

## Wallet and policy acceptance

The payer is a dedicated low-value Privy server wallet. The payee is a different receive-only address; no payee private key is needed.

The demo is acceptable only when:

- Vercel live mode contains no raw private key;
- Privy secrets are encrypted and branch-scoped;
- a restrictive Privy policy is attached;
- application code independently allows only the pinned `TransferWithAuthorization` schema/domain/chain/token/payer/payee/cap/window/nonce;
- the returned signature matches the configured payer;
- the payer holds only the needed test USDC; and
- any uncertain result is reconciled before retry.

## Rain acceptance boundary

The adapter implements Rain sandbox collateral setup, scoped-card issuance, authorization, settlement, reversal, and card lookup. Those endpoints simulate card operations and do not prove production-money movement.

The Rain run is now acceptable to present as a sandbox demonstration:

1. authenticated health passes for the configured tenant;
2. the collateral/contract UUID was confirmed against the provider by control, not guessed; and
3. a full mission issued a real scoped card, settled `$9.75` at MCC `5734`, and had the `$9.00` unrelated-merchant attempt declined — visible in Rain's own ledger.

Present it as sandbox simulation. The mission must use USD, collateral setup uses sandbox rUSD, and no real money moves. Rotate any key disclosed outside a secret manager.

## Monad bounty boundary

The full recovery bounty remains `LocalMonadAdapter` in every mode. Bounty creation, provider claim/collateral, verifier attestations, and 70/90/100 releases are deterministic local transitions with synthetic hashes. The reference Solidity contract is not compiled, deployed, called, or audited by the app.

## Mapping to hackathon criteria

| Criterion | Demonstrable evidence | Caveat |
| --- | --- | --- |
| Real Monad transaction | Protected Preview can produce a confirmed test-USDC x402 transaction | Production/local runs do not; full bounty remains local |
| Chain matters | Paid discovery gates the provider recommendation and is bound to a verified Transfer | Archive fulfillment and bounty are not chain-dependent yet |
| Agent autonomy with guardrails | Orchestrator bargains with the authenticated merchant while deterministic policy and restricted Privy signing cap authority | Merchant behavior is structured/deterministic; verifiers remain scripted |
| Remote recovery | Sponsor-pinned manifest, authenticated piece transfer, `8/8` hashes, reconstructed root match | No durable replica host, independent verifier, or persistent reseeding |
| Onchain-native story | Paid availability intelligence plus proof-conditioned recovery/reward model | Do not overstate local bounty, verifier roles, reseeding, or contract settlement |

## Demo acceptance checklists

### Remote merchant Production demo

- Confirm Production reports local x402/Rain/Monad execution and the authenticated remote merchant/provider.
- Use USD; explain that local core accounting supports five currencies but this merchant deployment accepts one at a time.
- Show two bargaining rounds, the Ed25519-signed 9.75 quote, and 2.25 savings in both Lazarus and the merchant console.
- Show `8/8` provider pieces, sponsor-pinned manifest equality, and reconstructed hash/root match.
- Show unrelated purchase denial, verified reconstruction, verifier quorum, and local tranche releases.
- State that the offer includes proposed bounty context, the merchant console does not yet persist or display it, and `$0.00` was charged with no chain write.

### Protected x402 Preview demo

- Confirm Vercel Deployment Protection is enabled.
- Confirm every live value is scoped only to the intended branch Preview and state key starts with `preview-`.
- Confirm the dedicated Privy payer and different receive-only payee.
- Confirm price/cap, short expiry, six confirmations, seller enabled, and bounty writes disabled.
- Run only the preloaded bundled mission; reset and new-mission creation must be denied.
- Retain payment ID, settlement response, transaction hash, confirmation evidence, exact Transfer, and explorer link.
- Reconcile any ambiguous outcome before retry.
- State explicitly that this x402 profile uses the local fixture; archive payment, bounty, verifier network, and reseeding remain local.

### Rain sandbox demo

- Do not run until the key is rotated and Rain supplies a valid UUID.
- Use USD mission accounting.
- Confirm authenticated health and sandbox labels.
- Show the bounded card, deliberate denial, and approved sandbox settlement without exposing card data.
- State that rUSD provisioning is sandbox setup, not an account balance or mission spend.

## What this release does not claim

- live FX or settlement in EUR/GBP/CAD/AUD;
- a production card purchase or real fiat movement;
- production merchant checkout, payment reconciliation, or a merchant-visible bounty;
- a deployed Monad bounty registry;
- durable provider storage, an independent verifier network, or persistent seeding;
- unrestricted wallet authority;
- a public paid x402 seller; or
- production readiness.

For exact configuration, see [API and Testnet Integration Guide](API_INTEGRATION.md). For operational gaps, see [Production Readiness](PRODUCTION_READINESS.md).
