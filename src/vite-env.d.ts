/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DARKGAME_ADDRESS?: `0x${string}`;
  readonly VITE_DEFAULT_CHAIN_ID?: string;
  readonly VITE_SEPOLIA_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  ethereum?: import("viem").EIP1193Provider;
}
