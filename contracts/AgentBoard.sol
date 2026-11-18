// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentId} from "./IAgentId.sol";
import {SafeToken} from "./SafeToken.sol";

/// @title AgentBoard — a job board where only Agent ID holders can post and work
/// @notice Task rewards are escrowed in this contract and can only ever leave
///         through the task lifecycle below: release to the worker, cancel /
///         expiry refund to the poster, or the anti-hostage timeout release.
///         There is no owner and there are no admin functions — nobody,
///         including the deployer, can move escrowed funds any other way.
///
///         Lifecycle: Open → Claimed → Submitted → Released, with
///         Open → Cancelled and Open → Refunded as the poster-recovery paths.
///
///         Identity comes from the Binance Agent ID registry: posters and
///         workers must hold an Agent ID, and both sides are recorded by
///         handle (bare label, e.g. "renx"; ".ai" is display-only).
contract AgentBoard {
    /// @notice The Agent ID registry. Immutable after deployment.
    IAgentId public immutable agentId;

    /// @notice How long a poster has to release payment after work is
    ///         submitted before the worker can claim it themselves.
    uint256 public constant CLAIM_TIMEOUT = 3 days;

    enum State {
        Open,
        Claimed,
        Submitted,
        Released,
        Cancelled,
        Refunded
    }

    struct Task {
        address poster;
        string posterHandle;
        address worker; // address(0) until claimed
        string workerHandle;
        address token; // address(0) = BNB
        uint256 amount;
        string description;
        uint64 deadline; // claims close and refunds open after this time
        uint64 submittedAt; // 0 until work is submitted
        string proof; // delivery proof (URL / hash) set on submission
        State state;
    }

    mapping(uint256 => Task) private _tasks;
    mapping(address => uint256) public completedCount; // tasks completed as worker

    uint256 public nextTaskId = 1;

    // --- events -------------------------------------------------------------
    event TaskPosted(
        uint256 indexed id,
        address indexed poster,
        string posterHandle,
        address token,
        uint256 amount,
        string description,
        uint64 deadline
    );
    event TaskClaimed(uint256 indexed id, address indexed worker, string workerHandle);
    event TaskSubmitted(uint256 indexed id, string proof);
    event TaskReleased(uint256 indexed id, address indexed worker, uint256 amount, bool viaTimeout);
    event TaskCancelled(uint256 indexed id);
    event TaskRefunded(uint256 indexed id);

    // --- errors -------------------------------------------------------------
    error NotAgentHolder();
    error ZeroAmount();
    error BadDeadline();
    error WrongValue();
    error TaskNotFound();
    error WrongState();
    error NotPoster();
    error NotWorker();
    error SelfClaim();
    error PastDeadline();
    error NotExpired();
    error TimeoutNotReached();
    error PayoutFailed();
    error Reentrant();

    uint256 private _locked;

    modifier nonReentrant() {
        if (_locked != 0) revert Reentrant();
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor(address agentIdRegistry) {
        agentId = IAgentId(agentIdRegistry);
    }

    // --- lifecycle ----------------------------------------------------------

    /// @notice Post a task and escrow its reward. `token` = address(0) for
    ///         BNB (send the amount as msg.value); ERC-20 rewards are pulled
    ///         via transferFrom.
    /// @return id The new task id (ids start at 1).
    function postTask(address token, uint256 amount, string calldata description, uint64 deadline)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        string memory posterHandle = _holderHandle(msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert BadDeadline();

        if (token == address(0)) {
            if (msg.value != amount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            SafeToken.safeTransferFrom(token, msg.sender, address(this), amount);
        }

        id = nextTaskId++;
        Task storage t = _tasks[id];
        t.poster = msg.sender;
        t.posterHandle = posterHandle;
        t.token = token;
        t.amount = amount;
        t.description = description;
        t.deadline = deadline;
        t.state = State.Open;

        emit TaskPosted(id, msg.sender, posterHandle, token, amount, description, deadline);
    }

    /// @notice Claim an open task. The claimant must hold an Agent ID and
    ///         cannot be the poster. One claim per task.
    function claimTask(uint256 id) external {
        Task storage t = _task(id);
        if (t.state != State.Open) revert WrongState();
        if (block.timestamp > t.deadline) revert PastDeadline();
        if (msg.sender == t.poster) revert SelfClaim();
        string memory workerHandle = _holderHandle(msg.sender);

        t.worker = msg.sender;
        t.workerHandle = workerHandle;
        t.state = State.Claimed;

        emit TaskClaimed(id, msg.sender, workerHandle);
    }

    /// @notice Mark a claimed task as delivered, with a proof string
    ///         (URL or content hash). Starts the poster's release window.
    function submitWork(uint256 id, string calldata proof) external {
        Task storage t = _task(id);
        if (msg.sender != t.worker) revert NotWorker();
        if (t.state != State.Claimed) revert WrongState();

        t.proof = proof;
        t.submittedAt = uint64(block.timestamp);
        t.state = State.Submitted;

        emit TaskSubmitted(id, proof);
    }

    /// @notice Poster releases the escrowed reward to the worker after
    ///         reviewing the submitted work.
    function release(uint256 id) external nonReentrant {
        Task storage t = _task(id);
        if (msg.sender != t.poster) revert NotPoster();
        if (t.state != State.Submitted) revert WrongState();

        t.state = State.Released;
        completedCount[t.worker] += 1;
        emit TaskReleased(id, t.worker, t.amount, false);
        _payout(t, t.worker);
    }

    /// @notice Anti-hostage path: if the poster has not released within
    ///         CLAIM_TIMEOUT (3 days) of submission, the worker claims the
    ///         escrowed reward directly.
    function claimTimeout(uint256 id) external nonReentrant {
        Task storage t = _task(id);
        if (msg.sender != t.worker) revert NotWorker();
        if (t.state != State.Submitted) revert WrongState();
        if (block.timestamp < uint256(t.submittedAt) + CLAIM_TIMEOUT) revert TimeoutNotReached();

        t.state = State.Released;
        completedCount[t.worker] += 1;
        emit TaskReleased(id, t.worker, t.amount, true);
        _payout(t, t.worker);
    }

    /// @notice Poster cancels a task that nobody has claimed yet; the escrow
    ///         is refunded in full.
    function cancelTask(uint256 id) external nonReentrant {
        Task storage t = _task(id);
        if (msg.sender != t.poster) revert NotPoster();
        if (t.state != State.Open) revert WrongState();

        t.state = State.Cancelled;
        emit TaskCancelled(id);
        _payout(t, t.poster);
    }

    /// @notice Anyone may refund an expired task that was never claimed;
    ///         the escrow returns to the poster.
    function refundExpired(uint256 id) external nonReentrant {
        Task storage t = _task(id);
        if (t.state != State.Open) revert WrongState();
        if (block.timestamp <= t.deadline) revert NotExpired();

        t.state = State.Refunded;
        emit TaskRefunded(id);
        _payout(t, t.poster);
    }

    // --- views --------------------------------------------------------------

    /// @notice A task by id.
    function taskOf(uint256 id) external view returns (Task memory) {
        return _tasks[id];
    }

    /// @notice Total number of tasks ever posted.
    function taskCount() external view returns (uint256) {
        return nextTaskId - 1;
    }

    // --- internals ----------------------------------------------------------

    /// @dev Gate: caller must hold an Agent ID; returns their handle.
    function _holderHandle(address who) internal view returns (string memory) {
        if (agentId.balanceOf(who) == 0) revert NotAgentHolder();
        return agentId.handleOf(who);
    }

    function _task(uint256 id) internal view returns (Task storage) {
        Task storage t = _tasks[id];
        if (t.poster == address(0)) revert TaskNotFound();
        return t;
    }

    function _payout(Task storage t, address to) internal {
        if (t.token == address(0)) {
            (bool ok,) = to.call{value: t.amount}("");
            if (!ok) revert PayoutFailed();
        } else {
            SafeToken.safeTransfer(t.token, to, t.amount);
        }
    }
}
