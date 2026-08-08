// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface used by the registry.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title RecoveryBountyRegistry
/// @notice Dependency-free hackathon escrow for cryptoeconomically verified data recovery.
/// @dev Verifiers are owner-managed EOAs. Availability is attested off-chain and is not a trustless fact.
contract RecoveryBountyRegistry {
    enum MissionStatus {
        Open,
        Claimed,
        Verifying,
        Recovered,
        Retaining,
        Completed,
        Expired,
        Disputed
    }

    enum AttestationStage {
        Recovery,
        Availability,
        Replication
    }

    enum RewardTranche {
        Recovery,
        Availability,
        Replication
    }

    enum DisputeResolution {
        Resume,
        RefundSponsor,
        AwardProvider,
        SlashProvider
    }

    enum ExpiryReason {
        SponsorCancelled,
        UnclaimedDeadline,
        VerificationDeadline,
        RetentionNotStarted,
        RetentionDeadline,
        DisputeRefund,
        StaleDispute,
        ProviderSlashed
    }

    struct CreateMissionParams {
        bytes32 contentRoot;
        bytes32 manifestHash;
        uint128 reward;
        uint128 collateralRequired;
        uint64 claimDeadline;
        uint64 verificationDeadline;
        uint64 retentionPeriod;
        uint64 retentionGracePeriod;
        uint32 pieceCount;
        uint16 requiredQuorum;
        uint16 availabilityEpochsRequired;
    }

    struct Mission {
        address sponsor;
        address provider;
        bytes32 contentRoot;
        bytes32 manifestHash;
        uint128 reward;
        uint128 remainingReward;
        uint128 collateralRequired;
        uint128 collateralHeld;
        uint64 claimDeadline;
        uint64 verificationDeadline;
        uint64 retentionPeriod;
        uint64 retentionGracePeriod;
        uint64 claimedAt;
        uint64 recoveredAt;
        uint64 retentionStartedAt;
        uint64 retentionEndsAt;
        uint32 pieceCount;
        uint16 requiredQuorum;
        uint16 availabilityEpochsRequired;
        uint16 passedAvailabilityEpochs;
        MissionStatus status;
        bool availabilityPaid;
    }

    /// @dev The EIP-712 field order must match ATTESTATION_TYPEHASH exactly.
    struct RecoveryAttestation {
        uint256 missionId;
        address provider;
        AttestationStage stage;
        uint32 epoch;
        uint32 round;
        bytes32 challengeDigest;
        bytes32 contentRoot;
        uint256 reconstructedBytes;
        bool passed;
        uint64 observedAt;
        uint256 nonce;
        uint64 validUntil;
    }

    struct DisputeRecord {
        MissionStatus previousStatus;
        address openedBy;
        bytes32 reasonHash;
        AttestationStage stage;
        uint32 epoch;
        uint32 round;
        uint256 resolveBy;
        bool automatic;
    }

    error Unauthorized();
    error ZeroAddress();
    error InvalidToken();
    error InvalidParameters();
    error InvalidQuorum(uint256 requested, uint256 available);
    error MissionNotFound(uint256 missionId);
    error InvalidMissionStatus(uint256 missionId, MissionStatus current);
    error NotSponsor(uint256 missionId);
    error NotProvider(uint256 missionId);
    error NotMissionParty(uint256 missionId);
    error DeadlinePassed(uint256 deadline);
    error DeadlineNotReached(uint256 deadline);
    error IncorrectCollateral(uint256 expected, uint256 received);
    error ContractPaused();
    error ContractNotPaused();
    error ReentrantCall();
    error ArrayLengthMismatch();
    error TooManyAttestations(uint256 supplied);
    error MixedEvidence();
    error InvalidAttestation();
    error InvalidSignature();
    error UnauthorizedVerifier(address verifier);
    error InvalidNonce(address verifier, uint256 expected, uint256 supplied);
    error AttestationAlreadyUsed(bytes32 digest);
    error VerifierAlreadyAttested(address verifier);
    error CheckpointAlreadyFinalized();
    error CheckpointNotReady(uint256 readyAt);
    error TokenOperationFailed();
    error NativeTransferFailed();
    error NothingToWithdraw();
    error DuplicateVerifier(address verifier);
    error VerifierLimitReached();
    error VerifierCountTooLow();
    error NoStateChange();
    error DisputeReasonRequired();
    error UnexpectedNativeCurrency();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event VerifierUpdated(address indexed verifier, bool approved);
    event MissionCreated(
        uint256 indexed missionId,
        address indexed sponsor,
        bytes32 indexed contentRoot,
        bytes32 manifestHash,
        uint256 reward,
        uint256 collateralRequired,
        uint64 claimDeadline,
        uint64 verificationDeadline,
        uint16 requiredQuorum
    );
    event MissionStatusChanged(
        uint256 indexed missionId,
        MissionStatus previousStatus,
        MissionStatus newStatus
    );
    event MissionClaimed(uint256 indexed missionId, address indexed provider, uint256 collateral);
    event VerificationStarted(uint256 indexed missionId, bytes32 indexed challengeDigest);
    event AttestationAccepted(
        uint256 indexed missionId,
        address indexed verifier,
        AttestationStage indexed stage,
        uint32 epoch,
        uint32 round,
        bytes32 evidenceId,
        bool passed,
        uint256 nonce
    );
    event QuorumReached(
        uint256 indexed missionId,
        AttestationStage indexed stage,
        uint32 indexed epoch,
        uint32 round,
        bytes32 evidenceId,
        bool passed,
        uint16 votes
    );
    event RewardReleased(
        uint256 indexed missionId,
        address indexed provider,
        RewardTranche indexed tranche,
        uint256 amount
    );
    event RecoveryFinalized(uint256 indexed missionId, uint64 recoveredAt);
    event RetentionStarted(uint256 indexed missionId, uint64 startedAt, uint64 endsAt);
    event AvailabilityEpochVerified(uint256 indexed missionId, uint32 indexed epoch, uint16 passedEpochs);
    event MissionCompleted(uint256 indexed missionId, address indexed provider);
    event MissionCancelled(uint256 indexed missionId, address indexed sponsor, uint256 refund);
    event MissionExpired(
        uint256 indexed missionId,
        ExpiryReason indexed reason,
        uint256 sponsorRefund,
        uint256 collateralCredited
    );
    event DisputeOpened(
        uint256 indexed missionId,
        address indexed openedBy,
        bytes32 indexed reasonHash,
        bool automatic,
        uint256 resolveBy
    );
    event DisputeResolved(uint256 indexed missionId, DisputeResolution indexed resolution);
    event CollateralCredited(uint256 indexed missionId, address indexed recipient, uint256 amount);
    event NativeCurrencyWithdrawn(address indexed account, address indexed recipient, uint256 amount);

    string public constant NAME = "Lazarus Recovery Bounty Registry";
    string public constant VERSION = "1";

    uint16 public constant BASIS_POINTS = 10_000;
    uint16 public constant RECOVERY_BPS = 7_000;
    uint16 public constant AVAILABILITY_BPS = 2_000;
    uint16 public constant REPLICATION_BPS = 1_000;
    uint16 public constant MIN_QUORUM = 2;
    uint16 public constant MAX_VERIFIERS = 32;
    uint16 public constant MAX_AVAILABILITY_EPOCHS = 16;
    uint16 public constant MAX_ATTESTATIONS_PER_CALL = 32;
    uint64 public constant MAX_RETENTION_PERIOD = 365 days;
    uint64 public constant MAX_RETENTION_GRACE_PERIOD = 30 days;
    uint64 public constant MAX_CLOCK_SKEW = 5 minutes;

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "RecoveryAttestation(uint256 missionId,address provider,uint8 stage,uint32 epoch,uint32 round,bytes32 challengeDigest,bytes32 contentRoot,uint256 reconstructedBytes,bool passed,uint64 observedAt,uint256 nonce,uint64 validUntil)"
    );

    bytes32 private constant _HASHED_NAME = keccak256("Lazarus Recovery Bounty Registry");
    bytes32 private constant _HASHED_VERSION = keccak256("1");
    uint256 private constant _SECP256K1N_DIV_2 =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IERC20 public immutable rewardToken;
    address public owner;
    bool public paused;
    uint16 public verifierCount;
    uint256 public nextMissionId = 1;
    uint256 public totalEscrowedRewards;
    uint256 public totalCollateralHeld;
    uint256 public totalNativeCredits;

    mapping(address => bool) public isVerifier;
    mapping(address => uint256) public verifierNonces;
    mapping(address => uint256) public nativeCredits;
    mapping(bytes32 => bool) public consumedAttestation;
    mapping(bytes32 => uint16) public attestationVotes;
    mapping(uint256 => bytes32) public recoveryChallengeDigest;

    // mission => stage => epoch => current round
    mapping(uint256 => mapping(uint8 => mapping(uint32 => uint32))) public checkpointRound;
    // mission => stage => epoch => round => finalized
    mapping(uint256 => mapping(uint8 => mapping(uint32 => mapping(uint32 => bool))))
        public checkpointFinalized;
    // mission => stage => epoch => round => winning evidence id
    mapping(uint256 => mapping(uint8 => mapping(uint32 => mapping(uint32 => bytes32))))
        public checkpointEvidence;
    // mission => stage => epoch => round => verifier => submitted
    mapping(uint256 => mapping(uint8 => mapping(uint32 => mapping(uint32 => mapping(address => bool)))))
        public hasAttested;

    mapping(uint256 => Mission) private _missions;
    mapping(uint256 => DisputeRecord) private _disputes;

    uint256 private _reentrancyState = 1;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyState != 1) revert ReentrantCall();
        _reentrancyState = 2;
        _;
        _reentrancyState = 1;
    }

    constructor(address token, address initialOwner, address[] memory initialVerifiers) {
        if (token == address(0) || initialOwner == address(0)) revert ZeroAddress();
        if (token.code.length == 0) revert InvalidToken();
        if (initialVerifiers.length < MIN_QUORUM || initialVerifiers.length > MAX_VERIFIERS) {
            revert InvalidQuorum(initialVerifiers.length, MAX_VERIFIERS);
        }

        rewardToken = IERC20(token);
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);

        for (uint256 i = 0; i < initialVerifiers.length; ++i) {
            address verifier = initialVerifiers[i];
            if (verifier == address(0)) revert ZeroAddress();
            if (isVerifier[verifier]) revert DuplicateVerifier(verifier);
            isVerifier[verifier] = true;
            emit VerifierUpdated(verifier, true);
        }
        verifierCount = uint16(initialVerifiers.length);
    }

    receive() external payable {
        revert UnexpectedNativeCurrency();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function pause() external onlyOwner {
        if (paused) revert NoStateChange();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert ContractNotPaused();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setVerifier(address verifier, bool approved) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        if (isVerifier[verifier] == approved) revert NoStateChange();

        if (approved) {
            if (verifierCount >= MAX_VERIFIERS) revert VerifierLimitReached();
            isVerifier[verifier] = true;
            ++verifierCount;
        } else {
            if (verifierCount <= MIN_QUORUM) revert VerifierCountTooLow();
            isVerifier[verifier] = false;
            --verifierCount;
        }

        emit VerifierUpdated(verifier, approved);
    }

    function createMission(CreateMissionParams calldata params)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 missionId)
    {
        _validateCreateParams(params);

        missionId = nextMissionId++;
        Mission storage mission = _missions[missionId];
        mission.sponsor = msg.sender;
        mission.contentRoot = params.contentRoot;
        mission.manifestHash = params.manifestHash;
        mission.reward = params.reward;
        mission.remainingReward = params.reward;
        mission.collateralRequired = params.collateralRequired;
        mission.claimDeadline = params.claimDeadline;
        mission.verificationDeadline = params.verificationDeadline;
        mission.retentionPeriod = params.retentionPeriod;
        mission.retentionGracePeriod = params.retentionGracePeriod;
        mission.pieceCount = params.pieceCount;
        mission.requiredQuorum = params.requiredQuorum;
        mission.availabilityEpochsRequired = params.availabilityEpochsRequired;
        mission.status = MissionStatus.Open;

        totalEscrowedRewards += params.reward;

        uint256 balanceBefore = _tokenBalance();
        _safeTransferFrom(msg.sender, address(this), params.reward);
        uint256 balanceAfter = _tokenBalance();
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != params.reward) {
            revert InvalidToken();
        }

        emit MissionCreated(
            missionId,
            msg.sender,
            params.contentRoot,
            params.manifestHash,
            params.reward,
            params.collateralRequired,
            params.claimDeadline,
            params.verificationDeadline,
            params.requiredQuorum
        );
    }

    function claimMission(uint256 missionId) external payable whenNotPaused {
        Mission storage mission = _getMission(missionId);
        _requireStatus(missionId, mission, MissionStatus.Open);
        if (block.timestamp >= mission.claimDeadline) revert DeadlinePassed(mission.claimDeadline);
        if (msg.value != mission.collateralRequired) {
            revert IncorrectCollateral(mission.collateralRequired, msg.value);
        }

        mission.provider = msg.sender;
        mission.collateralHeld = uint128(msg.value);
        mission.claimedAt = _timestamp64();
        totalCollateralHeld += msg.value;
        _setStatus(missionId, mission, MissionStatus.Claimed);

        emit MissionClaimed(missionId, msg.sender, msg.value);
    }

    function beginVerification(uint256 missionId, bytes32 challengeDigest) external whenNotPaused {
        if (challengeDigest == bytes32(0)) revert InvalidParameters();
        Mission storage mission = _getMission(missionId);
        _requireStatus(missionId, mission, MissionStatus.Claimed);
        if (msg.sender != mission.provider) revert NotProvider(missionId);
        if (block.timestamp >= mission.verificationDeadline) {
            revert DeadlinePassed(mission.verificationDeadline);
        }

        recoveryChallengeDigest[missionId] = challengeDigest;
        _setStatus(missionId, mission, MissionStatus.Verifying);
        emit VerificationStarted(missionId, challengeDigest);
    }

    /// @notice Submit one quorum candidate. Every item must describe identical evidence.
    /// @dev A batch may contain fewer than quorum signatures; later batches can add votes.
    function submitAttestations(
        uint256 missionId,
        RecoveryAttestation[] calldata attestations,
        bytes[] calldata signatures
    ) external whenNotPaused nonReentrant {
        uint256 length = attestations.length;
        if (length == 0 || length > MAX_ATTESTATIONS_PER_CALL) {
            revert TooManyAttestations(length);
        }
        if (length != signatures.length) revert ArrayLengthMismatch();

        Mission storage mission = _getMission(missionId);
        RecoveryAttestation calldata first = attestations[0];
        _validateAttestation(missionId, mission, first);

        if (
            checkpointFinalized[missionId][uint8(first.stage)][first.epoch][first.round]
        ) {
            revert CheckpointAlreadyFinalized();
        }

        bytes32 evidenceId = _evidenceId(first);
        for (uint256 i = 0; i < length; ++i) {
            _recordAttestation(
                missionId,
                mission,
                attestations[i],
                signatures[i],
                evidenceId
            );
        }

        uint16 votes = attestationVotes[evidenceId];
        if (votes >= mission.requiredQuorum) {
            checkpointFinalized[missionId][uint8(first.stage)][first.epoch][first.round] = true;
            checkpointEvidence[missionId][uint8(first.stage)][first.epoch][first.round] = evidenceId;
            emit QuorumReached(
                missionId,
                first.stage,
                first.epoch,
                first.round,
                evidenceId,
                first.passed,
                votes
            );
            _applyQuorum(missionId, mission, first, evidenceId);
        }
    }

    function _recordAttestation(
        uint256 missionId,
        Mission storage mission,
        RecoveryAttestation calldata attestation,
        bytes calldata signature,
        bytes32 expectedEvidence
    ) internal {
        _validateAttestation(missionId, mission, attestation);
        if (_evidenceId(attestation) != expectedEvidence) revert MixedEvidence();

        bytes32 digest = hashAttestation(attestation);
        address verifier = _recoverSigner(digest, signature);
        if (!isVerifier[verifier]) revert UnauthorizedVerifier(verifier);

        // Different verifiers normally sign the same typed digest. Replay consumption
        // is therefore keyed by both the digest and recovered signer.
        bytes32 replayKey = keccak256(abi.encode(digest, verifier));
        if (consumedAttestation[replayKey]) revert AttestationAlreadyUsed(replayKey);

        uint256 expectedNonce = verifierNonces[verifier];
        if (attestation.nonce != expectedNonce) {
            revert InvalidNonce(verifier, expectedNonce, attestation.nonce);
        }
        if (
            hasAttested[missionId][uint8(attestation.stage)][attestation.epoch][attestation.round][
                verifier
            ]
        ) {
            revert VerifierAlreadyAttested(verifier);
        }

        consumedAttestation[replayKey] = true;
        verifierNonces[verifier] = expectedNonce + 1;
        hasAttested[missionId][uint8(attestation.stage)][attestation.epoch][attestation.round][
            verifier
        ] = true;
        ++attestationVotes[expectedEvidence];

        emit AttestationAccepted(
            missionId,
            verifier,
            attestation.stage,
            attestation.epoch,
            attestation.round,
            expectedEvidence,
            attestation.passed,
            attestation.nonce
        );
    }

    function beginRetention(uint256 missionId) external whenNotPaused {
        Mission storage mission = _getMission(missionId);
        _requireStatus(missionId, mission, MissionStatus.Recovered);
        if (msg.sender != mission.provider && msg.sender != mission.sponsor) {
            revert NotMissionParty(missionId);
        }
        uint256 startDeadline = uint256(mission.recoveredAt) + mission.retentionGracePeriod;
        if (block.timestamp >= startDeadline) revert DeadlinePassed(startDeadline);

        uint64 startedAt = _timestamp64();
        uint256 endsAt = uint256(startedAt) + mission.retentionPeriod;
        if (endsAt > type(uint64).max) revert InvalidParameters();
        mission.retentionStartedAt = startedAt;
        mission.retentionEndsAt = uint64(endsAt);
        _setStatus(missionId, mission, MissionStatus.Retaining);
        emit RetentionStarted(missionId, startedAt, uint64(endsAt));
    }

    /// @notice Refund an Open mission. Open missions have no provider or collateral.
    function cancelUnclaimedMission(uint256 missionId) external nonReentrant {
        Mission storage mission = _getMission(missionId);
        _requireStatus(missionId, mission, MissionStatus.Open);
        if (msg.sender != mission.sponsor) revert NotSponsor(missionId);

        uint256 refund = _takeRemainingReward(mission);
        _setStatus(missionId, mission, MissionStatus.Expired);
        emit MissionCancelled(missionId, mission.sponsor, refund);
        emit MissionExpired(missionId, ExpiryReason.SponsorCancelled, refund, 0);
        _safeTransfer(mission.sponsor, refund);
    }

    /// @notice Close a timed-out mission. Anyone may call after the applicable deadline.
    /// @dev Regular provider timeouts credit collateral to the sponsor. For a stale
    /// manual dispute, the non-opening mission party receives it; failed-attestation
    /// disputes credit it to the sponsor.
    function expireMission(uint256 missionId) external nonReentrant {
        Mission storage mission = _getMission(missionId);
        ExpiryReason reason;
        address collateralRecipient = mission.sponsor;

        if (mission.status == MissionStatus.Open) {
            if (block.timestamp < mission.claimDeadline) {
                revert DeadlineNotReached(mission.claimDeadline);
            }
            reason = ExpiryReason.UnclaimedDeadline;
        } else if (
            mission.status == MissionStatus.Claimed || mission.status == MissionStatus.Verifying
        ) {
            if (block.timestamp < mission.verificationDeadline) {
                revert DeadlineNotReached(mission.verificationDeadline);
            }
            reason = ExpiryReason.VerificationDeadline;
        } else if (mission.status == MissionStatus.Recovered) {
            uint256 startDeadline = uint256(mission.recoveredAt) + mission.retentionGracePeriod;
            if (block.timestamp < startDeadline) revert DeadlineNotReached(startDeadline);
            reason = ExpiryReason.RetentionNotStarted;
        } else if (mission.status == MissionStatus.Retaining) {
            uint256 retentionDeadline = _retentionDeadline(mission);
            if (block.timestamp < retentionDeadline) revert DeadlineNotReached(retentionDeadline);
            reason = ExpiryReason.RetentionDeadline;
        } else if (mission.status == MissionStatus.Disputed) {
            DisputeRecord memory dispute = _disputes[missionId];
            if (block.timestamp < dispute.resolveBy) revert DeadlineNotReached(dispute.resolveBy);
            reason = ExpiryReason.StaleDispute;
            collateralRecipient = dispute.automatic || dispute.openedBy == mission.provider
                ? mission.sponsor
                : mission.provider;
            delete _disputes[missionId];
        } else {
            revert InvalidMissionStatus(missionId, mission.status);
        }

        uint256 refund = _takeRemainingReward(mission);
        uint256 collateral = _creditCollateral(missionId, mission, collateralRecipient);
        _setStatus(missionId, mission, MissionStatus.Expired);
        emit MissionExpired(missionId, reason, refund, collateral);
        _safeTransfer(mission.sponsor, refund);
    }

    function openDispute(uint256 missionId, bytes32 reasonHash) external {
        if (reasonHash == bytes32(0)) revert DisputeReasonRequired();
        Mission storage mission = _getMission(missionId);
        if (msg.sender != mission.sponsor && msg.sender != mission.provider) {
            revert NotMissionParty(missionId);
        }
        if (
            mission.status != MissionStatus.Claimed &&
            mission.status != MissionStatus.Verifying &&
            mission.status != MissionStatus.Recovered &&
            mission.status != MissionStatus.Retaining
        ) {
            revert InvalidMissionStatus(missionId, mission.status);
        }

        uint256 resolveBy = _disputeDeadline(mission);
        if (block.timestamp >= resolveBy) revert DeadlinePassed(resolveBy);

        _disputes[missionId] = DisputeRecord({
            previousStatus: mission.status,
            openedBy: msg.sender,
            reasonHash: reasonHash,
            stage: AttestationStage.Recovery,
            epoch: 0,
            round: 0,
            resolveBy: resolveBy,
            automatic: false
        });
        _setStatus(missionId, mission, MissionStatus.Disputed);
        emit DisputeOpened(missionId, msg.sender, reasonHash, false, resolveBy);
    }

    /// @notice Owner arbitration for the local/hackathon deployment.
    function resolveDispute(uint256 missionId, DisputeResolution resolution)
        external
        onlyOwner
        nonReentrant
    {
        Mission storage mission = _getMission(missionId);
        _requireStatus(missionId, mission, MissionStatus.Disputed);
        DisputeRecord memory dispute = _disputes[missionId];

        if (resolution == DisputeResolution.Resume) {
            if (block.timestamp >= dispute.resolveBy) revert DeadlinePassed(dispute.resolveBy);
            if (dispute.automatic) {
                uint8 stage = uint8(dispute.stage);
                uint32 currentRound = checkpointRound[missionId][stage][dispute.epoch];
                if (currentRound != dispute.round || currentRound == type(uint32).max) {
                    revert InvalidParameters();
                }
                checkpointRound[missionId][stage][dispute.epoch] = currentRound + 1;
            }
            delete _disputes[missionId];
            _setStatus(missionId, mission, dispute.previousStatus);
            emit DisputeResolved(missionId, resolution);
            return;
        }

        uint256 reward = _takeRemainingReward(mission);
        uint256 collateral;
        address rewardRecipient;

        if (resolution == DisputeResolution.AwardProvider) {
            rewardRecipient = mission.provider;
            collateral = _creditCollateral(missionId, mission, mission.provider);
            _setStatus(missionId, mission, MissionStatus.Completed);
            emit MissionCompleted(missionId, mission.provider);
        } else {
            rewardRecipient = mission.sponsor;
            if (resolution == DisputeResolution.RefundSponsor) {
                collateral = _creditCollateral(missionId, mission, mission.provider);
                _setStatus(missionId, mission, MissionStatus.Expired);
                emit MissionExpired(missionId, ExpiryReason.DisputeRefund, reward, collateral);
            } else {
                collateral = _creditCollateral(missionId, mission, mission.sponsor);
                _setStatus(missionId, mission, MissionStatus.Expired);
                emit MissionExpired(missionId, ExpiryReason.ProviderSlashed, reward, collateral);
            }
        }

        delete _disputes[missionId];
        emit DisputeResolved(missionId, resolution);
        _safeTransfer(rewardRecipient, reward);
    }

    /// @notice Withdraw credited native collateral without coupling payout to mission finalization.
    function withdrawNativeCurrency(address payable recipient) external nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amount = nativeCredits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        nativeCredits[msg.sender] = 0;
        totalNativeCredits -= amount;
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) revert NativeTransferFailed();
        emit NativeCurrencyWithdrawn(msg.sender, recipient, amount);
    }

    function getMission(uint256 missionId) external view returns (Mission memory) {
        Mission storage mission = _getMission(missionId);
        return mission;
    }

    function getDispute(uint256 missionId) external view returns (DisputeRecord memory) {
        _getMission(missionId);
        return _disputes[missionId];
    }

    function missionCount() external view returns (uint256) {
        return nextMissionId - 1;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, _HASHED_NAME, _HASHED_VERSION, block.chainid, address(this))
        );
    }

    function hashAttestation(RecoveryAttestation calldata attestation)
        public
        view
        returns (bytes32)
    {
        // Every member is a static ABI type, so encoding the tuple inline is identical
        // to encoding each member after the type hash and avoids legacy stack pressure.
        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, attestation));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function evidenceId(RecoveryAttestation calldata attestation) external pure returns (bytes32) {
        return _evidenceId(attestation);
    }

    function availabilityCheckpointAt(uint256 missionId, uint32 epoch)
        public
        view
        returns (uint64)
    {
        Mission storage mission = _getMission(missionId);
        if (
            mission.retentionStartedAt == 0 ||
            epoch == 0 ||
            epoch > mission.availabilityEpochsRequired
        ) {
            revert InvalidParameters();
        }

        uint256 checkpoint = uint256(mission.retentionStartedAt) +
            (uint256(mission.retentionPeriod) * epoch) /
            (uint256(mission.availabilityEpochsRequired) + 1);
        return uint64(checkpoint);
    }

    function trancheAmounts(uint256 missionId)
        external
        view
        returns (uint256 recovery, uint256 availability, uint256 replication)
    {
        Mission storage mission = _getMission(missionId);
        recovery = (uint256(mission.reward) * RECOVERY_BPS) / BASIS_POINTS;
        availability = (uint256(mission.reward) * AVAILABILITY_BPS) / BASIS_POINTS;
        replication = uint256(mission.reward) - recovery - availability;
    }

    function _validateCreateParams(CreateMissionParams calldata params) internal view {
        if (
            params.contentRoot == bytes32(0) ||
            params.manifestHash == bytes32(0) ||
            params.reward < 10 ||
            params.collateralRequired == 0 ||
            params.pieceCount == 0 ||
            params.claimDeadline <= block.timestamp ||
            params.verificationDeadline <= params.claimDeadline ||
            params.retentionPeriod == 0 ||
            params.retentionPeriod > MAX_RETENTION_PERIOD ||
            params.retentionGracePeriod == 0 ||
            params.retentionGracePeriod > MAX_RETENTION_GRACE_PERIOD ||
            params.availabilityEpochsRequired == 0 ||
            params.availabilityEpochsRequired > MAX_AVAILABILITY_EPOCHS ||
            params.retentionPeriod <= params.availabilityEpochsRequired
        ) {
            revert InvalidParameters();
        }
        if (
            params.requiredQuorum < MIN_QUORUM ||
            params.requiredQuorum > verifierCount ||
            params.requiredQuorum > MAX_VERIFIERS
        ) {
            revert InvalidQuorum(params.requiredQuorum, verifierCount);
        }
    }

    function _validateAttestation(
        uint256 missionId,
        Mission storage mission,
        RecoveryAttestation calldata attestation
    ) internal view {
        if (
            attestation.missionId != missionId ||
            attestation.provider != mission.provider ||
            attestation.contentRoot != mission.contentRoot ||
            attestation.challengeDigest == bytes32(0) ||
            attestation.reconstructedBytes == 0 ||
            attestation.validUntil < block.timestamp ||
            attestation.validUntil < attestation.observedAt ||
            uint256(attestation.observedAt) > block.timestamp + MAX_CLOCK_SKEW
        ) {
            revert InvalidAttestation();
        }

        uint8 stage = uint8(attestation.stage);
        if (attestation.round != checkpointRound[missionId][stage][attestation.epoch]) {
            revert InvalidAttestation();
        }

        if (attestation.stage == AttestationStage.Recovery) {
            _requireStatus(missionId, mission, MissionStatus.Verifying);
            if (
                attestation.epoch != 0 ||
                attestation.challengeDigest != recoveryChallengeDigest[missionId] ||
                attestation.observedAt < mission.claimedAt
            ) {
                revert InvalidAttestation();
            }
            if (block.timestamp >= mission.verificationDeadline) {
                revert DeadlinePassed(mission.verificationDeadline);
            }
        } else if (attestation.stage == AttestationStage.Availability) {
            _requireStatus(missionId, mission, MissionStatus.Retaining);
            if (
                attestation.epoch == 0 ||
                attestation.epoch > mission.availabilityEpochsRequired ||
                attestation.epoch != uint32(mission.passedAvailabilityEpochs) + 1
            ) {
                revert InvalidAttestation();
            }
            uint256 checkpoint = availabilityCheckpointAt(missionId, attestation.epoch);
            if (block.timestamp < checkpoint) revert CheckpointNotReady(checkpoint);
            if (attestation.observedAt < checkpoint) revert InvalidAttestation();
            uint256 deadline = _retentionDeadline(mission);
            if (block.timestamp >= deadline) revert DeadlinePassed(deadline);
        } else {
            _requireStatus(missionId, mission, MissionStatus.Retaining);
            if (
                attestation.epoch != 0 ||
                !mission.availabilityPaid ||
                block.timestamp < mission.retentionEndsAt ||
                attestation.observedAt < mission.retentionEndsAt
            ) {
                revert InvalidAttestation();
            }
            uint256 deadline = _retentionDeadline(mission);
            if (block.timestamp >= deadline) revert DeadlinePassed(deadline);
        }
    }

    function _applyQuorum(
        uint256 missionId,
        Mission storage mission,
        RecoveryAttestation calldata attestation,
        bytes32 evidence
    ) internal {
        if (!attestation.passed) {
            uint256 resolveBy = _disputeDeadline(mission);
            _disputes[missionId] = DisputeRecord({
                previousStatus: mission.status,
                openedBy: msg.sender,
                reasonHash: evidence,
                stage: attestation.stage,
                epoch: attestation.epoch,
                round: attestation.round,
                resolveBy: resolveBy,
                automatic: true
            });
            _setStatus(missionId, mission, MissionStatus.Disputed);
            emit DisputeOpened(missionId, msg.sender, evidence, true, resolveBy);
            return;
        }

        if (attestation.stage == AttestationStage.Recovery) {
            _finalizeRecovery(missionId, mission);
        } else if (attestation.stage == AttestationStage.Availability) {
            _finalizeAvailabilityEpoch(missionId, mission, attestation.epoch);
        } else {
            _completeMission(missionId, mission);
        }
    }

    function _finalizeRecovery(uint256 missionId, Mission storage mission) internal {
        uint256 amount = (uint256(mission.reward) * RECOVERY_BPS) / BASIS_POINTS;
        _debitReward(mission, amount);
        mission.recoveredAt = _timestamp64();
        _setStatus(missionId, mission, MissionStatus.Recovered);
        emit RecoveryFinalized(missionId, mission.recoveredAt);
        emit RewardReleased(missionId, mission.provider, RewardTranche.Recovery, amount);
        _safeTransfer(mission.provider, amount);
    }

    function _finalizeAvailabilityEpoch(
        uint256 missionId,
        Mission storage mission,
        uint32 epoch
    ) internal {
        ++mission.passedAvailabilityEpochs;
        emit AvailabilityEpochVerified(missionId, epoch, mission.passedAvailabilityEpochs);

        if (mission.passedAvailabilityEpochs == mission.availabilityEpochsRequired) {
            uint256 amount = (uint256(mission.reward) * AVAILABILITY_BPS) / BASIS_POINTS;
            mission.availabilityPaid = true;
            _debitReward(mission, amount);
            emit RewardReleased(missionId, mission.provider, RewardTranche.Availability, amount);
            _safeTransfer(mission.provider, amount);
        }
    }

    function _completeMission(uint256 missionId, Mission storage mission) internal {
        uint256 amount = _takeRemainingReward(mission);
        _creditCollateral(missionId, mission, mission.provider);
        _setStatus(missionId, mission, MissionStatus.Completed);
        emit RewardReleased(missionId, mission.provider, RewardTranche.Replication, amount);
        emit MissionCompleted(missionId, mission.provider);
        _safeTransfer(mission.provider, amount);
    }

    function _creditCollateral(
        uint256 missionId,
        Mission storage mission,
        address recipient
    ) internal returns (uint256 amount) {
        amount = mission.collateralHeld;
        if (amount == 0) return 0;
        mission.collateralHeld = 0;
        totalCollateralHeld -= amount;
        nativeCredits[recipient] += amount;
        totalNativeCredits += amount;
        emit CollateralCredited(missionId, recipient, amount);
    }

    function _debitReward(Mission storage mission, uint256 amount) internal {
        mission.remainingReward -= uint128(amount);
        totalEscrowedRewards -= amount;
    }

    function _takeRemainingReward(Mission storage mission) internal returns (uint256 amount) {
        amount = mission.remainingReward;
        mission.remainingReward = 0;
        totalEscrowedRewards -= amount;
    }

    function _retentionDeadline(Mission storage mission) internal view returns (uint256) {
        return uint256(mission.retentionEndsAt) + mission.retentionGracePeriod;
    }

    function _disputeDeadline(Mission storage mission) internal view returns (uint256) {
        if (mission.status == MissionStatus.Claimed || mission.status == MissionStatus.Verifying) {
            return mission.verificationDeadline;
        }
        if (mission.status == MissionStatus.Recovered) {
            return uint256(mission.recoveredAt) + mission.retentionGracePeriod;
        }
        if (mission.status == MissionStatus.Retaining) return _retentionDeadline(mission);
        revert InvalidParameters();
    }

    function _evidenceId(RecoveryAttestation calldata attestation)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                attestation.missionId,
                attestation.provider,
                uint8(attestation.stage),
                attestation.epoch,
                attestation.round,
                attestation.challengeDigest,
                attestation.contentRoot,
                attestation.reconstructedBytes,
                attestation.passed
            )
        );
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature)
        internal
        pure
        returns (address signer)
    {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > _SECP256K1N_DIV_2 || (v != 27 && v != 28)) {
            revert InvalidSignature();
        }
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _safeTransfer(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool success, bytes memory result) = address(rewardToken).call(
            abi.encodeCall(IERC20.transfer, (to, amount))
        );
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TokenOperationFailed();
        }
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool success, bytes memory result) = address(rewardToken).call(
            abi.encodeCall(IERC20.transferFrom, (from, to, amount))
        );
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TokenOperationFailed();
        }
    }

    function _tokenBalance() internal view returns (uint256 balance) {
        (bool success, bytes memory result) = address(rewardToken).staticcall(
            abi.encodeCall(IERC20.balanceOf, (address(this)))
        );
        if (!success || result.length != 32) revert TokenOperationFailed();
        balance = abi.decode(result, (uint256));
    }

    function _getMission(uint256 missionId) internal view returns (Mission storage mission) {
        mission = _missions[missionId];
        if (mission.sponsor == address(0)) revert MissionNotFound(missionId);
    }

    function _requireStatus(
        uint256 missionId,
        Mission storage mission,
        MissionStatus expected
    ) internal view {
        if (mission.status != expected) revert InvalidMissionStatus(missionId, mission.status);
    }

    function _setStatus(
        uint256 missionId,
        Mission storage mission,
        MissionStatus nextStatus
    ) internal {
        MissionStatus previousStatus = mission.status;
        mission.status = nextStatus;
        emit MissionStatusChanged(missionId, previousStatus, nextStatus);
    }

    function _timestamp64() internal view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert InvalidParameters();
        return uint64(block.timestamp);
    }
}
