# DarkGame Audit Scope

This file captures the production review scope for the current high-card MVP. It is not a replacement for an independent audit, but it gives reviewers the exact areas that must hold before higher-value games or tournament flows.

## In Scope

- `contracts/DarkGame.sol`
- CoFHE ACL grants for player hands, private scores, shuffle entropy, and public winner reveal.
- Pot accounting across create, join, bet, call, fold, timeout, tie, settlement, and withdrawal.
- Encrypted shuffle-share dealing and no-duplicate card assignment.
- Threshold decrypt proof verification for public winner settlement.
- Frontend transaction gating, wallet chain switching, private hand reveal, and indexed table discovery.

## Critical Invariants

- Contract balance must always cover the sum of active game pots plus queued withdrawals.
- Only seated wallets can read their private hand or score handles.
- A table cannot settle to a plaintext winner without `FHE.verifyDecryptResult` accepting the winner-code proof.
- Funds leave the contract only through pull-payment withdrawals.
- Active games must have a timeout path for stalled shuffle/deal, stalled turns, and stalled winner reveal.
- Fold and timeout settlement must zero the pot before queuing withdrawals.
- Split-pot ties must finish with `winner == address(0)` and no stranded pot.

## Known External Gate

CoFHE documents native encrypted randomness through `FHE.randomEuint8()`, but the installed Hardhat mock currently reverts random tasks. DarkGame therefore keeps the tested two-party encrypted shuffle-share path until both local mocks and the target network support the native RNG path end to end.
