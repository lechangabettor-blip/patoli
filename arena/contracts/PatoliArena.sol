// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title PatoliArena — player-vs-player rock·paper·scissors escrow (no house, no rake)
 *
 * Money model
 *  - Players deposit pUSD once; balances live here. Matches cost zero gas: everything a
 *    match needs is an EIP-712 signature exchanged off-chain through Patoli's server.
 *  - Settlement moves `stake` from loser to winner. Anyone may submit a settlement; it is
 *    valid only with the players' own signatures, so the server can neither forge a match
 *    nor an outcome. A draw (or an abandoned match) refunds both sides.
 *  - Withdrawals never depend on the server: `requestWithdraw` → `finalizeWithdraw` after
 *    `withdrawDelay` (gives open matches time to settle), or instantly by signature
 *    (`withdrawWithSig`, relayed and gas-paid by Patoli).
 *
 * Two settlement paths
 *  1. Happy path: a COMPLETED match (someone reached the needed wins through rounds where
 *     both revealed) settles straight from the players' signed, operator-acked moves →
 *     `settle` / `settleBatch`. No result signature, nothing for the players to do.
 *  2. Dispute path (opponent vanished): after `match.deadline`, anyone opens a `claim`
 *     with the signed artifacts they hold (round commits signed by the player, reveals).
 *     The contract replays the match from those artifacts. A counter-claim inside
 *     `challengeWindow` must carry strictly more valid artifacts and replaces the
 *     pending outcome. `finalize` pays.
 *     Signatures carry no clock, so a loser could sign a "late" commit after the match and
 *     rewrite the replay. To prevent that, every commit and reveal must ALSO carry the
 *     operator's acknowledgement (`CommitAck` / `RevealAck`), which the server issues only
 *     for moves that arrived inside their window. The operator can therefore censor
 *     (refuse to ack — a liveness failure, same as refusing to relay) but can never
 *     forge a move or an outcome: every counted artifact is still player-signed.
 *
 * Owner powers are deliberately tiny: stake limits, pausing NEW deposits, rescuing tokens
 * that are not the escrow token. No function lets the owner touch player balances.
 */
