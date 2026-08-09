# Four-Minute Demo Script

## Before presenting

Choose one truthful run profile:

- **Remote merchant Production (recommended):** authenticated merchant bargaining and provider download; local Rain, local x402, local bounty, and no value or chain writes.
- **Local Production:** bundled 24-piece fixture and Atlas fallback; all operations local.
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

Before presenting the remote profile, open the [live Lazarus demo](https://lazarus-mesh-merchant-demo.vercel.app) and confirm that merchant health reports authenticated HTTPS, a pinned Ed25519 key, and a matching sponsor-pinned manifest. The separate [merchant operator console](https://lazarus-merchant.vercel.app) requires the private `OPERATOR_TOKEN` from that Vercel project's Production environment; never paste the server-to-server merchant API token into the browser. Core local accounting supports USD, EUR, GBP, CAD, and AUD through fixed demo references, not live FX. The deployed remote merchant accepts one configured currency at a time and is currently USD, so use USD for the timings below.

## 0:00–0:25 — The problem

“This CC0 research dataset still has a valid cryptographic commitment but zero complete seeders. A content address proves identity; it does not guarantee availability.”

Show `DEAD`, zero seeders, and eight missing pieces in the remote profile (`24` in local mode).

## 0:25–0:50 — Mission and authority

Show the USD reference envelope:

- 20.00 service budget;
- 5.00 local recovery bounty;
- public-domain rights evidence;
- one approved archive merchant/MCC;
- 12.00 negotiation ceiling, 9.00 buyer target, and three-round maximum; and
- one-time archival egress with no renewal, sharing, or exclusivity.

Select **Run full recovery**. On the protected x402 Preview, use only the preloaded bundled mission. Do not combine that one-shot payment profile with remote merchant mode.

## 0:50–1:25 — Discovery and bargaining

In remote merchant Production, describe x402 as a local one-cent-reference simulation and say “no value moved.” Then open the separate merchant console and show that Lazarus created a real authenticated negotiation session.

In the protected Preview, show the real 0.01 test-USDC settlement, payment ID, confirmed transaction hash, and explorer evidence. Explain:

“A dedicated Privy server wallet signed only the approved Monad-testnet USDC authorization. A different wallet received it. The protected seller settled through the facilitator and Neon prevents a duplicate payment ID from charging again.”

For the remote merchant profile, show the two-round transcript in both Lazarus and the merchant console:

```text
Merchant asks    $12.00
Buyer offers      $9.00
Merchant counters $10.50
Buyer offers      $9.75
Merchant accepts  $9.75
```

“The independently deployed merchant bargained over authenticated HTTPS. Lazarus pinned its Ed25519 key, recomputed the canonical quote digest, and verified the signed 9.75 binding quote before policy accepted it. The result saves 2.25, or 18.75%.”

Point out the console boundary: Lazarus includes the proposed bounty in the offer message, but the merchant currently does not persist it. The console therefore shows the negotiation session, counters, signed quote, and audit events but no bounty field. The provider reward is not the same thing as the merchant's 9.75 archive quote.

## 1:25–1:50 — Monad boundary

Show the 5.00 demo bounty and 2.00 simulated collateral requirement.

Say explicitly:

“This remote-merchant run makes no Monad transaction. The offer message includes proposed bounty context, but the recovery bounty, provider claim, attestations, and 70/90/100 releases use the local ledger. Their hash-shaped receipts are not explorer transactions, and the merchant console does not persist or display them.”

## 1:50–2:25 — Controlled archive allocation

In the current deployment, Rain stays local:

“Lazarus creates one local card-like authority for the signed 9.75 quote. The 9.00 unrelated merchant/category attempt is denied and costs nothing; only the exact quoted allocation succeeds. The merchant is not actually charged or paid.”

For the USD run, policy usage is 9.76: 0.01 discovery plus 9.75 archive allocation. In remote merchant Production both are simulated accounting, so the verified end-to-end run charged `$0.00` and made no chain write. In the separate protected x402 Preview only the discovery cent settles in test USDC; the 9.75 archive allocation remains local.

If asked about Rain, answer:

“The sandbox adapter is implemented, but we have not armed it with the currently supplied values: the exposed key must be rotated and the collateral identifier must be replaced with a valid Rain-issued UUID. We do not guess credentials or present a failed configuration as live.”

## 2:25–3:15 — Recover and verify

Watch all `8/8` remote pieces move from missing to recovered to verified. Show the pinned provider manifest, piece hashes, reconstructed SHA-256, and root match. Local fallback uses `24/24` pieces.

“The provider networking and byte transfer are real HTTPS operations. Lazarus bounds every response and verifies the live manifest against the sponsor-pinned copy, every piece hash, the total size, and the reconstructed artifact. The verifier roles themselves remain scripted and local.”

## 3:15–3:40 — Reward and network effect

Show:

- 3.50 released at the 70% milestone;
- 1.00 more at 90%;
- the final 0.50 at 100%; and
- seeders changing from zero to two.

State that reward release and seeders are local model state, not onchain bounty settlement or active seeding processes.

## 3:40–4:00 — Close

“Lazarus Mesh separates autonomy from authority. The buyer bargains with a real merchant API, verifies its signed quote, and retrieves a sponsor-pinned artifact from the provider. Deterministic policy still decides what may happen. The remote run charges nothing; Privy/x402 testnet settlement is isolated to a different protected profile, and Rain stays unarmed until valid rotated credentials arrive.”

Closing line:

> Lazarus Mesh is an economic immune system for missing digital knowledge.
