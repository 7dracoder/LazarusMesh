# Hackathon Acceptance and Currency Model

Updated: 2026-08-09

This is the canonical truth table for the hackathon demo. It explains what the currency selector means, which deployment can move testnet value, and which parts are still deterministic models.

Never add API keys, app secrets, wallet IDs, wallet addresses, seed phrases, Rain tenant identifiers, or card data to this file. Rotate any credential previously disclosed outside a secret manager.

## One-sentence boundary

Lazarus Mesh supports fixed-reference mission accounting in USD, EUR, GBP, CAD, and AUD; public Production is entirely local-only; a deployment-protected, one-shot branch Preview can settle one capped x402 discovery payment in Monad test USDC through a Privy payer and distinct receive-only payee; the Rain adapter is currently blocked on a rotated key and valid UUID; the archive bargain and full bounty remain local.

## Three kinds of value

| Layer | Values | Meaning |
| --- | --- | --- |
| Mission accounting | USD, EUR, GBP, CAD, AUD | Display, budget, bargaining, savings, policy, and local reward amounts in integer minor units |
| External settlement | x402: test USDC; Rain: USD sandbox authorization/rUSD collateral | Rail-specific test or sandbox value, separate from mission currency |
| Chain gas/collateral | MON | Settlement-submitter gas; native provider collateral exists only in the undeployed reference contract |

Multi-currency accounting does not mean every rail accepts every currency. USDC and MON are not selectable mission-accounting currencies.

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
| Public Vercel Production | Local | Local buyer; seller disabled | Local ledger | All five accounting currencies; no payment/chain writes |
| Protected Vercel branch Preview | Local | Privy buyer plus durable co-located seller | Local ledger | One fixed mission; capped test-USDC discovery settlement |

Rain and Monad selectors remain independent, but Vercel never permits Rain sandbox. Public Production never permits either x402 side. The protected Preview permits buyer and seller only together behind Deployment Protection and the runtime's one-shot gates.

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

The current Rain run is not acceptable yet because:

1. the previously disclosed API key must be rotated; and
2. the supplied collateral/contract value is not a valid UUID.

Do not guess or edit the identifier. Keep `ADAPTER_MODE=local` until Rain supplies both values through a secure channel. Once armed, the mission must use USD, collateral setup uses sandbox rUSD, and the demo must be labeled sandbox simulation.

## Monad bounty boundary

The full recovery bounty remains `LocalMonadAdapter` in every mode. Bounty creation, provider claim/collateral, verifier attestations, and 70/90/100 releases are deterministic local transitions with synthetic hashes. The reference Solidity contract is not compiled, deployed, called, or audited by the app.

## Mapping to hackathon criteria

| Criterion | Demonstrable evidence | Caveat |
| --- | --- | --- |
| Real Monad transaction | Protected Preview can produce a confirmed test-USDC x402 transaction | Production/local runs do not; full bounty remains local |
| Chain matters | Paid discovery gates the provider recommendation and is bound to a verified Transfer | Archive fulfillment and bounty are not chain-dependent yet |
| Agent autonomy with guardrails | Orchestrator bargains while deterministic policy and restricted Privy signing cap authority | Merchant and verifiers are scripted models |
| Onchain-native story | Paid availability intelligence plus proof-conditioned recovery/reward model | Do not overstate simulated providers, reseeding, or contract settlement |

## Demo acceptance checklists

### Public Production demo

- Confirm Production reports local buyer and seller disabled.
- Create USD/EUR/GBP/CAD/AUD missions and show the fixed-reference disclaimer.
- Show the local bargaining transcript and 2.25 reference savings.
- Show unrelated purchase denial, verified reconstruction, verifier quorum, and local tranche releases.
- State that no value moved.

### Protected x402 Preview demo

- Confirm Vercel Deployment Protection is enabled.
- Confirm every live value is scoped only to the intended branch Preview and state key starts with `preview-`.
- Confirm the dedicated Privy payer and different receive-only payee.
- Confirm price/cap, short expiry, six confirmations, seller enabled, and bounty writes disabled.
- Run only the preloaded bundled mission; reset and new-mission creation must be denied.
- Retain payment ID, settlement response, transaction hash, confirmation evidence, exact Transfer, and explorer link.
- Reconcile any ambiguous outcome before retry.
- State explicitly that bargaining, archive payment, bounty, provider network, verifier network, and reseeding remain local.

### Rain sandbox demo

- Do not run until the key is rotated and Rain supplies a valid UUID.
- Use USD mission accounting.
- Confirm authenticated health and sandbox labels.
- Show the bounded card, deliberate denial, and approved sandbox settlement without exposing card data.
- State that rUSD provisioning is sandbox setup, not an account balance or mission spend.

## What this release does not claim

- live FX or settlement in EUR/GBP/CAD/AUD;
- a production card purchase or real fiat movement;
- a live bargaining merchant or merchant-signed quote;
- a deployed Monad bounty registry;
- a real provider/verifier/seeding network;
- unrestricted wallet authority;
- a public paid x402 seller; or
- production readiness.

For exact configuration, see [API and Testnet Integration Guide](API_INTEGRATION.md). For operational gaps, see [Production Readiness](PRODUCTION_READINESS.md).
