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
  "struct SettleInput { Match m; bytes sigA; bytes sigB; address winner; bytes resSigA; bytes resSigB; }",
  "function settle(Match m, bytes sigA, bytes sigB, address winner, bytes resSigA, bytes resSigB)",
  "function settleBatch(SettleInput[] items)",
  "event Deposit(address indexed player, address indexed from, uint256 amount)",
  "event Withdraw(address indexed player, address indexed to, uint256 amount)",
  "event Settled(bytes32 indexed matchId, address indexed playerA, address indexed playerB, address winner, uint256 stake, bool disputed)",
]);
