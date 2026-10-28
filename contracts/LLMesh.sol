// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract LLMeshToken is ERC20 {
    address public immutable issuer;
    mapping(address => bool) public registered;
    mapping(bytes32 => bool) public claimedNostr;
    uint256 public constant STARTER = 100000 ether;
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

/// @notice Reserve a bounded budget; settle one ERC-20 unit per reported model token.
/// Usage is attested by the trusted coordinator, not proved by the chain.
contract LLMeshEscrow {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    address public immutable coordinator;
    uint256 public constant PRICE = 1 ether;
    uint256 public constant MAX_CREDITS = 34816;
    struct Job { address payer; address worker; bytes32 nostr; uint64 expires; uint8 state; uint256 amount; uint256 usedCredits; }
    mapping(bytes32 => Job) public jobs;
    event Locked(bytes32 indexed id, address indexed payer, address indexed worker, bytes32 nostr);
    event Settled(bytes32 indexed id, address indexed worker, uint256 credits, uint256 refundedCredits);
    event Refunded(bytes32 indexed id, address indexed payer);
    constructor(IERC20 token_, address coordinator_) {
        require(address(token_) != address(0) && coordinator_ != address(0), "zero address"); token = token_; coordinator = coordinator_;
    }
    function version() external pure returns (uint256) { return 4; }
    function jobId(address payer, bytes32 clientId) public pure returns (bytes32) { return keccak256(abi.encode(payer, clientId)); }
    function lock(bytes32 clientId, bytes32 nostr, address worker, uint256 reservedCredits) external {
        bytes32 id = jobId(msg.sender, clientId);
        require(jobs[id].state == 0 && worker != address(0) && nostr != bytes32(0), "invalid job");
        require(reservedCredits > 0 && reservedCredits <= MAX_CREDITS, "invalid credit budget");
        uint256 amount = PRICE * reservedCredits;
        jobs[id] = Job(msg.sender, worker, nostr, uint64(block.timestamp + 1 hours), 1, amount, 0);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Locked(id, msg.sender, worker, nostr);
    }
    function _settle(bytes32 id, uint256 credits) internal {
        Job storage job = jobs[id];
        require(job.state == 1 && credits <= job.amount / PRICE, "invalid usage");
        job.state = 2; job.usedCredits = credits;
        uint256 paid = credits * PRICE;
        if (paid > 0) token.safeTransfer(job.worker, paid);
        if (job.amount > paid) token.safeTransfer(job.payer, job.amount - paid);
        emit Settled(id, job.worker, credits, (job.amount - paid) / PRICE);
    }
    function settle(bytes32 id, uint256 credits) external {
        require(msg.sender == coordinator && block.timestamp < uint256(jobs[id].expires) + 1 days, "not settleable");
        _settle(id, credits);
    }
    function claimDelivered(bytes32 id, bytes32 outputHash, uint256 credits, bytes calldata signature) external {
        require(outputHash != bytes32(0), "invalid delivery");
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), id, outputHash, credits, "llmesh-usage-v1"));
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature) == coordinator, "invalid completion receipt");
        _settle(id, credits);
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
