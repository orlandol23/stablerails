// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Scaffold sanity suite: pins the toolchain (forge-std + OZ v5
/// remappings compile and run) and the 6-decimals discipline before any
/// feature code lands. Replaced by real PayoutEscrow suites in C2/C3.
contract SanityTest is Test {
    /// USDC has 6 decimals — not 18. Every amount in this repo is micro-USDC.
    uint256 internal constant MICRO_PER_USDC = 1e6;

    function test_UsdcHasSixDecimals() public pure {
        assertEq(MICRO_PER_USDC, 1_000_000);
    }

    /// OZ import proves the remapping + submodule wiring end-to-end.
    function test_OpenZeppelinLinked() public pure {
        assertEq(Math.max(1, 2), 2);
    }

    function testFuzz_MicroUsdcScalingRoundtrip(uint128 wholeUsdc) public pure {
        uint256 micro = uint256(wholeUsdc) * MICRO_PER_USDC;
        assertEq(micro / MICRO_PER_USDC, wholeUsdc);
    }
}