contract PatoliArena is EIP712, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    struct Match {
        bytes32 id;
        address playerA;
        address playerB;
        uint256 stake; // per player, token units
        uint8 bestOf; // 3 → first to 2
        uint64 deadline; // after this, the dispute path opens
    }

    struct SignedCommit {
        uint8 round; // 1-based
        address player;
        bytes32 hash; // keccak256(abi.encodePacked(matchId, round, player, move, salt))
        bytes sig; // EIP-712 Commit signature by `player`
        bytes opSig; // EIP-712 CommitAck signature by `operator` (proves it was in time)
    }

    struct Reveal {
        uint8 round;
        address player;
        uint8 move; // 1 piedra · 2 papel · 3 tijera
        bytes32 salt;
        bytes opSig; // EIP-712 RevealAck signature by `operator`
    }

    struct Claim {
        address claimant;
        address winner; // address(0) = draw → refund
        uint32 evidence; // number of valid artifacts behind this claim
        uint64 finalizeAt;
    }

    struct PendingWithdraw {
        uint256 amount;
        address to;
        uint64 readyAt;
    }

    // -------------------------------------------------------------- constants

    bytes32 public constant MATCH_TYPEHASH =
        keccak256("Match(bytes32 id,address playerA,address playerB,uint256 stake,uint8 bestOf,uint64 deadline)");
    bytes32 public constant COMMIT_TYPEHASH = keccak256("Commit(bytes32 matchId,uint8 round,bytes32 hash)");
    bytes32 public constant COMMIT_ACK_TYPEHASH = keccak256("CommitAck(bytes32 matchId,uint8 round,address player,bytes32 hash)");
    bytes32 public constant REVEAL_ACK_TYPEHASH = keccak256("RevealAck(bytes32 matchId,uint8 round,address player,uint8 move,bytes32 salt)");
    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address player,address to,uint256 amount,uint256 nonce,uint256 deadline)");

    uint8 public constant MAX_ROUNDS = 15; // ties are replayed as new rounds; hard cap keeps disputes bounded
    uint8 internal constant SETTLED = 1;

    // ---------------------------------------------------------------- storage

    IERC20 public immutable TOKEN;
    /// @notice Patoli's clock: acknowledges moves that arrived in time. Cannot forge moves or outcomes.
    address public operator;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public nonces; // withdrawWithSig
    mapping(address => PendingWithdraw) public pendingWithdraw;
    mapping(bytes32 => uint8) public matchStatus; // 0 open · 1 settled
    mapping(bytes32 => Claim) public claims;

    uint256 public minStake;
    uint256 public maxStake;
    uint64 public withdrawDelay = 1 hours;
    uint64 public challengeWindow = 24 hours;
    bool public depositsPaused;

    // ----------------------------------------------------------------- events

    event Deposit(address indexed player, address indexed from, uint256 amount);
    event WithdrawRequested(address indexed player, address indexed to, uint256 amount, uint64 readyAt);
    event WithdrawCancelled(address indexed player, uint256 amount);
    event Withdraw(address indexed player, address indexed to, uint256 amount);
    event Settled(bytes32 indexed matchId, address indexed playerA, address indexed playerB, address winner, uint256 stake, bool disputed);
    event Shortfall(bytes32 indexed matchId, address indexed loser, uint256 owed, uint256 paid);
    event ClaimOpened(bytes32 indexed matchId, address indexed claimant, address winner, uint32 evidence, uint64 finalizeAt);
    event LimitsSet(uint256 minStake, uint256 maxStake);
    event DepositsPaused(bool paused);
    event OperatorSet(address operator);

    // ----------------------------------------------------------------- errors

    error ZeroAmount();
    error Paused();
    error InsufficientBalance();
    error NothingPending();
    error TooEarly();
    error Expired();
    error BadSignature();
    error AlreadySettled();
    error BadMatch();
    error StakeOutOfRange();
    error NoClaim();
    error WeakerClaim();
    error ClaimPending();
    error EscrowToken();
    error Incomplete();

    constructor(IERC20 token, address owner_, address operator_, uint256 minStake_, uint256 maxStake_)
        EIP712("PatoliArena", "1")
        Ownable(owner_)
    {
        TOKEN = token;
        operator = operator_;
        minStake = minStake_;
        maxStake = maxStake_;
    }

    // --------------------------------------------------------- deposits/withdraws

    /// @notice Deposit `amount` of TOKEN from msg.sender, credited to `beneficiary`.
    /// @dev Polymarket deposit wallets call this with beneficiary = their owner EOA, the
    ///      key that signs matches. Anyone may top up anyone.
    function deposit(uint256 amount, address beneficiary) external nonReentrant {
        if (depositsPaused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (beneficiary == address(0)) revert BadMatch();
        TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[beneficiary] += amount;
        emit Deposit(beneficiary, msg.sender, amount);
    }

    /// @notice Self-service withdrawal, step 1. Funds are reserved immediately and payable
    ///         after `withdrawDelay`. Needs gas; exists so nobody ever depends on Patoli.
    function requestWithdraw(uint256 amount, address to) external {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert BadMatch();
        if (pendingWithdraw[msg.sender].amount != 0) revert ClaimPending();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        uint64 readyAt = uint64(block.timestamp) + withdrawDelay;
        pendingWithdraw[msg.sender] = PendingWithdraw({amount: amount, to: to, readyAt: readyAt});
        emit WithdrawRequested(msg.sender, to, amount, readyAt);
    }

    function cancelWithdraw() external {
        PendingWithdraw memory p = pendingWithdraw[msg.sender];
        if (p.amount == 0) revert NothingPending();
        delete pendingWithdraw[msg.sender];
        balanceOf[msg.sender] += p.amount;
        emit WithdrawCancelled(msg.sender, p.amount);
    }

    /// @notice Self-service withdrawal, step 2. Anyone may trigger the payout once ready.
    function finalizeWithdraw(address player) external nonReentrant {
        PendingWithdraw memory p = pendingWithdraw[player];
        if (p.amount == 0) revert NothingPending();
        if (block.timestamp < p.readyAt) revert TooEarly();
        delete pendingWithdraw[player];
        TOKEN.safeTransfer(p.to, p.amount);
        emit Withdraw(player, p.to, p.amount);
    }

    /// @notice Instant withdrawal authorised by the player's signature; relayed (and gas
    ///         paid) by Patoli. The server only relays when the player has no open match.
    function withdrawWithSig(address player, address to, uint256 amount, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert Expired();
        uint256 nonce = nonces[player]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, player, to, amount, nonce, deadline)));
        if (!SignatureChecker.isValidSignatureNow(player, digest, sig)) revert BadSignature();
        if (balanceOf[player] < amount) revert InsufficientBalance();
        balanceOf[player] -= amount;
        TOKEN.safeTransfer(to, amount);
        emit Withdraw(player, to, amount);
    }

    // ------------------------------------------------------------ happy path

    /// @notice Settle a COMPLETED match straight from the players' signed moves. Complete =
    ///         a player reached the needed wins through rounds where BOTH revealed. Every
    ///         artifact is player-signed and operator-acked, and there is at most one acked
    ///         commit per player per round, so no later evidence can change the replay:
    ///         the outcome is final the moment the last move is revealed.
    ///         Forfeits and abandoned matches are NOT complete — they go through claim/finalize.
    function settle(Match calldata m, bytes calldata sigA, bytes calldata sigB, SignedCommit[] calldata commits, Reveal[] calldata reveals)
        external
        nonReentrant
    {
        _checkMatch(m, sigA, sigB);
        (address winner,, bool complete) = _replay(m, commits, reveals);
        if (!complete) revert Incomplete();
        _apply(m, winner, false);
    }

    struct SettleInput {
        Match m;
        bytes sigA;
        bytes sigB;
        SignedCommit[] commits;
        Reveal[] reveals;
    }

    /// @notice Batch of completed-match settlements (Patoli submits these every minute).
    ///         A bad or incomplete item is skipped, not reverted, so one broken match can't
    ///         block the rest. Check the `Settled` events to see which ones went through.
    function settleBatch(SettleInput[] calldata items) external nonReentrant {
        for (uint256 i = 0; i < items.length; i++) {
            SettleInput calldata it = items[i];
            if (matchStatus[it.m.id] == SETTLED) continue;
            if (!_matchOk(it.m, it.sigA, it.sigB)) continue;
            (address winner,, bool complete) = _replay(it.m, it.commits, it.reveals);
            if (!complete) continue;
            _apply(it.m, winner, false);
        }
    }

    // ----------------------------------------------------------- dispute path

    /// @notice After the match deadline, anyone (a player, or Patoli's operator on the
    ///         winner's behalf) presents the signed artifacts they hold. The contract
    ///         replays the match; the outcome becomes payable after `challengeWindow`
    ///         unless someone presents strictly more evidence. Evidence is player-signed,
    ///         so a third party can only ever submit a subset, never a forgery.
    function claim(Match calldata m, bytes calldata sigA, bytes calldata sigB, SignedCommit[] calldata commits, Reveal[] calldata reveals)
        external
    {
        _checkMatch(m, sigA, sigB);
        if (block.timestamp <= m.deadline) revert TooEarly();
        (address winner, uint32 evidence,) = _replay(m, commits, reveals);
        Claim memory prev = claims[m.id];
        if (prev.claimant != address(0)) {
            if (block.timestamp >= prev.finalizeAt) revert Expired(); // finalize instead
            if (evidence <= prev.evidence) revert WeakerClaim();
        }
        uint64 finalizeAt = uint64(block.timestamp) + challengeWindow;
        claims[m.id] = Claim({claimant: msg.sender, winner: winner, evidence: evidence, finalizeAt: finalizeAt});
        emit ClaimOpened(m.id, msg.sender, winner, evidence, finalizeAt);
    }

    /// @notice Pay out an unchallenged claim. Anyone may call.
    function finalize(Match calldata m, bytes calldata sigA, bytes calldata sigB) external nonReentrant {
        _checkMatch(m, sigA, sigB);
        Claim memory c = claims[m.id];
        if (c.claimant == address(0)) revert NoClaim();
        if (block.timestamp < c.finalizeAt) revert TooEarly();
        delete claims[m.id];
        _apply(m, c.winner, true);
    }

    // ------------------------------------------------------------------ admin

    function setLimits(uint256 minStake_, uint256 maxStake_) external onlyOwner {
        minStake = minStake_;
        maxStake = maxStake_;
        emit LimitsSet(minStake_, maxStake_);
    }

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function setDelays(uint64 withdrawDelay_, uint64 challengeWindow_) external onlyOwner {
        require(withdrawDelay_ <= 7 days && challengeWindow_ <= 7 days, "too long");
        withdrawDelay = withdrawDelay_;
        challengeWindow = challengeWindow_;
    }

    /// @notice Recover tokens sent here by mistake. The escrow token itself can never leave this way.
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (token == TOKEN) revert EscrowToken();
        token.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------ views

    function matchHash(Match calldata m) external view returns (bytes32) {
        return _matchDigest(m);
    }

    function commitHash(bytes32 matchId, uint8 round, address player, uint8 move, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(matchId, round, player, move, salt));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --------------------------------------------------------------- internals

    function _matchDigest(Match calldata m) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MATCH_TYPEHASH, m.id, m.playerA, m.playerB, m.stake, m.bestOf, m.deadline)));
    }

    function _matchOk(Match calldata m, bytes calldata sigA, bytes calldata sigB) internal view returns (bool) {
        if (m.playerA == m.playerB || m.playerA == address(0) || m.playerB == address(0)) return false;
        if (m.stake < minStake || m.stake > maxStake) return false;
        if (m.bestOf == 0 || m.bestOf % 2 == 0 || m.bestOf > 7) return false;
        bytes32 d = _matchDigest(m);
        return SignatureChecker.isValidSignatureNow(m.playerA, d, sigA) && SignatureChecker.isValidSignatureNow(m.playerB, d, sigB);
    }

    function _checkMatch(Match calldata m, bytes calldata sigA, bytes calldata sigB) internal view {
        if (matchStatus[m.id] == SETTLED) revert AlreadySettled();
        if (m.playerA == m.playerB || m.playerA == address(0) || m.playerB == address(0)) revert BadMatch();
        if (m.stake < minStake || m.stake > maxStake) revert StakeOutOfRange();
        if (m.bestOf == 0 || m.bestOf % 2 == 0 || m.bestOf > 7) revert BadMatch();
        bytes32 d = _matchDigest(m);
        if (!SignatureChecker.isValidSignatureNow(m.playerA, d, sigA)) revert BadSignature();
        if (!SignatureChecker.isValidSignatureNow(m.playerB, d, sigB)) revert BadSignature();
    }

    /// @dev Moves `stake` loser → winner. Balances are not locked per match (that would
    ///      cost gas per match), so a loser may hold less than `stake`; we pay what exists
    ///      and emit Shortfall. The server never pairs a player without a free stake, and
    ///      withdrawals are delayed, so this is a last-resort accounting event.
    function _apply(Match calldata m, address winner, bool disputed) internal {
        matchStatus[m.id] = SETTLED;
        if (winner != address(0)) {
            address loser = winner == m.playerA ? m.playerB : m.playerA;
            uint256 have = balanceOf[loser];
            uint256 pay = have < m.stake ? have : m.stake;
            if (pay < m.stake) emit Shortfall(m.id, loser, m.stake, pay);
            balanceOf[loser] = have - pay;
            balanceOf[winner] += pay;
        }
        emit Settled(m.id, m.playerA, m.playerB, winner, m.stake, disputed);
    }

    /// @dev Replays a match from signed commits and plain reveals.
    ///      Per round: missing commit → forfeit by the player who did not commit (if the
    ///      other did); both committed but one reveal missing → forfeit by the non-revealer;
    ///      both revealed → scored (ties replay as the next round); neither committed or
    ///      neither revealed → match stops, higher score wins, equal score → draw.
    /// @dev `complete` is true only when the match was decided by score through fully revealed
    ///         rounds (no forfeit, no abandonment) — the only outcome that may settle instantly.
    function _replay(Match calldata m, SignedCommit[] calldata commits, Reveal[] calldata reveals)
        internal
        view
        returns (address winner, uint32 evidence, bool complete)
    {
        uint8 need = m.bestOf / 2 + 1;
        uint8 scoreA;
        uint8 scoreB;
        for (uint8 r = 1; r <= MAX_ROUNDS; r++) {
            (bool okA, bytes32 hA) = _findCommit(m, commits, r, m.playerA);
            (bool okB, bytes32 hB) = _findCommit(m, commits, r, m.playerB);
            if (okA) evidence++;
            if (okB) evidence++;
            if (!okA && !okB) break;
            if (okA != okB) return (okA ? m.playerA : m.playerB, evidence, false);
            uint8 mvA = _findReveal(m, reveals, r, m.playerA, hA);
            uint8 mvB = _findReveal(m, reveals, r, m.playerB, hB);
            if (mvA != 0) evidence++;
            if (mvB != 0) evidence++;
            if (mvA == 0 && mvB == 0) break;
            if ((mvA == 0) != (mvB == 0)) return (mvA != 0 ? m.playerA : m.playerB, evidence, false);
            if (_beats(mvA, mvB)) scoreA++;
            else if (_beats(mvB, mvA)) scoreB++;
            if (scoreA == need) return (m.playerA, evidence, true);
            if (scoreB == need) return (m.playerB, evidence, true);
        }
        if (scoreA > scoreB) return (m.playerA, evidence, false);
        if (scoreB > scoreA) return (m.playerB, evidence, false);
        return (address(0), evidence, false);
    }

    function _findCommit(Match calldata m, SignedCommit[] calldata commits, uint8 round, address player)
        internal
        view
        returns (bool ok, bytes32 hash)
    {
        for (uint256 i = 0; i < commits.length; i++) {
            SignedCommit calldata c = commits[i];
            if (c.round != round || c.player != player) continue;
            bytes32 d = _hashTypedDataV4(keccak256(abi.encode(COMMIT_TYPEHASH, m.id, round, c.hash)));
            if (!SignatureChecker.isValidSignatureNow(player, d, c.sig)) continue;
            bytes32 ack = _hashTypedDataV4(keccak256(abi.encode(COMMIT_ACK_TYPEHASH, m.id, round, player, c.hash)));
            if (SignatureChecker.isValidSignatureNow(operator, ack, c.opSig)) return (true, c.hash);
        }
        return (false, bytes32(0));
    }

    function _findReveal(Match calldata m, Reveal[] calldata reveals, uint8 round, address player, bytes32 hash)
        internal
        view
        returns (uint8 move)
    {
        for (uint256 i = 0; i < reveals.length; i++) {
            Reveal calldata rv = reveals[i];
            if (rv.round != round || rv.player != player || rv.move == 0 || rv.move > 3) continue;
            if (keccak256(abi.encodePacked(m.id, round, player, rv.move, rv.salt)) != hash) continue;
            bytes32 ack = _hashTypedDataV4(keccak256(abi.encode(REVEAL_ACK_TYPEHASH, m.id, round, player, rv.move, rv.salt)));
            if (SignatureChecker.isValidSignatureNow(operator, ack, rv.opSig)) return rv.move;
        }
        return 0;
    }

    function _beats(uint8 a, uint8 b) internal pure returns (bool) {
        return (a == 1 && b == 3) || (a == 2 && b == 1) || (a == 3 && b == 2);
    }
}
