// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC usdc;
    uint256 payerKey = 0xA11CE;
    address payer;
    address merchant = makeAddr("merchant");
    address facilitator = makeAddr("facilitator");

    function setUp() public {
        usdc = new MockUSDC();
        payer = vm.addr(payerKey);
        usdc.mint(payer, 10_000_000); // 10 USDC
        vm.warp(1_800_000_000);
    }

    function _sign(uint256 key, address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, va, vb, nonce));
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function _auth(uint256 value, bytes32 nonce) internal view returns (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) {
        va = block.timestamp - 60;
        vb = block.timestamp + 120;
        (v, r, s) = _sign(payerKey, payer, merchant, value, va, vb, nonce);
    }

    function test_DomainMatchesBaseSepoliaUsdc() public view {
        assertEq(usdc.name(), "USDC");
        assertEq(usdc.version(), "2");
        assertEq(usdc.decimals(), 6);
    }

    function test_TransferWithAuthorization_FacilitatorPaysGas() public {
        bytes32 nonce = keccak256("mandate");
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(250_000, nonce);

        vm.expectEmit(true, true, false, false, address(usdc));
        emit MockUSDC.AuthorizationUsed(payer, nonce);
        vm.prank(facilitator); // anyone can relay; funds still go payer → merchant
        usdc.transferWithAuthorization(payer, merchant, 250_000, va, vb, nonce, v, r, s);

        assertEq(usdc.balanceOf(payer), 9_750_000);
        assertEq(usdc.balanceOf(merchant), 250_000);
        assertEq(usdc.balanceOf(facilitator), 0);
        assertTrue(usdc.authorizationState(payer, nonce));
    }

    function test_PackedSignatureOverload() public {
        bytes32 nonce = keccak256("packed");
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(1, nonce);
        usdc.transferWithAuthorization(payer, merchant, 1, va, vb, nonce, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(merchant), 1);
    }

    function test_RevertWhen_Replayed() public {
        bytes32 nonce = keccak256("once");
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(100, nonce);
        usdc.transferWithAuthorization(payer, merchant, 100, va, vb, nonce, v, r, s);
        vm.expectRevert(MockUSDC.AuthorizationUsedOrCanceled.selector);
        usdc.transferWithAuthorization(payer, merchant, 100, va, vb, nonce, v, r, s);
    }

    function test_RevertWhen_Expired() public {
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(100, bytes32(0));
        vm.warp(vb);
        vm.expectRevert(MockUSDC.AuthorizationExpired.selector);
        usdc.transferWithAuthorization(payer, merchant, 100, va, vb, bytes32(0), v, r, s);
    }

    function test_RevertWhen_NotYetValid() public {
        uint256 va = block.timestamp + 10;
        uint256 vb = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, payer, merchant, 100, va, vb, bytes32(0));
        vm.expectRevert(MockUSDC.AuthorizationNotYetValid.selector);
        usdc.transferWithAuthorization(payer, merchant, 100, va, vb, bytes32(0), v, r, s);
    }

    function test_RevertWhen_ValueTampered() public {
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(100, bytes32(0));
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.transferWithAuthorization(payer, merchant, 101, va, vb, bytes32(0), v, r, s);
    }

    function test_RevertWhen_RecipientSwapped() public {
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(100, bytes32(0));
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.transferWithAuthorization(payer, makeAddr("attacker"), 100, va, vb, bytes32(0), v, r, s);
    }

    function test_RevertWhen_SignedByOtherKey() public {
        uint256 va = block.timestamp - 1;
        uint256 vb = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _sign(0xBAD, payer, merchant, 100, va, vb, bytes32(0));
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.transferWithAuthorization(payer, merchant, 100, va, vb, bytes32(0), v, r, s);
    }

    function test_RevertWhen_HighS() public {
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(100, bytes32(0));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(n - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.transferWithAuthorization(payer, merchant, 100, va, vb, bytes32(0), vFlip, r, sHigh);
    }

    function test_RevertWhen_InsufficientBalance() public {
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(10_000_001, bytes32(0));
        vm.expectRevert(MockUSDC.InsufficientBalance.selector);
        usdc.transferWithAuthorization(payer, merchant, 10_000_001, va, vb, bytes32(0), v, r, s);
    }

    function test_RevertWhen_WrongChain() public {
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(100, bytes32(0));
        vm.chainId(8453); // same signature replayed on another chain
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.transferWithAuthorization(payer, merchant, 100, va, vb, bytes32(0), v, r, s);
    }

    function test_ReceiveWithAuthorization_OnlyPayee() public {
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(100, bytes32(0));
        vm.expectRevert(MockUSDC.CallerMustBePayee.selector);
        usdc.receiveWithAuthorization(payer, merchant, 100, va, vb, bytes32(0), v, r, s);
        vm.prank(merchant);
        usdc.receiveWithAuthorization(payer, merchant, 100, va, vb, bytes32(0), v, r, s);
        assertEq(usdc.balanceOf(merchant), 100);
    }

    function test_CancelAuthorization_BlocksLaterUse() public {
        bytes32 nonce = keccak256("cancel");
        _cancel(nonce);

        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(100, nonce);
        vm.expectRevert(MockUSDC.AuthorizationUsedOrCanceled.selector);
        usdc.transferWithAuthorization(payer, merchant, 100, va, vb, nonce, v, r, s);
    }

    function _cancel(bytes32 nonce) internal {
        bytes32 structHash = keccak256(abi.encode(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), payer, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        usdc.cancelAuthorization(payer, nonce, v, r, s);
    }

    /// Any value / nonce: a valid authorization moves exactly `value` once and conserves supply.
    function testFuzz_TransferConservesSupply(uint256 value, bytes32 nonce) public {
        value = bound(value, 0, 10_000_000);
        uint256 supply = usdc.totalSupply();
        (uint256 va, uint256 vb, uint8 v, bytes32 r, bytes32 s) = _auth(value, nonce);
        usdc.transferWithAuthorization(payer, merchant, value, va, vb, nonce, v, r, s);
        assertEq(usdc.balanceOf(payer) + usdc.balanceOf(merchant), supply);
        assertEq(usdc.balanceOf(merchant), value);
        vm.expectRevert(MockUSDC.AuthorizationUsedOrCanceled.selector);
        usdc.transferWithAuthorization(payer, merchant, value, va, vb, nonce, v, r, s);
    }
}
