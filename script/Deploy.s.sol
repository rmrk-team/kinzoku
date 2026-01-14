// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {KinzokuV2} from "../solidity/KinzokuV2.sol";

/// @notice CREATE2 deploy script for KinzokuV2 (idempotent; writes `deployments/<chainId>.json`).
contract DeployScript is Script {
    using stdJson for string;

    bytes32 internal constant SALT = keccak256("KinzokuV2_v1");

    function run() external returns (KinzokuV2 kinzoku) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address kanaria = vm.envOr("KANARIA_ADDRESS", _defaultKanaria(block.chainid));
        require(kanaria != address(0), "KANARIA_ADDRESS required for unknown chain");

        bytes memory initCode = abi.encodePacked(type(KinzokuV2).creationCode, abi.encode(deployer, kanaria));
        address predicted = vm.computeCreate2Address(SALT, keccak256(initCode));

        if (predicted.code.length == 0) {
            vm.startBroadcast(pk);
            kinzoku = new KinzokuV2{salt: SALT}(deployer, kanaria);
            vm.stopBroadcast();
        } else {
            kinzoku = KinzokuV2(predicted);
        }

        _writeDeploymentJson(deployer, address(kinzoku), kanaria);
    }

    function _defaultKanaria(uint256 chainId) internal pure returns (address) {
        if (chainId == 8453 || chainId == 31337) {
            // Base mainnet (8453) and local Base fork (31337): Kanaria Founders
            return 0x011ff409BC4803eC5cFaB41c3Fd1db99fD05c004;
        }
        return address(0);
    }

    function _writeDeploymentJson(address deployer, address kinzokuV2, address kanaria) internal {
        vm.createDir("deployments", true);

        string memory jsonKey = "deployment";
        jsonKey.serialize("chainId", block.chainid);
        jsonKey.serialize("deployer", deployer);
        jsonKey.serialize("salt", SALT);
        jsonKey.serialize("kinzokuV2", kinzokuV2);
        string memory finalJson = jsonKey.serialize("kanaria", kanaria);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        finalJson.write(path);
    }
}

