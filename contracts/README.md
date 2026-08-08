# Lazarus Mesh recovery contracts

`RecoveryBountyRegistry.sol` is a reference Solidity escrow for a future EVM/Monad deployment. The running local hackathon app uses `src/services/monad-local.js`; this contract is not compiled, deployed, or invoked by the local runtime. It has received manual static review only, has no imported packages, and targets Solidity `^0.8.24`.

The contract holds one fixed ERC-20 reward token (normally a local mock USDC), accepts native-currency provider collateral, verifies allowlisted EOA signatures with an EIP-712 domain, and releases a mission reward in three tranches:

| Tranche | Share | On-chain release condition |
| --- | ---: | --- |
| Recovery | 70% | A verifier quorum signs matching recovery evidence. |
| Availability | 20% | Every configured availability epoch receives a matching quorum after its checkpoint time. |
| Replication | 10% | A matching replication quorum signs after the retention period. Any integer rounding remainder is included here. |

## Lifecycle

```text
Open --claim--> Claimed --beginVerification--> Verifying
  |                                             |
  | cancel/expire                               | recovery quorum
  v                                             v
Expired                                    Recovered
                                                |
                                                | beginRetention
                                                v
                                           Retaining
                                                |
                                                | availability + replication quorum
                                                v
                                           Completed

Claimed, Verifying, Recovered, or Retaining may enter Disputed before that phase's deadline.
Owner dispute resolution or permissionless expiry at the recorded dispute deadline may end in Expired.
```

All rewards are transferred into escrow during `createMission`. A provider must send exactly `collateralRequired` native currency to `claimMission`. Collateral is held until completion, timeout, or dispute resolution. Native payouts use a credit-and-withdraw pattern: the beneficiary calls `withdrawNativeCurrency(recipient)` after collateral is credited.

The timeout rule is intentionally deterministic for the demo: a provider that claims and then misses the verification or retention deadline has its collateral credited to the sponsor. An unclaimed mission has no collateral. The `RefundSponsor` dispute result returns collateral to the provider, while `SlashProvider` credits it to the sponsor. A dispute cannot outlive the deadline of the phase in which it opened: after `resolveBy`, anyone may expire it and refund the remaining reward to the sponsor. For stale manual disputes, collateral goes to the non-opening mission party; for an automatic failed-attestation dispute, it goes to the sponsor.

## Verifier attestations

The constructor takes at least two allowlisted verifier addresses. Each mission chooses a quorum of at least two and no more than the current verifier count. The owner can add or revoke verifiers for the hackathon deployment.

The typed data domain is:

```text
name:              Lazarus Recovery Bounty Registry
version:           1
chainId:           current chain ID
verifyingContract: deployed registry address
```

The exact EIP-712 type is exposed as `ATTESTATION_TYPEHASH` and is:

```text
RecoveryAttestation(
  uint256 missionId,
  address provider,
  uint8 stage,
  uint32 epoch,
  uint32 round,
  bytes32 challengeDigest,
  bytes32 contentRoot,
  uint256 reconstructedBytes,
  bool passed,
  uint64 observedAt,
  uint256 nonce,
  uint64 validUntil
)
```

Stage values are `0 = Recovery`, `1 = Availability`, and `2 = Replication`. Recovery and replication use epoch `0`; availability epochs are one-indexed and must be completed in order. Obtain the current `round` from `checkpointRound(missionId, stage, epoch)` and the verifier's exact nonce from `verifierNonces(verifier)` before signing. Signatures must be canonical 65-byte ECDSA signatures with `v` equal to 27 or 28 and low `s`.

`submitAttestations` accepts one evidence group per call. Every entry in that call must agree on all evidence fields; timestamps, expiry values, nonces, and signers may differ. Signatures can arrive across multiple calls. The contract prevents replay with all of the following:

- a monotonically increasing nonce per verifier;
- a consumed `(typed-data digest, recovered signer)` replay-key map;
- one vote per verifier per mission/stage/epoch/round;
- domain separation by chain ID and contract address.

