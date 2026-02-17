// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {HubCustody} from "./HubCustody.sol";

/// @notice Adapter that forwards canonical bridge attestations into HubCustody.
/// @dev HubCustody should grant CANONICAL_BRIDGE_RECEIVER_ROLE to this adapter address only.
contract CanonicalBridgeReceiverAdapter is AccessControl {
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");

    HubCustody public immutable custody;

    event CanonicalDepositForwarded(
        uint256 indexed depositId,
        uint8 indexed intentType,
        address indexed user,
        address hubAsset,
        uint256 amount,
        uint256 originChainId,
        bytes32 originTxHash,
        uint256 originLogIndex
    );

    error InvalidCustodyAddress();

    constructor(address admin, HubCustody custody_) {
        if (address(custody_) == address(0)) revert InvalidCustodyAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTER_ROLE, admin);
        custody = custody_;
    }

    function forwardBridgedDeposit(
        uint256 depositId,
        uint8 intentType,
        address user,
        address hubAsset,
        uint256 amount,
        uint256 originChainId,
        bytes32 originTxHash,
        uint256 originLogIndex
    ) external onlyRole(ATTESTER_ROLE) {
        custody.registerBridgedDeposit(
            depositId, intentType, user, hubAsset, amount, originChainId, originTxHash, originLogIndex
        );

        emit CanonicalDepositForwarded(
            depositId, intentType, user, hubAsset, amount, originChainId, originTxHash, originLogIndex
        );
    }
}

