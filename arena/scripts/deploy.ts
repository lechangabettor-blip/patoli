import { ethers, network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys PatoliArena.
 *  - polygon: escrow token = pUSD, owner = deployer (transfer to a hardware/multisig later),
 *    limits $0.50 – $20 per player per match (beta caps until external review).
 *  - amoy / hardhat: deploys MockUSD first and uses it.
 * Writes deployments/<network>.json consumed by the app.
 */
const PUSD_POLYGON = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const USD = (n: number) => BigInt(Math.round(n * 1e6));

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`network=${network.name} deployer=${deployer.address} balance=${ethers.formatEther(bal)} POL`);

  let token = PUSD_POLYGON;
  if (network.name !== "polygon") {
    const mock = await (await ethers.getContractFactory("MockUSD")).deploy();
    await mock.waitForDeployment();
    token = await mock.getAddress();
    console.log(`MockUSD ${token}`);
  }

  // operator = deployer (the server's hot key, ARENA_OPERATOR_KEY). Owner must be a SEPARATE cold
  // wallet / multisig on mainnet (ARENA_OWNER); same-key deploys are refused unless explicitly allowed.
  const owner = process.env.ARENA_OWNER && /^0x[0-9a-fA-F]{40}$/.test(process.env.ARENA_OWNER) ? process.env.ARENA_OWNER : deployer.address;
  if (network.name === "polygon" && owner.toLowerCase() === deployer.address.toLowerCase() && process.env.ALLOW_SAME_OWNER !== "1") {
    throw new Error("Refusing mainnet deploy with owner == operator. Set ARENA_OWNER to a cold wallet (or ALLOW_SAME_OWNER=1 for a beta you will hand over).");
  }
  const arena = await (await ethers.getContractFactory("PatoliArena")).deploy(token, owner, deployer.address, USD(0.5), USD(20));
  await arena.waitForDeployment();
  const address = await arena.getAddress();
  const receipt = await arena.deploymentTransaction()?.wait();
  console.log(`PatoliArena ${address} (block ${receipt?.blockNumber})`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    arena: address,
    token,
    owner,
    operator: deployer.address,
    deployedAt: new Date().toISOString(),
    block: receipt?.blockNumber ?? null,
    minStake: "0.5",
    maxStake: "20",
  };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), JSON.stringify(out, null, 2));

  if (process.env.POLYGONSCAN_API_KEY && network.name !== "hardhat") {
    console.log("verifying…");
    try {
      await run("verify:verify", { address, constructorArguments: [token, owner, deployer.address, USD(0.5), USD(20)] });
    } catch (e) {
      console.warn("verify failed (retry later with `hardhat verify`):", (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
