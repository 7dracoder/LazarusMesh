# Four-Minute Demo Script

## Before presenting

Choose and state the mode accurately:

- `ADAPTER_MODE=local`: every payment and chain action is local.
- `ADAPTER_MODE=rain-sandbox`: Rain calls the external sandbox; bargaining, Monad execution, and x402 execution remain local. Configured Monad RPC and facilitator checks are read-only.

In hybrid mode, confirm `/api/health` reports Rain authenticated before starting. Do not describe sandbox transactions as real money, and complete the mission before attempting a reset.

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

Point to the local x402 availability handshake and its `$0.01` receipt.

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

Show the `$5.00` bounty funded and the provider's `$2.00` collateral requirement.

Say explicitly:

“This release executes the bounty on the local Monad ledger. If the public RPC and x402 facilitator are configured, health checks verify Monad testnet chain 10143 and x402 v2 support, but they never sign or settle a transaction.”

## 1:50–2:25 — Rain-controlled purchase

In local mode:

“The local Rain adapter mirrors the same bounded response shape.”

In `rain-sandbox` mode:

“The server uses the authenticated Rain sandbox to simulate rUSD collateral funding, create a scoped card, exercise authorization controls, and settle the approved authorization. Encrypted PAN and CVC data are discarded immediately.”

Show two outcomes:

- an in-limit `$9.00` unrelated merchant/category attempt is declined and costs nothing;
- the accepted `$9.75` archive quote is authorized and settled.

Explain the enforcement split accurately:

“Lazarus policy binds the exact merchant, quote, purpose, one-use rule, and `$9.75` amount. The public Rain sandbox scoped-card fields enforce amount-with-buffer, MCC, and expiry. Rain's default 1.2× buffer can make the remote ceiling `$11.70`, so the exact quote remains an application-level invariant.”

The mission's counted spend is now exactly `$9.76`: `$0.01` discovery plus `$9.75` archive access. The `$5.00` bounty is tracked separately.

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

“Rain gives the agent bounded access to the existing card ecosystem. Monad models the open recovery market and proof-conditioned rewards. In this release Rain runs against its external sandbox, while Monad and x402 execution stay local and auditable. One requester pays, but everyone regains access to the data.”

Closing line:

> Lazarus Mesh is an economic immune system for missing digital knowledge.
