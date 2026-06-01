declare module "@cofhe/sdk/web" {
  import type { CofheClient, CofheConfig, CofheInputConfig } from "@cofhe/sdk";

  export function createCofheConfig(config: CofheInputConfig): CofheConfig;
  export function createCofheClient<TConfig extends CofheConfig>(
    config: TConfig
  ): CofheClient<TConfig>;
}
