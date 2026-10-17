import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const DEPLOYER = process.env.ARENA_DEPLOYER_KEY ? [process.env.ARENA_DEPLOYER_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 2000 }, evmVersion: "cancun", viaIR: true },
  },
  networks: {
    hardhat: {},
    amoy: {
      url: process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: DEPLOYER,
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL ?? "https://polygon.rpc.thirdweb.com",
      chainId: 137,
      accounts: DEPLOYER,
    },
  },
  etherscan: {
    apiKey: { polygon: process.env.POLYGONSCAN_API_KEY ?? "", polygonAmoy: process.env.POLYGONSCAN_API_KEY ?? "" },
  },
  gasReporter: { enabled: process.env.REPORT_GAS === "1", currency: "USD" },
};

export default config;
