# DarkGame Roadmap

## Completed in this build

- Production scaffold with React, TypeScript, Vite, Hardhat, CoFHE, and viem.
- Encrypted two-player high-card table contract with room creation, joining, buy-ins, bounded two-party encrypted shuffle-share dealing, no-duplicate card assignment, exact stake-backed betting actions, fold settlement, active/reveal timeout recovery, encrypted winner computation, split-pot tie handling, threshold-proof settlement, and pull-payment withdrawals.
- Private hand viewing through CoFHE permits and `decryptForView`.
- Public result settlement through `decryptForTx` plus `FHE.verifyDecryptResult`.
- Local and Sepolia deployment scripts with non-committed environment configuration.
- End-to-end contract tests covering create, join, encrypted shuffle submission, bounded dealing, decrypt, exact betting, settle, split-pot ties, withdraw, fold, cancel, invalid actions, and timeout flows.
- Responsive app UI with lobby, table, private hand area, exact action dock, reveal timeout and withdraw controls, and on-chain state inspector.
- Final Wave 5 app shell with separate home, lobby, room, game, and protocol pages.
- Production deep-link support for room and game routes through Vercel SPA rewrites.
- Sepolia deployment and live smoke covering create, join, deal, check/check, decrypt winner, settle, and withdraw.
- Event-indexed `GameCreated` reads from the deployment block, with a latest-table fallback for public RPC limits.
- CI workflow for compile/test/build, Vercel preview deployments, and manual Sepolia contract deployments.

## External production gates

- Native CoFHE RNG should replace shuffle shares only after the local mock and target network both support `FHE.randomEuint8()` end to end. The current installed Hardhat mock reverts random tasks, so the verified production path remains two-party encrypted shuffle entropy.
- Formal audits for payout, ACL, settlement, and randomness assumptions require an independent security reviewer; this repo is audit-ready, not externally audited.

## Post-MVP expansion

- Tournament queues, player profiles, ranked progression, and richer match analytics are product extensions on top of the production high-card table flow.
