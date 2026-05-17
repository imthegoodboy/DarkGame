# DarkGame Roadmap

## Completed in this build

- Production scaffold with React, TypeScript, Vite, Hardhat, CoFHE, and viem.
- Encrypted two-player poker table contract with room creation, joining, buy-ins, contract-owned no-duplicate dealing, exact stake-backed betting actions, fold settlement, timeout recovery, encrypted winner computation, threshold-proof settlement, and pull-payment withdrawals.
- Private hand viewing through CoFHE permits and `decryptForView`.
- Public result settlement through `decryptForTx` plus `FHE.verifyDecryptResult`.
- Local and Sepolia deployment scripts with non-committed environment configuration.
- End-to-end contract tests covering create, join, deal, decrypt, exact betting, settle, withdraw, fold, cancel, and timeout flows.
- Responsive app UI with lobby, table, private hand area, exact action dock, timeout and withdraw controls, and on-chain state inspector.
- Sepolia deployment and live smoke covering create, join, deal, check/check, decrypt winner, settle, and withdraw.

## Next production hardening

- Replace block-entropy dealing with a VRF-backed or FHE-native encrypted shuffle for high-value adversarial play.
- Add indexed backend reads for historical tables and match analytics.
- Add tournament queues, player profiles, and ranked progression.
- Add formal audits for payout, ACL, settlement, and randomness assumptions.
- Add CI deployment environments for testnet and frontend preview builds.
