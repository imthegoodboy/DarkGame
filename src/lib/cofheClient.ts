import { createCofheClient, createCofheConfig } from "@cofhe/sdk/web";
import { chains } from "@cofhe/sdk/chains";

const config = createCofheConfig({
  supportedChains: [chains.hardhat, chains.sepolia],
  useWorkers: false,
});

export const cofheClient = createCofheClient(config);
