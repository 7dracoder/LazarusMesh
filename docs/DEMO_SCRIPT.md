# Four-Minute Demo Script

## Before presenting

Rain and Monad x402 are independent switches. Choose and state the exact mode:

- `ADAPTER_MODE=local` and `MONAD_EXECUTION_MODE=local`: every payment and chain action is simulated; `$0.00` is charged.
- `ADAPTER_MODE=rain-sandbox`: Rain uses its external sandbox. This does not enable Monad writes.
- `MONAD_EXECUTION_MODE=x402-testnet`: a server-side payer signs one capped EIP-3009 authorization and the configured x402 seller/facilitator settles the discovery fee in **test USDC** on Monad testnet. The app requires a confirmed chain receipt. The bounty, bargaining merchant, provider, verifiers, recovery bytes, and modeled reseeding remain local.

The public Vercel deployment forces both execution modes to `local`; live sandbox/testnet modes are available only in an explicitly configured, access-controlled Node runtime. In Rain sandbox mode, confirm `/api/health` reports Rain authenticated. Never describe sandbox or testnet assets as production money.

The mission accounting selector supports USD, EUR, GBP, CAD, and AUD using fixed demo reference rates, not live FX. Use USD for the timings and amounts below. Rain sandbox accepts USD missions only; local execution supports all five accounting currencies. Monad settlement remains test USDC regardless of the selected accounting currency.

## 0:00–0:25 — The problem

“This CC0 research dataset still has a valid cryptographic manifest, but it has zero complete seeders. A content address proves identity; it does not guarantee availability.”

Show `DEAD`, zero seeders, and 24 missing pieces.

## 0:25–0:50 — Mission and authority

Show:

- `$20.00` total mission budget;
- `$5.00` local recovery bounty;
- public-domain rights evidence;
- one approved archive merchant and MCC;
- `$12.00` negotiation ceiling, `$9.00` buyer target, three-round maximum;
- one-time archival-egress terms with no renewal, data sharing, or exclusivity.

Select **Run full recovery**.

## 0:50–1:25 — Discovery and bargaining

In local Monad mode, point to the x402 availability handshake and its `$0.01` simulated allocation.

In `x402-testnet` mode, show the real `0.01` test-USDC settlement, confirmed transaction hash, and Monad explorer link. The buyer's EIP-3009 authorization is gasless: the facilitator or other chain submitter needs MON for gas. Lazarus does not check or estimate that submitter's MON balance.

Open the deal transcript:

```text
Atlas asks       $12.00
Buyer offers      $9.00
Atlas counters   $10.50
Buyer offers      $9.75
Atlas accepts     $9.75
```

“The accepted quote is binding for 15 minutes. Its digest commits to the merchant, artifact, price, MCC, purpose, currency, expiry, and one-time terms. We save `$2.25`, or `18.75%`, before granting payment authority.”

## 1:25–1:50 — Monad market coordination

Show the `$5.00` demo bounty and the provider's `$2.00` simulated collateral requirement.

Say explicitly:

“The recovery bounty, provider claim, attestations, and 70/90/100 releases use the local Monad ledger in every current mode. The optional Monad testnet write is only the separate x402 discovery payment; it does not make the provider or bounty live.”

## 1:50–2:25 — Rain-controlled purchase

In local mode:

“The local Rain adapter mirrors the same bounded response shape. The `$9.75` is a simulated allocation and `$0.00` is charged.”

In `rain-sandbox` mode:

“The server uses the authenticated Rain sandbox to simulate rUSD collateral funding, create a scoped card, exercise authorization controls, and settle the approved authorization. Encrypted PAN and CVC data are discarded immediately.”

Rain sandbox is USD-only. Demonstrate EUR, GBP, CAD, or AUD with local Rain execution, or switch the mission back to USD before enabling the Rain sandbox.

Show two outcomes:

- an in-limit `$9.00` unrelated merchant/category attempt is declined and costs nothing;
- the accepted `$9.75` archive quote is simulated locally, or sandbox-settled only when explicitly presenting `rain-sandbox` mode.

Explain the enforcement split accurately:

“Lazarus policy binds the exact merchant, quote, purpose, one-use rule, and `$9.75` amount. The public Rain sandbox scoped-card fields enforce amount-with-buffer, MCC, and expiry. Rain's default 1.2× buffer can make the remote ceiling `$11.70`, so the exact quote remains an application-level invariant.”

For the USD script, mission policy usage is exactly `$9.76`: `$0.01` discovery plus `$9.75` archive access. In local x402 mode both are simulated accounting. In `x402-testnet` mode the discovery cent represents `0.01` test USDC actually settled onchain, while the `$9.75` archive purchase remains local unless Rain sandbox is independently enabled. The `$5.00` demo bounty is tracked separately and remains local.

## 2:25–3:15 — Recover and verify

Watch all 24 pieces move from missing to recovered to verified.

Show North and East verifiers pass, then compare the expected and reconstructed SHA-256 values.

“No provider is rewarded merely for promising a copy. The bytes must reconstruct to the declared root.”

## 3:15–3:40 — Reward and network effect

Show:

- `$3.50` released at the 70% recovery milestone;
- another `$1.00` at 90% availability;
- the final `$0.50` at 100% replication;
- seeders changing from zero to two.

In local mode, the card retires immediately. In Rain sandbox mode, Lazarus disables local authority and records `expiry_scheduled`; the remote card stays bounded by its short expiry because the public sandbox exposes no cancel endpoint.

## 3:40–4:00 — Close

“Rain models bounded access to the existing card ecosystem. Monad models the open recovery market and proof-conditioned rewards. The public Vercel demo keeps execution local and auditable. An access-controlled Node run can independently demonstrate a confirmed, capped test-USDC x402 discovery payment without pretending that the bounty, merchant, provider, verifiers, or reseeding are live.”

Closing line:

> Lazarus Mesh is an economic immune system for missing digital knowledge.
