// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {IModule} from "@erc3643org/erc-3643/contracts/compliance/modular/modules/IModule.sol";

import {ZKComplianceModule} from "../ZKComplianceModule.sol";

/// Stands in for a ModularCompliance contract so the module can be driven in tests.
contract MockModularCompliance {
    function bind(IModule module) external {
        module.bindCompliance(address(this));
    }

    function unbind(IModule module) external {
        module.unbindCompliance(address(this));
    }

    function setAssetId(ZKComplianceModule module, uint256 assetId) external {
        module.setAssetId(assetId);
    }

    function transferAction(IModule module, address from, address to, uint256 value) external {
        module.moduleTransferAction(from, to, value);
    }

    function mintAction(IModule module, address to, uint256 value) external {
        module.moduleMintAction(to, value);
    }

    function burnAction(IModule module, address from, uint256 value) external {
        module.moduleBurnAction(from, value);
    }

    function check(IModule module, address from, address to, uint256 value) external view returns (bool) {
        return module.moduleCheck(from, to, value, address(this));
    }
}
