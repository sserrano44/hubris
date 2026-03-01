// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "../libraries/Constants.sol";
import {HubCustody} from "./HubCustody.sol";
import {IDepositProofVerifier} from "../interfaces/IDepositProofVerifier.sol";

/// @notice Hub-side receiver for Across callbacks.
/// @dev Callback messages are untrusted until finalized through `verifyDepositProof`.
contract HubAcrossReceiver is AccessControl, Initializable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant RECEIVER_ADMIN_ROLE = keccak256("RECEIVER_ADMIN_ROLE");
    uint256 public constant DEFAULT_PENDING_FINALIZE_TTL = 1 days;
    uint256 public constant DEFAULT_RECOVERY_SWEEP_DELAY = 1 days;

    enum PendingState {
        NONE,
        ACTIVE,
        EXPIRED,
        FINALIZED,
        SWEPT
    }

    struct AcrossDepositMessage {
        uint256 depositId;
        uint8 intentType;
        address user;
        address spokeToken;
        address hubAsset;
        uint256 amount;
        uint256 sourceChainId;
        uint256 destinationChainId;
    }

    struct PendingDeposit {
        PendingState state;
        uint256 createdAt;
        uint256 finalizeDeadline;
        uint256 sweepEligibleAt;
        uint256 sourceChainId;
        uint256 depositId;
        uint8 intentType;
        address user;
        address spokeToken;
        address hubAsset;
        uint256 amount;
        address tokenReceived;
        uint256 amountReceived;
        address relayer;
        bytes32 messageHash;
    }

    uint256 internal constant ACROSS_DEPOSIT_MESSAGE_BYTES = 32 * 8;

    HubCustody public immutable custody;
    IDepositProofVerifier public verifier;
    address public spokePool;
    address public recoveryVault;
    uint256 public pendingFinalizeTtl;
    uint256 public recoverySweepDelay;

    mapping(bytes32 => PendingDeposit) public pendingDeposits;
    mapping(bytes32 => bool) public usedFinalizationKey;

    event SpokePoolSet(address indexed spokePool);
    event VerifierSet(address indexed verifier);
    event RecoveryConfigSet(address indexed recoveryVault, uint256 pendingFinalizeTtl, uint256 recoverySweepDelay);
    event PendingDepositRecorded(
        bytes32 indexed pendingId,
        uint256 indexed sourceChainId,
        uint256 indexed depositId,
        uint8 intentType,
        address user,
        address spokeToken,
        address hubAsset,
        uint256 amount,
        address tokenReceived,
        uint256 amountReceived,
        address relayer,
        bytes32 messageHash
    );
    event PendingDepositFinalized(
        bytes32 indexed pendingId,
        bytes32 indexed finalizationKey,
        uint256 indexed sourceChainId,
        uint256 depositId,
        uint8 intentType,
        address user,
        address spokeToken,
        address hubAsset,
        uint256 amount,
        bytes32 sourceTxHash,
        uint256 sourceLogIndex,
        bytes32 messageHash,
        address caller
    );
    event PendingDepositExpired(
        bytes32 indexed pendingId,
        uint256 indexed sourceChainId,
        uint256 indexed depositId,
        uint256 finalizeDeadline,
        address caller
    );
    event PendingDepositSwept(
        bytes32 indexed pendingId,
        uint256 indexed sourceChainId,
        uint256 indexed depositId,
        address token,
        uint256 amount,
        address recoveryVault,
        address caller
    );

    error InvalidCustodyAddress();
    error InvalidVerifier(address verifier);
    error InvalidSpokePool(address spokePool);
    error InvalidRecoveryVault(address recoveryVault);
    error InvalidPendingFinalizeTtl(uint256 pendingFinalizeTtl);
    error InvalidRecoverySweepDelay(uint256 recoverySweepDelay);
    error UnauthorizedSpokePool(address caller);
    error InvalidMessageLength(uint256 length);
    error UnsupportedIntentType(uint8 intentType);
    error InvalidMessageChain(uint256 expectedHubChainId, uint256 gotHubChainId);
    error InvalidMessageUser();
    error InvalidMessageAsset();
    error InvalidMessageAmount();
    error PendingAlreadyExists(bytes32 pendingId);
    error PendingNotFound(bytes32 pendingId);
    error PendingAlreadyFinalized(bytes32 pendingId);
    error PendingAlreadySwept(bytes32 pendingId);
    error PendingNotExpired(bytes32 pendingId, uint256 finalizeDeadline);
    error PendingNotSweepable(bytes32 pendingId, uint256 sweepEligibleAt);
    error PendingInvalidState(bytes32 pendingId, uint8 state);
    error PendingFillMismatch(bytes32 pendingId, address tokenReceived, uint256 amountReceived);
    error WitnessMismatch(bytes32 pendingId);
    error FinalizationReplay(bytes32 finalizationKey);
    error InvalidDepositProof();

    constructor(
        address admin,
        HubCustody custody_,
        IDepositProofVerifier verifier_,
        address spokePool_,
        address recoveryVault_,
        uint256 pendingFinalizeTtl_,
        uint256 recoverySweepDelay_
    ) {
        if (address(custody_) == address(0)) revert InvalidCustodyAddress();
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RECEIVER_ADMIN_ROLE, admin);

        custody = custody_;
        verifier = verifier_;
        spokePool = spokePool_;
        _setRecoveryConfig(recoveryVault_, pendingFinalizeTtl_, recoverySweepDelay_);

        emit VerifierSet(address(verifier_));
        emit SpokePoolSet(spokePool_);
        _disableInitializers();
    }

    function initializeProxy(
        address admin,
        IDepositProofVerifier verifier_,
        address spokePool_,
        address recoveryVault_,
        uint256 pendingFinalizeTtl_,
        uint256 recoverySweepDelay_
    ) external initializer {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RECEIVER_ADMIN_ROLE, admin);

        verifier = verifier_;
        spokePool = spokePool_;
        _setRecoveryConfig(recoveryVault_, pendingFinalizeTtl_, recoverySweepDelay_);

        emit VerifierSet(address(verifier_));
        emit SpokePoolSet(spokePool_);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    function setVerifier(IDepositProofVerifier verifier_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }

    function setSpokePool(address spokePool_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);
        spokePool = spokePool_;
        emit SpokePoolSet(spokePool_);
    }

    function setRecoveryConfig(address recoveryVault_, uint256 pendingFinalizeTtl_, uint256 recoverySweepDelay_)
        external
        onlyRole(RECEIVER_ADMIN_ROLE)
    {
        _setRecoveryConfig(recoveryVault_, pendingFinalizeTtl_, recoverySweepDelay_);
    }

    /// @notice Across V3 callback entrypoint.
    /// @dev Signature matches Across message handler callback shape.
    function handleV3AcrossMessage(address tokenSent, uint256 amountReceived, address relayer, bytes calldata message)
        external
    {
        if (msg.sender != spokePool) revert UnauthorizedSpokePool(msg.sender);
        if (message.length != ACROSS_DEPOSIT_MESSAGE_BYTES) revert InvalidMessageLength(message.length);

        AcrossDepositMessage memory decoded = abi.decode(message, (AcrossDepositMessage));
        if (decoded.intentType != Constants.INTENT_SUPPLY && decoded.intentType != Constants.INTENT_REPAY) {
            revert UnsupportedIntentType(decoded.intentType);
        }
        if (decoded.destinationChainId != block.chainid) {
            revert InvalidMessageChain(block.chainid, decoded.destinationChainId);
        }
        if (decoded.user == address(0)) revert InvalidMessageUser();
        if (decoded.hubAsset == address(0) || tokenSent == address(0)) revert InvalidMessageAsset();
        if (decoded.amount == 0 || amountReceived == 0) revert InvalidMessageAmount();

        bytes32 messageHash = keccak256(message);
        bytes32 pendingId = pendingIdFor(
            decoded.sourceChainId,
            decoded.depositId,
            decoded.intentType,
            decoded.user,
            decoded.hubAsset,
            decoded.amount,
            messageHash
        );

        PendingDeposit storage pending = pendingDeposits[pendingId];
        if (pending.state != PendingState.NONE) revert PendingAlreadyExists(pendingId);

        uint256 createdAt = block.timestamp;
        uint256 finalizeDeadline = createdAt + pendingFinalizeTtl;
        uint256 sweepEligibleAt = finalizeDeadline + recoverySweepDelay;

        pending.state = PendingState.ACTIVE;
        pending.createdAt = createdAt;
        pending.finalizeDeadline = finalizeDeadline;
        pending.sweepEligibleAt = sweepEligibleAt;
        pending.sourceChainId = decoded.sourceChainId;
        pending.depositId = decoded.depositId;
        pending.intentType = decoded.intentType;
        pending.user = decoded.user;
        pending.spokeToken = decoded.spokeToken;
        pending.hubAsset = decoded.hubAsset;
        pending.amount = decoded.amount;
        pending.tokenReceived = tokenSent;
        pending.amountReceived = amountReceived;
        pending.relayer = relayer;
        pending.messageHash = messageHash;

        emit PendingDepositRecorded(
            pendingId,
            decoded.sourceChainId,
            decoded.depositId,
            decoded.intentType,
            decoded.user,
            decoded.spokeToken,
            decoded.hubAsset,
            decoded.amount,
            tokenSent,
            amountReceived,
            relayer,
            messageHash
        );
    }

    function expirePendingDeposit(bytes32 pendingId) external {
        PendingDeposit storage pending = pendingDeposits[pendingId];
        if (pending.state == PendingState.NONE) revert PendingNotFound(pendingId);
        if (pending.state == PendingState.FINALIZED) revert PendingAlreadyFinalized(pendingId);
        if (pending.state == PendingState.SWEPT) revert PendingAlreadySwept(pendingId);
        if (pending.state == PendingState.EXPIRED) return;
        if (block.timestamp < pending.finalizeDeadline) {
            revert PendingNotExpired(pendingId, pending.finalizeDeadline);
        }
        _setExpired(pendingId, pending, msg.sender);
    }

    function sweepExpiredPending(bytes32 pendingId) external onlyRole(RECEIVER_ADMIN_ROLE) {
        PendingDeposit storage pending = pendingDeposits[pendingId];
        if (pending.state == PendingState.NONE) revert PendingNotFound(pendingId);
        if (pending.state == PendingState.FINALIZED) revert PendingAlreadyFinalized(pendingId);
        if (pending.state == PendingState.SWEPT) revert PendingAlreadySwept(pendingId);

        if (pending.state == PendingState.ACTIVE) {
            if (block.timestamp < pending.finalizeDeadline) {
                revert PendingNotExpired(pendingId, pending.finalizeDeadline);
            }
            _setExpired(pendingId, pending, msg.sender);
        }
        if (pending.state != PendingState.EXPIRED) {
            revert PendingInvalidState(pendingId, uint8(pending.state));
        }
        if (block.timestamp < pending.sweepEligibleAt) {
            revert PendingNotSweepable(pendingId, pending.sweepEligibleAt);
        }

        pending.state = PendingState.SWEPT;
        IERC20(pending.tokenReceived).safeTransfer(recoveryVault, pending.amountReceived);

        emit PendingDepositSwept(
            pendingId,
            pending.sourceChainId,
            pending.depositId,
            pending.tokenReceived,
            pending.amountReceived,
            recoveryVault,
            msg.sender
        );
    }

    function finalizePendingDeposit(
        bytes32 pendingId,
        bytes calldata proof,
        IDepositProofVerifier.DepositWitness calldata witness
    ) external {
        PendingDeposit storage pending = pendingDeposits[pendingId];
        if (pending.state == PendingState.NONE) revert PendingNotFound(pendingId);
        if (pending.state == PendingState.FINALIZED) revert PendingAlreadyFinalized(pendingId);
        if (pending.state == PendingState.SWEPT) revert PendingAlreadySwept(pendingId);

        if (pending.state == PendingState.ACTIVE && block.timestamp >= pending.finalizeDeadline) {
            _setExpired(pendingId, pending, msg.sender);
        }
        if (pending.state != PendingState.ACTIVE && pending.state != PendingState.EXPIRED) {
            revert PendingInvalidState(pendingId, uint8(pending.state));
        }

        if (
            pending.sourceChainId != witness.sourceChainId || pending.depositId != witness.depositId
                || pending.intentType != witness.intentType || pending.user != witness.user
                || pending.spokeToken != witness.spokeToken || pending.hubAsset != witness.hubAsset
                || pending.amount != witness.amount
                || pending.messageHash != witness.messageHash
        ) {
            revert WitnessMismatch(pendingId);
        }

        if (pending.tokenReceived != witness.hubAsset || pending.amountReceived != witness.amount) {
            revert PendingFillMismatch(pendingId, pending.tokenReceived, pending.amountReceived);
        }

        bytes32 finalizationKey = finalizationKeyFor(
            witness.sourceChainId,
            witness.sourceTxHash,
            witness.sourceLogIndex,
            witness.depositId,
            witness.messageHash
        );
        if (usedFinalizationKey[finalizationKey]) revert FinalizationReplay(finalizationKey);

        if (!verifier.verifyDepositProof(proof, witness)) revert InvalidDepositProof();

        usedFinalizationKey[finalizationKey] = true;
        pending.state = PendingState.FINALIZED;

        IERC20(pending.tokenReceived).safeTransfer(address(custody), pending.amountReceived);

        custody.registerBridgedDeposit(
            witness.depositId,
            witness.intentType,
            witness.user,
            witness.hubAsset,
            witness.amount,
            witness.sourceChainId,
            witness.sourceTxHash,
            witness.sourceLogIndex
        );

        emit PendingDepositFinalized(
            pendingId,
            finalizationKey,
            witness.sourceChainId,
            witness.depositId,
            witness.intentType,
            witness.user,
            witness.spokeToken,
            witness.hubAsset,
            witness.amount,
            witness.sourceTxHash,
            witness.sourceLogIndex,
            witness.messageHash,
            msg.sender
        );
    }

    function _setRecoveryConfig(address recoveryVault_, uint256 pendingFinalizeTtl_, uint256 recoverySweepDelay_)
        internal
    {
        if (recoveryVault_ == address(0)) revert InvalidRecoveryVault(recoveryVault_);
        if (pendingFinalizeTtl_ == 0) revert InvalidPendingFinalizeTtl(pendingFinalizeTtl_);
        if (recoverySweepDelay_ == 0) revert InvalidRecoverySweepDelay(recoverySweepDelay_);

        recoveryVault = recoveryVault_;
        pendingFinalizeTtl = pendingFinalizeTtl_;
        recoverySweepDelay = recoverySweepDelay_;

        emit RecoveryConfigSet(recoveryVault_, pendingFinalizeTtl_, recoverySweepDelay_);
    }

    function _setExpired(bytes32 pendingId, PendingDeposit storage pending, address caller) internal {
        pending.state = PendingState.EXPIRED;
        emit PendingDepositExpired(pendingId, pending.sourceChainId, pending.depositId, pending.finalizeDeadline, caller);
    }

    function pendingIdFor(
        uint256 sourceChainId,
        uint256 depositId,
        uint8 intentType,
        address user,
        address hubAsset,
        uint256 amount,
        bytes32 messageHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, depositId, intentType, user, hubAsset, amount, messageHash));
    }

    function finalizationKeyFor(
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 sourceLogIndex,
        uint256 depositId,
        bytes32 messageHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, sourceTxHash, sourceLogIndex, depositId, messageHash));
    }
}
