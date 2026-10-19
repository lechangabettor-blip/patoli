// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

interface IArenaDeposit {
    function deposit(uint256 amount, address beneficiary) external;
}

/**
 * @title DepositForwarder — a per-user mailbox for Arena deposits.
 * @dev Polymarket's relayer refuses deposit-wallet batches that APPROVE a spender outside
 *      Polymarket's allowlist, but plain token transfers are fine. So instead of
 *      approve+deposit, a user simply transfers pUSD to their own forwarder address
 *      (deterministic, CREATE2, salt = user). Anyone may then call `ArenaDepositRouter.sweep`,
 *      which deploys the forwarder on first use and moves the funds into the Arena credited
 *      to that user. The router holds nothing between calls; the forwarder obeys only the router.
 */
contract DepositForwarder {
    address public immutable ROUTER;

    constructor(address router) {
        ROUTER = router;
    }

    function flush(IERC20 token) external returns (uint256 amount) {
        require(msg.sender == ROUTER, "router only");
        amount = token.balanceOf(address(this));
        if (amount > 0) SafeERC20.safeTransfer(token, ROUTER, amount);
    }
}

contract ArenaDepositRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable TOKEN;
    IArenaDeposit public immutable ARENA;

    event Swept(address indexed user, address indexed forwarder, uint256 amount);

    constructor(IERC20 token, IArenaDeposit arena) {
        TOKEN = token;
        ARENA = arena;
        TOKEN.forceApprove(address(arena), type(uint256).max);
    }

    /// @notice Where `user` should send pUSD. Valid before the forwarder is deployed.
    function forwarderOf(address user) public view returns (address) {
        return Create2.computeAddress(bytes32(uint256(uint160(user))), keccak256(_initCode()));
    }

    /// @notice Pull whatever sits in `user`'s forwarder into the Arena, credited to `user`.
    ///         Permissionless: Patoli's operator calls it (and pays gas) right after a transfer.
    function sweep(address user) external returns (uint256 amount) {
        address fwd = forwarderOf(user);
        if (fwd.code.length == 0) {
            Create2.deploy(0, bytes32(uint256(uint160(user))), _initCode());
        }
        amount = DepositForwarder(fwd).flush(TOKEN);
        if (amount > 0) {
            ARENA.deposit(amount, user);
            emit Swept(user, fwd, amount);
        }
    }

    function _initCode() internal view returns (bytes memory) {
        return abi.encodePacked(type(DepositForwarder).creationCode, abi.encode(address(this)));
    }
}
