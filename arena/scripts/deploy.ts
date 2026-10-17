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

  // operator = deployer for now (same key as ARENA_OPERATOR_KEY in the app); owner → multisig later
  const arena = await (await ethers.getContractFactory("PatoliArena")).deploy(token, deployer.address, deployer.address, USD(0.5), USD(20));
  await arena.waitForDeployment();
  const address = await arena.getAddress();
  const receipt = await arena.deploymentTransaction()?.wait();
  console.log(`PatoliArena ${address} (block ${receipt?.blockNumber})`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    arena: address,
    token,
    owner: deployer.address,
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
      await run("verify:verify", { address, constructorArguments: [token, deployer.address, deployer.address, USD(0.5), USD(20)] });
    } catch (e) {
      console.warn("verify failed (retry later with `hardhat verify`):", (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
