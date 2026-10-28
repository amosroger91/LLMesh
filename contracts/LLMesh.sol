// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Prototype grant issuer. Grants require a Nostr-authenticated issuer voucher.
contract LLMeshToken is ERC20 {
    address public immutable issuer;
    mapping(address => bool) public registered;
    mapping(bytes32 => bool) public claimedNostr;
    uint256 public constant STARTER = 100 ether;
    event Registered(address indexed wallet, bytes32 indexed nostr);
    constructor(address issuer_) ERC20("LLMesh Compute", "LLMESH") {
        require(issuer_ != address(0), "zero issuer"); issuer = issuer_;
    }
    function register(address wallet, bytes32 nostr, uint256 deadline, bytes calldata signature) external {
        require(block.timestamp <= deadline && !registered[wallet] && !claimedNostr[nostr] && nostr != bytes32(0) && wallet != address(0), "grant unavailable");
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), wallet, nostr, deadline));
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature) == issuer, "invalid issuer voucher");
        registered[wallet] = true; claimedNostr[nostr] = true; _mint(wallet, STARTER);
        emit Registered(wallet, nostr);
    }
}

/// @notice Fund before inference. Coordinator can only release to the preselected worker or refund payer.
contract LLMeshEscrow {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    address public immutable coordinator;
    uint256 public constant PRICE = 1 ether;
    struct Job { address payer; address worker; bytes32 nostr; uint64 expires; uint8 state; uint256 amount; uint8 level; }
    mapping(bytes32 => Job) public jobs;
    event Locked(bytes32 indexed id, address indexed payer, address indexed worker, bytes32 nostr);
    event Settled(bytes32 indexed id, address indexed worker);
    event Refunded(bytes32 indexed id, address indexed payer);
    constructor(IERC20 token_, address coordinator_) {
        require(address(token_) != address(0) && coordinator_ != address(0), "zero address"); token = token_; coordinator = coordinator_;
    }
    function version() external pure returns (uint256) { return 3; }
    function jobId(address payer, bytes32 clientId) public pure returns (bytes32) { return keccak256(abi.encode(payer, clientId)); }
    function lock(bytes32 id, bytes32 nostr, address worker, uint8 level) external {
        _lock(jobId(msg.sender, id), nostr, worker, level);
    }
    function _lock(bytes32 id, bytes32 nostr, address worker, uint8 level) internal {
        require(jobs[id].state == 0 && worker != address(0) && nostr != bytes32(0), "invalid job");
        require(level <= 2, "invalid contribution level");
        uint256 amount = PRICE * (uint256(level) + 1);
        jobs[id] = Job(msg.sender, worker, nostr, uint64(block.timestamp + 1 hours), 1, amount, level);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Locked(id, msg.sender, worker, nostr);
    }
    function settle(bytes32 id) external {
        require(msg.sender == coordinator && jobs[id].state == 1 && block.timestamp < uint256(jobs[id].expires) + 1 days, "not settleable");
        Job storage job = jobs[id]; job.state = 2; token.safeTransfer(job.worker, job.amount); emit Settled(id, job.worker);
    }
    function claimDelivered(bytes32 id, bytes32 outputHash, bytes calldata signature) external {
        Job storage job = jobs[id];
        require(job.state == 1 && outputHash != bytes32(0), "invalid delivery");
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), id, outputHash));
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature) == coordinator, "invalid completion receipt");
        job.state = 2; token.safeTransfer(job.worker, job.amount); emit Settled(id, job.worker);
    }
    function refundFailed(bytes32 id, bytes calldata signature) external {
        Job storage job = jobs[id];
        require(job.state == 1, "not refundable");
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), id, "refund-failed"));
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature) == job.worker, "worker must authorize early refund");
        job.state = 3; token.safeTransfer(job.payer, job.amount); emit Refunded(id, job.payer);
    }
    function refund(bytes32 id) external {
        Job storage job = jobs[id];
        require(job.state == 1 && ((msg.sender == coordinator || msg.sender == job.payer) && block.timestamp >= uint256(job.expires) + 1 days), "not refundable");
        job.state = 3; token.safeTransfer(job.payer, job.amount); emit Refunded(id, job.payer);
    }
}
