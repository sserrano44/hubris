// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {ProofHash} from "../src/libraries/ProofHash.sol";

contract ProofHashPoseidon2Test is TestBase {
    function test_poseidon2Permutation_regressionVector_isStable() external pure {
        uint256[3] memory input = [uint256(0), uint256(1), uint256(2)];
        uint256[3] memory output = ProofHash.permute3(input);

        assertEq(
            output[0],
            14200285801827375193874737842270308572374888567220732262914905153022814263803,
            "lane0"
        );
        assertEq(
            output[1],
            5316240577722824134207302462015176374180934016570634976784285558543592517839,
            "lane1"
        );
        assertEq(
            output[2],
            16821833312502412175991506692171278649935476954955489266354145709596147613486,
            "lane2"
        );
    }

    function test_hashPair_readsLane0_ofPoseidon2Permutation() external pure {
        uint256 left = 123456789;
        uint256 right = 987654321;

        uint256 expected = ProofHash.permute3([left, right, uint256(0)])[0];
        uint256 actual = ProofHash.hashPair(left, right);

        assertEq(actual, expected, "hashPair lane0 mismatch");
    }
}
