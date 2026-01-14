// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {KinzokuV2} from "../solidity/KinzokuV2.sol";

interface IKanaria {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract KinzokuV2ForkTest is Test {
    address internal constant KANARIA_BASE = 0x011ff409BC4803eC5cFaB41c3Fd1db99fD05c004;

    KinzokuV2 internal kinzoku;
    IKanaria internal kanaria;

    address internal holder;
    uint256 internal holderTokenId;

    function setUp() public {
        bool runFork = vm.envOr("RUN_FORK_TESTS", false);
        string memory forkUrl = vm.envOr("FORK_URL", string(""));
        if (!runFork || bytes(forkUrl).length == 0) {
            vm.skip(true, "Set RUN_FORK_TESTS=1 and FORK_URL=http://127.0.0.1:8545 (or use `bun run test`)");
        }
        vm.createSelectFork(forkUrl);

        // Use the address derived from PRIVATE_KEY (as requested).
        uint256 pk = vm.envUint("PRIVATE_KEY");
        holder = vm.addr(pk);

        kanaria = IKanaria(KANARIA_BASE);
        kinzoku = new KinzokuV2(address(this), KANARIA_BASE);

        holderTokenId = _findOwnedTokenId(holder);
        require(holderTokenId != 0, "PRIVATE_KEY address owns no Kanaria Founders token on this fork");
    }

    function testFork_claim_storesPendingClaim() public {
        vm.startPrank(holder);
        kinzoku.claim(holderTokenId, "encrypted-payload-placeholder");
        vm.stopPrank();

        (address claimant, KinzokuV2.Status status, string memory payload) = kinzoku.getClaim(holderTokenId);
        assertEq(claimant, holder);
        assertEq(uint8(status), uint8(KinzokuV2.Status.Pending));
        assertEq(payload, "encrypted-payload-placeholder");
    }

    function testFork_cannotDoubleClaim() public {
        vm.startPrank(holder);
        kinzoku.claim(holderTokenId, "x");
        vm.expectRevert(KinzokuV2.AlreadyClaimed.selector);
        kinzoku.claim(holderTokenId, "y");
        vm.stopPrank();
    }

    function testFork_onlyTokenOwnerCanClaim() public {
        uint256 otherId = _findNotOwnedTokenId(holder);
        if (otherId == 0) return; // extremely unlikely, but avoids brittle failure

        vm.expectRevert(KinzokuV2.NotTokenOwner.selector);
        kinzoku.claim(otherId, "x");
    }

    function testFork_markShipped_onlyOwner() public {
        vm.startPrank(holder);
        kinzoku.claim(holderTokenId, "x");
        vm.stopPrank();

        // Not owner.
        vm.startPrank(holder);
        vm.expectRevert(KinzokuV2.NotOwner.selector);
        kinzoku.markShipped(holderTokenId);
        vm.stopPrank();

        // Owner (this test contract) can mark shipped.
        kinzoku.markShipped(holderTokenId);
        (, KinzokuV2.Status status,) = kinzoku.getClaim(holderTokenId);
        assertEq(uint8(status), uint8(KinzokuV2.Status.Shipped));
    }

    function _isDeadEgg(uint256 id) internal pure returns (bool) {
        return id == 67 || id == 87 || id == 92;
    }

    function _findOwnedTokenId(address a) internal view returns (uint256) {
        for (uint256 i = 1; i <= 99; i++) {
            if (_isDeadEgg(i)) continue;
            try kanaria.ownerOf(i) returns (address o) {
                if (o == a) return i;
            } catch {
                // ignore
            }
        }
        return 0;
    }

    function _findNotOwnedTokenId(address a) internal view returns (uint256) {
        for (uint256 i = 1; i <= 99; i++) {
            if (_isDeadEgg(i)) continue;
            try kanaria.ownerOf(i) returns (address o) {
                if (o != address(0) && o != a) return i;
            } catch {
                // ignore
            }
        }
        return 0;
    }
}

