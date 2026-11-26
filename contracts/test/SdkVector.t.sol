// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Cross-language check: an EIP-3009 authorization produced by the TypeScript SDK's full
/// AP2 + x402 flow (scripts/gen-forge-vector.ts) must be accepted by the token contract, and
/// its nonce must be reproducible in Solidity as keccak256(payment mandate).
contract SdkVectorTest is Test {
    MockUSDC usdc;
    address from;
    address to;
    uint256 value;
    uint256 validAfter;
    uint256 validBefore;
    bytes32 nonce;
    bytes signature;
    uint8 v;
    bytes32 r;
    bytes32 s;
    string paymentMandate;

    function setUp() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/sdk-vector.json"));
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        address token = vm.parseJsonAddress(json, ".token");
        from = vm.parseJsonAddress(json, ".from");
        to = vm.parseJsonAddress(json, ".to");
        value = vm.parseUint(vm.parseJsonString(json, ".value"));
        validAfter = vm.parseUint(vm.parseJsonString(json, ".validAfter"));
        validBefore = vm.parseUint(vm.parseJsonString(json, ".validBefore"));
        nonce = vm.parseJsonBytes32(json, ".nonce");
        signature = vm.parseJsonBytes(json, ".signature");
        v = uint8(vm.parseJsonUint(json, ".v"));
        r = vm.parseJsonBytes32(json, ".r");
        s = vm.parseJsonBytes32(json, ".s");
        paymentMandate = vm.parseJsonString(json, ".paymentMandate");

        // Place the token at the address the SDK signed for (EIP-712 verifyingContract).
        deployCodeTo("MockUSDC.sol:MockUSDC", token);
        usdc = MockUSDC(token);
        usdc.mint(from, value);
        vm.warp(validAfter + 1);
    }

    function test_NonceIsKeccakOfPaymentMandate() public view {
        assertEq(keccak256(bytes(paymentMandate)), nonce, "AP2 <-> x402 binding not reproducible on-chain");
    }

    function test_SdkSignatureSettlesOnChain() public {
        usdc.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
        assertEq(usdc.balanceOf(to), value);
        assertEq(usdc.balanceOf(from), 0);
        assertTrue(usdc.authorizationState(from, nonce));
    }

    function test_SdkPackedSignatureSettlesOnChain() public {
        usdc.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
        assertEq(usdc.balanceOf(to), value);
    }

    /// A different mandate yields a different nonce, so the payer's signature no longer verifies.
    function test_RevertWhen_MandateSwapped() public {
        bytes32 otherNonce = keccak256(bytes(string.concat(paymentMandate, "x")));
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.transferWithAuthorization(from, to, value, validAfter, validBefore, otherNonce, v, r, s);
    }

    function test_RevertWhen_SettledTwice() public {
        usdc.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
        usdc.mint(from, value);
        vm.expectRevert(MockUSDC.AuthorizationUsedOrCanceled.selector);
        usdc.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    function test_RevertWhen_AfterValidBefore() public {
        vm.warp(validBefore);
        vm.expectRevert(MockUSDC.AuthorizationExpired.selector);
        usdc.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
    }
}
