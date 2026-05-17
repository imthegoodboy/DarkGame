import { hardhat, sepolia } from "viem/chains";
import type { Chain } from "viem";

export const supportedChains = [hardhat, sepolia] as const;

export function configuredChain(): Chain {
  const requested = Number(import.meta.env.VITE_DEFAULT_CHAIN_ID ?? hardhat.id);
  return supportedChains.find((chain) => chain.id === requested) ?? hardhat;
}

