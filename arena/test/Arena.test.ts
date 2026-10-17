import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { PatoliArena, MockUSD } from "../typechain-types";

const USD = (n: number) => BigInt(Math.round(n * 1e6));
const ROCK = 1, PAPER = 2, SCISSORS = 3;

type Match = { id: string; playerA: string; playerB: string; stake: bigint; bestOf: number; deadline: bigint };

describe("PatoliArena", () => {
  let arena: PatoliArena;
  let usd: MockUSD;
  let owner: HardhatEthersSigner, a: HardhatEthersSigner, b: HardhatEthersSigner, relayer: HardhatEthersSigner, vault: HardhatEthersSigner, op: HardhatEthersSigner;
  let domain: { name: string; version: string; chainId: bigint; verifyingContract: string };

  const MatchTypes = {
    Match: [
      { name: "id", type: "bytes32" },
      { name: "playerA", type: "address" },
      { name: "playerB", type: "address" },
      { name: "stake", type: "uint256" },
      { name: "bestOf", type: "uint8" },
      { name: "deadline", type: "uint64" },
    ],
  };
  const ResultTypes = { Result: [{ name: "matchId", type: "bytes32" }, { name: "winner", type: "address" }] };
  const CommitTypes = { Commit: [{ name: "matchId", type: "bytes32" }, { name: "round", type: "uint8" }, { name: "hash", type: "bytes32" }] };
  const CommitAckTypes = {
    CommitAck: [
      { name: "matchId", type: "bytes32" },
      { name: "round", type: "uint8" },
      { name: "player", type: "address" },
      { name: "hash", type: "bytes32" },
    ],
  };
  const RevealAckTypes = {
    RevealAck: [
      { name: "matchId", type: "bytes32" },
      { name: "round", type: "uint8" },
      { name: "player", type: "address" },
      { name: "move", type: "uint8" },
      { name: "salt", type: "bytes32" },
    ],
  };
  const WithdrawTypes = {
    Withdraw: [
      { name: "player", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const now = async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const warp = async (s: number) => {
    await network.provider.send("evm_increaseTime", [s]);
    await network.provider.send("evm_mine");
  };

  async function newMatch(stake = USD(1), bestOf = 3, ttl = 600): Promise<{ m: Match; sigA: string; sigB: string }> {
    const m: Match = { id: ethers.hexlify(ethers.randomBytes(32)), playerA: a.address, playerB: b.address, stake, bestOf, deadline: (await now()) + BigInt(ttl) };
    const sigA = await a.signTypedData(domain, MatchTypes, m);
    const sigB = await b.signTypedData(domain, MatchTypes, m);
    return { m, sigA, sigB };
  }
  const signResult = (s: HardhatEthersSigner, matchId: string, winner: string) => s.signTypedData(domain, ResultTypes, { matchId, winner });
  const salt = () => ethers.hexlify(ethers.randomBytes(32));
  const chash = (matchId: string, round: number, player: string, move: number, s: string) =>
    ethers.solidityPackedKeccak256(["bytes32", "uint8", "address", "uint8", "bytes32"], [matchId, round, player, move, s]);
  /** A move the operator acknowledged in time (acked = true) or a late/fabricated one (acked = false). */
  async function commit(s: HardhatEthersSigner, matchId: string, round: number, move: number, acked = true) {
    const st = salt();
    const hash = chash(matchId, round, s.address, move, st);
    const sig = await s.signTypedData(domain, CommitTypes, { matchId, round, hash });
    const opSig = acked ? await op.signTypedData(domain, CommitAckTypes, { matchId, round, player: s.address, hash }) : "0x";
    const rOpSig = acked ? await op.signTypedData(domain, RevealAckTypes, { matchId, round, player: s.address, move, salt: st }) : "0x";
    return { signed: { round, player: s.address, hash, sig, opSig }, reveal: { round, player: s.address, move, salt: st, opSig: rOpSig } };
  }

  beforeEach(async () => {
    [owner, a, b, relayer, vault, op] = await ethers.getSigners();
    usd = (await (await ethers.getContractFactory("MockUSD")).deploy()) as unknown as MockUSD;
    arena = (await (await ethers.getContractFactory("PatoliArena")).deploy(await usd.getAddress(), owner.address, op.address, USD(0.5), USD(20))) as unknown as PatoliArena;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    domain = { name: "PatoliArena", version: "1", chainId, verifyingContract: await arena.getAddress() };
    for (const s of [a, b]) {
      await usd.mint(s.address, USD(100));
      await usd.connect(s).approve(await arena.getAddress(), ethers.MaxUint256);
      await arena.connect(s).deposit(USD(10), s.address);
    }
  });

  it("deposits credit the beneficiary, not the sender", async () => {
    await usd.mint(vault.address, USD(5));
    await usd.connect(vault).approve(await arena.getAddress(), USD(5));
    await arena.connect(vault).deposit(USD(5), a.address);
    expect(await arena.balanceOf(a.address)).to.equal(USD(15));
    expect(await arena.balanceOf(vault.address)).to.equal(0n);
  });

  it("settles the happy path: both sign the result, stake moves loser → winner, anyone may submit", async () => {
    const { m, sigA, sigB } = await newMatch(USD(1));
    const rA = await signResult(a, m.id, a.address);
    const rB = await signResult(b, m.id, a.address);
    await expect(arena.connect(relayer).settle(m, sigA, sigB, a.address, rA, rB)).to.emit(arena, "Settled");
    expect(await arena.balanceOf(a.address)).to.equal(USD(11));
    expect(await arena.balanceOf(b.address)).to.equal(USD(9));
    await expect(arena.settle(m, sigA, sigB, a.address, rA, rB)).to.be.revertedWithCustomError(arena, "AlreadySettled");
  });

  it("rejects a forged result or a forged match", async () => {
    const { m, sigA, sigB } = await newMatch();
    const rA = await signResult(a, m.id, a.address);
    const rRelayer = await signResult(relayer, m.id, a.address);
    await expect(arena.settle(m, sigA, sigB, a.address, rA, rRelayer)).to.be.revertedWithCustomError(arena, "BadSignature");
    const forged = { ...m, stake: USD(5) }; // server bumps the stake
    await expect(arena.settle(forged, sigA, sigB, a.address, rA, rA)).to.be.revertedWithCustomError(arena, "BadSignature");
    await expect(arena.settle({ ...m, stake: USD(50) }, sigA, sigB, a.address, rA, rA)).to.be.revertedWithCustomError(arena, "StakeOutOfRange");
  });

  it("draw moves nothing", async () => {
    const { m, sigA, sigB } = await newMatch();
    const z = ethers.ZeroAddress;
    await arena.settle(m, sigA, sigB, z, await signResult(a, m.id, z), await signResult(b, m.id, z));
    expect(await arena.balanceOf(a.address)).to.equal(USD(10));
    expect(await arena.balanceOf(b.address)).to.equal(USD(10));
  });

  it("settleBatch skips bad items and applies good ones", async () => {
    const g = await newMatch(USD(2));
    const bad = await newMatch(USD(2));
    const items = [
      { m: g.m, sigA: g.sigA, sigB: g.sigB, winner: b.address, resSigA: await signResult(a, g.m.id, b.address), resSigB: await signResult(b, g.m.id, b.address) },
      { m: bad.m, sigA: bad.sigA, sigB: bad.sigB, winner: b.address, resSigA: await signResult(a, bad.m.id, b.address), resSigB: await signResult(relayer, bad.m.id, b.address) },
    ];
    await arena.connect(relayer).settleBatch(items);
    expect(await arena.balanceOf(b.address)).to.equal(USD(12));
    expect(await arena.matchStatus(g.m.id)).to.equal(1n);
    expect(await arena.matchStatus(bad.m.id)).to.equal(0n);
  });

  it("shortfall: pays what the loser has and emits", async () => {
    const { m, sigA, sigB } = await newMatch(USD(10));
    await arena.connect(b).requestWithdraw(USD(9.5), b.address); // b pulls most funds mid-match
    await expect(arena.settle(m, sigA, sigB, a.address, await signResult(a, m.id, a.address), await signResult(b, m.id, a.address)))
      .to.emit(arena, "Shortfall")
      .withArgs(m.id, b.address, USD(10), USD(0.5));
    expect(await arena.balanceOf(a.address)).to.equal(USD(10.5));
  });

  describe("withdrawals", () => {
    it("self-service path waits for the delay and needs no one's permission", async () => {
      await arena.connect(a).requestWithdraw(USD(4), vault.address);
      await expect(arena.finalizeWithdraw(a.address)).to.be.revertedWithCustomError(arena, "TooEarly");
      await warp(3601);
      await arena.connect(relayer).finalizeWithdraw(a.address);
      expect(await usd.balanceOf(vault.address)).to.equal(USD(4));
      expect(await arena.balanceOf(a.address)).to.equal(USD(6));
    });

    it("cancel puts the funds back", async () => {
      await arena.connect(a).requestWithdraw(USD(4), vault.address);
      await arena.connect(a).cancelWithdraw();
      expect(await arena.balanceOf(a.address)).to.equal(USD(10));
    });

    it("withdrawWithSig is instant, relayable, single-use", async () => {
      const deadline = (await now()) + 300n;
      const v = { player: a.address, to: vault.address, amount: USD(3), nonce: 0n, deadline };
      const sig = await a.signTypedData(domain, WithdrawTypes, v);
      await arena.connect(relayer).withdrawWithSig(a.address, vault.address, USD(3), deadline, sig);
      expect(await usd.balanceOf(vault.address)).to.equal(USD(3));
      await expect(arena.connect(relayer).withdrawWithSig(a.address, vault.address, USD(3), deadline, sig)).to.be.revertedWithCustomError(arena, "BadSignature");
    });
  });

  describe("dispute path", () => {
    it("opponent vanished after both committed: the revealer wins after the window", async () => {
      const { m, sigA, sigB } = await newMatch(USD(1), 3, 60);
      const cA = await commit(a, m.id, 1, ROCK);
      const cB = await commit(b, m.id, 1, SCISSORS);
      await expect(arena.connect(a).claim(m, sigA, sigB, [cA.signed, cB.signed], [cA.reveal])).to.be.revertedWithCustomError(arena, "TooEarly");
      await warp(61);
      await arena.connect(a).claim(m, sigA, sigB, [cA.signed, cB.signed], [cA.reveal]);
      await expect(arena.finalize(m, sigA, sigB)).to.be.revertedWithCustomError(arena, "TooEarly");
      await warp(24 * 3600 + 1);
      await arena.finalize(m, sigA, sigB);
      expect(await arena.balanceOf(a.address)).to.equal(USD(11));
    });

    it("hiding the opponent's artifacts is beaten by a counter-claim with more evidence", async () => {
      const { m, sigA, sigB } = await newMatch(USD(1), 3, 60);
      // full best-of-3 played: b wins 2-0
      const r1a = await commit(a, m.id, 1, ROCK), r1b = await commit(b, m.id, 1, PAPER);
      const r2a = await commit(a, m.id, 2, SCISSORS), r2b = await commit(b, m.id, 2, ROCK);
      await warp(61);
      // a lies: presents only round 1 commits + own reveal → "b never revealed" → a would win
      await arena.connect(a).claim(m, sigA, sigB, [r1a.signed, r1b.signed], [r1a.reveal]);
      let c = await arena.claims(m.id);
      expect(c.winner).to.equal(a.address);
      // b answers with everything
      await arena.connect(b).claim(m, sigA, sigB, [r1a.signed, r1b.signed, r2a.signed, r2b.signed], [r1a.reveal, r1b.reveal, r2a.reveal, r2b.reveal]);
      c = await arena.claims(m.id);
      expect(c.winner).to.equal(b.address);
      // a cannot re-claim with less
      await expect(arena.connect(a).claim(m, sigA, sigB, [r1a.signed, r1b.signed], [r1a.reveal])).to.be.revertedWithCustomError(arena, "WeakerClaim");
      await warp(24 * 3600 + 1);
      await arena.finalize(m, sigA, sigB);
      expect(await arena.balanceOf(b.address)).to.equal(USD(11));
    });

    it("nobody played → draw, nothing moves; anyone (e.g. the operator) may file the claim", async () => {
      const { m, sigA, sigB } = await newMatch(USD(1), 3, 60);
      await warp(61);
      await arena.connect(relayer).claim(m, sigA, sigB, [], []);
      await warp(24 * 3600 + 1);
      await arena.finalize(m, sigA, sigB);
      expect(await arena.balanceOf(a.address)).to.equal(USD(10));
      expect(await arena.balanceOf(b.address)).to.equal(USD(10));
    });

    it("a commit signed late (no operator ack) is ignored: the loser cannot rewrite a forfeit", async () => {
      const { m, sigA, sigB } = await newMatch(USD(1), 3, 60);
      const cA = await commit(a, m.id, 1, ROCK); // a played in time
      await warp(61);
      // operator files for a: only a committed in round 1 → b forfeits
      await arena.connect(relayer).claim(m, sigA, sigB, [cA.signed], [cA.reveal]);
      expect((await arena.claims(m.id)).winner).to.equal(a.address);
      // b fabricates a commit + reveal now (knowing nothing was revealed on-chain yet is irrelevant: no ack)
      const late = await commit(b, m.id, 1, PAPER, false);
      await expect(arena.connect(b).claim(m, sigA, sigB, [cA.signed, late.signed], [cA.reveal, late.reveal])).to.be.revertedWithCustomError(arena, "WeakerClaim");
      await warp(24 * 3600 + 1);
      await arena.finalize(m, sigA, sigB);
      expect(await arena.balanceOf(a.address)).to.equal(USD(11));
    });

    it("tie rounds don't count; score decides", async () => {
      const { m, sigA, sigB } = await newMatch(USD(1), 3, 60);
      const t1a = await commit(a, m.id, 1, ROCK), t1b = await commit(b, m.id, 1, ROCK); // tie
      const r2a = await commit(a, m.id, 2, PAPER), r2b = await commit(b, m.id, 2, ROCK); // a
      const r3a = await commit(a, m.id, 3, SCISSORS), r3b = await commit(b, m.id, 3, PAPER); // a → 2-0
      await warp(61);
      const commits = [t1a, t1b, r2a, r2b, r3a, r3b].map((x) => x.signed);
      const reveals = [t1a, t1b, r2a, r2b, r3a, r3b].map((x) => x.reveal);
      await arena.connect(b).claim(m, sigA, sigB, commits, reveals);
      expect((await arena.claims(m.id)).winner).to.equal(a.address);
    });
  });

  describe("admin", () => {
    it("owner cannot touch balances or the escrow token", async () => {
      await expect(arena.rescue(await usd.getAddress(), owner.address, 1n)).to.be.revertedWithCustomError(arena, "EscrowToken");
      await expect(arena.connect(a).setLimits(1n, 2n)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    });
    it("pausing deposits never blocks withdrawals or settlement", async () => {
      await arena.setDepositsPaused(true);
      await expect(arena.connect(a).deposit(USD(1), a.address)).to.be.revertedWithCustomError(arena, "Paused");
      await arena.connect(a).requestWithdraw(USD(1), a.address);
      const { m, sigA, sigB } = await newMatch();
      await arena.settle(m, sigA, sigB, b.address, await signResult(a, m.id, b.address), await signResult(b, m.id, b.address));
      expect(await arena.balanceOf(b.address)).to.equal(USD(11));
    });
  });
});
