import { deriveBeaconDepositWallet, deriveUupsDepositWallet } from "@polymarket/builder-relayer-client/dist/builder/derive";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";
import { POLYGON_CHAIN_ID } from "./constants";

/** Beacon used by Polymarket's deposit-wallet factory since the June-2026 upgrade (docs). */
const DEPOSIT_WALLET_BEACON = "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a";

/**
 * All deposit-wallet addresses an EOA could own (beacon proxy = current,
 * UUPS = pre-June-2026). Used server-side to verify a client's wallet claim
 * without needing a signer.
 */
function candidateDepositWallets(eoa: string): string[] {
  const cfg = getContractConfig(POLYGON_CHAIN_ID).DepositWalletContracts;
  const beacon = deriveBeaconDepositWallet(eoa, cfg.DepositWalletFactory, DEPOSIT_WALLET_BEACON);
  const uups = deriveUupsDepositWallet(eoa, cfg.DepositWalletFactory, cfg.DepositWalletImplementation);
  return [beacon.toLowerCase(), uups.toLowerCase()];
}

export function isOwnedDepositWallet(eoa: string, wallet: string): boolean {
  return candidateDepositWallets(eoa).includes(wallet.toLowerCase());
}
