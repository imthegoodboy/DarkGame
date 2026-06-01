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

## Next production hardening

- Add encrypted range proofs or native CoFHE RNG once the local mock and target network support the full path end to end.
- Add indexed backend reads for historical tables and match analytics.
- Add tournament queues, player profiles, and ranked progression.
- Add formal audits for payout, ACL, settlement, and randomness assumptions.
- Add CI deployment environments for testnet and frontend preview builds.
