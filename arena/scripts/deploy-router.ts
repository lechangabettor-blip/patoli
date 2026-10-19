import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Deploys ArenaDepositRouter for the Arena recorded in deployments/<network>.json. Stateless, no owner. */
async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8")) as { arena: string; token: string; router?: string };
  const [deployer] = await ethers.getSigners();
  console.log(`network=${network.name} deployer=${deployer.address} arena=${dep.arena} token=${dep.token}`);
  const router = await (await ethers.getContractFactory("ArenaDepositRouter")).deploy(dep.token, dep.arena);
  await router.waitForDeployment();
  const address = await router.getAddress();
  console.log(`ArenaDepositRouter ${address}`);
  fs.writeFileSync(file, JSON.stringify({ ...dep, router: address, routerDeployedAt: new Date().toISOString() }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
