# Four-Minute Demo Script

## Before presenting

Choose one truthful run profile:

- **Public Production:** local Rain, local x402 buyer, seller disabled, no value moves.
- **Protected branch Preview:** local Rain plus one Privy-backed test-USDC x402 discovery payment through the co-located durable seller. The full bounty and archive purchase remain local.
- **Local Rain sandbox:** do not present yet. The prior key must be rotated and the collateral/contract value replaced with a valid provider-issued UUID.

For the protected Preview, verify before opening the app:

1. Vercel Deployment Protection is enabled.
2. Live variables exist only on the intended branch Preview.
3. The dedicated Privy payer has only the capped test USDC required.
4. The receive-only payee is a different wallet; no payee secret is deployed.
5. Price/cap are fixed at test USDC 0.01, authorization is at most five minutes, and confirmations are at least six.
6. Seller and Neon settlement storage are enabled; the state key is unique and begins with `preview-`.
7. Reset and new-mission creation return the one-shot denial.

Mission accounting supports USD, EUR, GBP, CAD, and AUD through fixed demo references, not live FX. Use USD for the timings below. x402 settlement remains test USDC regardless of the accounting currency.

## 0:00–0:25 — The problem

“This CC0 research dataset still has a valid cryptographic commitment but zero complete seeders. A content address proves identity; it does not guarantee availability.”

Show `DEAD`, zero seeders, and 24 missing pieces.

## 0:25–0:50 — Mission and authority

Show the USD reference envelope:

- 20.00 service budget;
- 5.00 local recovery bounty;
- public-domain rights evidence;
- one approved archive merchant/MCC;
- 12.00 negotiation ceiling, 9.00 buyer target, and three-round maximum; and
- one-time archival egress with no renewal, sharing, or exclusivity.

Select **Run full recovery**. On the protected Preview, use only the preloaded bundled mission.

## 0:50–1:25 — Discovery and bargaining

In Public Production, describe the x402 receipt as a local one-cent-reference simulation and say “no value moved.”

In the protected Preview, show the real 0.01 test-USDC settlement, payment ID, confirmed transaction hash, and explorer evidence. Explain:

“A dedicated Privy server wallet signed only the approved Monad-testnet USDC authorization. A different wallet received it. The protected seller settled through the facilitator and Neon prevents a duplicate payment ID from charging again.”

Open the separate local bargaining transcript:

```text
Atlas asks       $12.00
Buyer offers      $9.00
Atlas counters   $10.50
Buyer offers      $9.75
Atlas accepts     $9.75
```

“x402 paid for availability intelligence; it did not bargain. Atlas is a deterministic merchant model. The binding quote saves 2.25, or 18.75%, and commits to merchant, artifact, amount, purpose, terms, session, and expiry.”

## 1:25–1:50 — Monad boundary

Show the 5.00 demo bounty and 2.00 simulated collateral requirement.

Say explicitly:

“Only discovery can settle on Monad testnet today. The recovery bounty, provider claim, attestations, and 70/90/100 releases use the local ledger in every mode. Their hash-shaped receipts are not explorer transactions.”

## 1:50–2:25 — Controlled archive allocation

In the current deployment, Rain stays local:

“Lazarus creates one local card-like authority for the accepted 9.75 quote. The 9.00 unrelated merchant/category attempt is denied and costs nothing; only the exact Atlas allocation succeeds.”

For the USD run, policy usage is 9.76: 0.01 discovery plus 9.75 archive allocation. In Production both are simulated. In the protected Preview only the discovery cent settles in test USDC; the 9.75 archive allocation remains local.

If asked about Rain, answer:

“The sandbox adapter is implemented, but we have not armed it with the currently supplied values: the exposed key must be rotated and the collateral identifier must be replaced with a valid Rain-issued UUID. We do not guess credentials or present a failed configuration as live.”

## 2:25–3:15 — Recover and verify

Watch all 24 pieces move from missing to recovered to verified. Show two passing verifier roles and compare expected versus reconstructed SHA-256.

“The byte verification is real and local. Provider networking and verifier independence are still simulated.”

## 3:15–3:40 — Reward and network effect

Show:

- 3.50 released at the 70% milestone;
- 1.00 more at 90%;
- the final 0.50 at 100%; and
- seeders changing from zero to two.

State that reward release and seeders are local model state, not onchain bounty settlement or active seeding processes.

## 3:40–4:00 — Close

“Lazarus Mesh separates autonomy from authority. The agent discovers and bargains, deterministic policy decides, Privy can sign only a narrow testnet envelope, x402 makes paid discovery machine-native, and Rain is ready for bounded sandbox card testing once valid rotated credentials arrive. Public Production remains safe and local-only; the protected Preview proves one capped onchain discovery payment without pretending the whole market is live.”

Closing line:

> Lazarus Mesh is an economic immune system for missing digital knowledge.