A quorum of matching `passed = false` attestations automatically opens a dispute. If the owner resumes that mission, the checkpoint round increments so verifiers can sign fresh evidence without reusing old votes.

## Local deployment

1. Compile with a Solidity 0.8.24-compatible compiler. No remappings or dependency installation are needed.
2. Deploy a conventional local mock ERC-20 first. Fee-on-transfer and rebasing tokens are unsupported.
3. Deploy the registry with `(tokenAddress, ownerAddress, verifierAddresses)`. Supply at least two distinct nonzero verifier EOAs.
4. Mint reward tokens to the sponsor and approve the registry before calling `createMission`.
5. For a fast local demo, use short but valid values. `retentionPeriod` is measured in seconds and must be greater than `availabilityEpochsRequired`; `retentionGracePeriod` must be nonzero.
6. Read `domainSeparator()` and `hashAttestation(...)` when testing signer compatibility. Do not hard-code a domain from another deployment or chain.

Example constructor arguments:

```text
tokenAddress       = local MockUSDC address
ownerAddress       = local deployer address
verifierAddresses  = [verifierOne, verifierTwo, verifierThree]
```

The normal successful call sequence is:

```text
approve -> createMission -> claimMission -> beginVerification
-> submit recovery quorum -> beginRetention
-> submit each availability-epoch quorum
-> submit replication quorum -> withdrawNativeCurrency
```

## Operational behavior

- `pause` blocks new missions, claims, verification, retention, and attestations. Refunds, expiry, dispute handling, and native withdrawals remain available so the pause does not permanently trap exits.
- Anyone may call `expireMission` after the applicable deadline. This makes automation by a local keeper possible.
- Retention must start within `retentionGracePeriod` after recovery; opening or resuming a dispute cannot bypass a phase deadline.
- ERC-20 calls accept standard tokens that return `true` and older standard tokens that return no value. Mission creation checks that escrow received the exact requested amount.
- `totalEscrowedRewards`, `totalCollateralHeld`, and `totalNativeCredits` are exposed for local invariant checks.
- There is deliberately no owner sweep function. Mission assets cannot be withdrawn administratively.

## Limitations and audit warnings

This code is a practical hackathon implementation, **not audited production infrastructure**.

- The contract cannot observe BitTorrent, IPFS, cloud storage, seeder independence, or data correctness. It only verifies signatures from an owner-selected verifier set. Verifier collusion can release escrow fraudulently.
- The owner is a centralized arbitrator, pause authority, and verifier-list administrator. Use a multisig and delayed governance before any real-value deployment.
- Revoking verifiers can make an existing mission's quorum impossible to reach. Coordinate verifier changes around active missions.
- Only EOA ECDSA signatures are supported. EIP-1271 smart-contract signers and account-abstraction signature schemes are not implemented.
- There are no verifier bonds, conflict slashing, reputation weights, appeal delays, randomized on-chain assignment, or privacy guarantees.
- Timeout slashing is coarse and may punish a provider for network or verifier failure. Production rules need a full dispute window and objective evidence policy.
- Token decimals are not inspected. Reward amounts are raw token units, and a reward must be at least ten units. Outgoing fee-on-transfer behavior is not supported.
- A malicious or blocklisted ERC-20 can freeze transfers. Deploy only with a reviewed, fixed stablecoin contract.
- Availability checkpoints use block timestamps. Validators can influence timestamps slightly, so these checkpoints are not suitable for sub-minute economic security.
- Signed evidence and hashes are public. Never place secrets, card details, access tokens, personal data, or copyrighted payload bytes in calldata.
- Forced native currency (for example via a legacy self-destruct path) is not accounted as collateral and has no recovery mechanism.
- Gas use grows with the number of signatures in a submitted batch, though batches and verifier counts are bounded at 32.

Before production use, add comprehensive unit, invariant, fuzz, and fork tests; commission an independent security audit; formally specify the dispute/slashing policy; and review the complete off-chain verifier and signing pipeline.
