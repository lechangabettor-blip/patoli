import { parseAbi } from "viem";

/** The slice of PatoliArena the app talks to. Full ABI: arena/artifacts after `npm run compile`. */
export const arenaAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function pendingWithdraw(address) view returns (uint256 amount, address to, uint64 readyAt)",
  "function matchStatus(bytes32) view returns (uint8)",
  "function minStake() view returns (uint256)",
  "function maxStake() view returns (uint256)",
  "function depositsPaused() view returns (bool)",
  "function deposit(uint256 amount, address beneficiary)",
  "function requestWithdraw(uint256 amount, address to)",
  "function finalizeWithdraw(address player)",
  "function withdrawWithSig(address player, address to, uint256 amount, uint256 deadline, bytes sig)",
  "struct Match { bytes32 id; address playerA; address playerB; uint256 stake; uint8 bestOf; uint64 deadline; }",
  "struct SignedCommit { uint8 round; address player; bytes32 hash; bytes sig; bytes opSig; }",
  "struct Reveal { uint8 round; address player; uint8 move; bytes32 salt; bytes opSig; }",
  "struct SettleInput { Match m; bytes sigA; bytes sigB; SignedCommit[] commits; Reveal[] reveals; }",
  "function settle(Match m, bytes sigA, bytes sigB, SignedCommit[] commits, Reveal[] reveals)",
  "function settleBatch(SettleInput[] items)",
  "function operator() view returns (address)",
  "function claim(Match m, bytes sigA, bytes sigB, SignedCommit[] commits, Reveal[] reveals)",
  "function finalize(Match m, bytes sigA, bytes sigB)",
  "function claims(bytes32) view returns (address claimant, address winner, uint32 evidence, uint64 finalizeAt)",
  "event Deposit(address indexed player, address indexed from, uint256 amount)",
  "event Withdraw(address indexed player, address indexed to, uint256 amount)",
  "event Settled(bytes32 indexed matchId, address indexed playerA, address indexed playerB, address winner, uint256 stake, bool disputed)",
]);

export const routerAbi = parseAbi([
  "function forwarderOf(address user) view returns (address)",
  "function sweep(address user) returns (uint256 amount)",
  "event Swept(address indexed user, address indexed forwarder, uint256 amount)",
]);
