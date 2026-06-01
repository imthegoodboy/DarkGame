# DarkGame

DarkGame is a privacy-first on-chain high-card game built for the Fhenix Wavehack. It uses Fhenix CoFHE so the contract can deal and compare encrypted cards while each player can decrypt only their own hand.

## Live Testnet App

- Frontend: https://darkgame-six.vercel.app
- Network: Ethereum Sepolia, chain ID `11155111`
- Contract: `0x8BB4Dcc8558E83DEfD4c447B0c44294d2AbA9167`
- Deployment block: `10968537`
- Deployment tx: `0x885defc7e44823c37daa46a28af6f4ec010871528839412f0a461b601be03d46`

The frontend is configured with `VITE_DARKGAME_ADDRESS` and `VITE_DARKGAME_START_BLOCK`, so the lobby can read indexed `GameCreated` logs from the current deployment instead of depending only on the latest table IDs.

## What Works Now

- Wallet connect and Sepolia chain switching.
- Create a buy-in table.
- Join from a second wallet.
- Submit encrypted shuffle entropy from both players.
- Deal no-duplicate encrypted card handles.
- Decrypt only your own private hand through CoFHE permits.
- Play check, bet, call, and fold actions.
- Enforce exact betting, turn order, and game status transitions.
- Compute the winner over encrypted card scores.
- Reveal only the winner code through `decryptForTx`.
- Verify the threshold decrypt proof on-chain with `FHE.verifyDecryptResult`.
- Settle winner or split-pot ties.
- Recover stalled hands, turns, and reveal states through timeouts.
- Withdraw winnings through pull payments.
- Navigate direct routes for `/`, `/lobby`, `/room/:id`, `/game/:id`, and `/protocol`.

## Wave Build Log

### Wave 1 - Foundation

- Created the React, TypeScript, Vite, Hardhat, Solidity, and CoFHE project scaffold.
- Added wallet connection, chain configuration, and Sepolia-ready environment variables.
- Built the first app shell with home, lobby, room, game, and protocol routes.
- Added Vercel SPA rewrites so direct room and game links work in production.

### Wave 2 - Core Contract

- Implemented `DarkGame.sol` for two-player high-card tables.
- Added table creation, joining, buy-in accounting, player seats, status tracking, and public game reads.
- Added player actions for check, bet, call, and fold.
- Moved payouts to pull withdrawals so settlement does not depend on pushing ETH during the game-ending transaction.

### Wave 3 - CoFHE Privacy

- Replaced plaintext card flow with encrypted card handles.
- Added player-only ACL grants for private cards and private score handles.
- Added CoFHE permit-based private hand viewing with `decryptForView`.
- Added encrypted winner computation and public winner-code reveal with `decryptForTx`.
- Added on-chain proof verification before settlement.

### Wave 4 - Fairness And Safety

- Removed the old public block-entropy draw path.
- Added two-party encrypted shuffle entropy so both players contribute private draw material.
- Bounded encrypted draw shares before card assignment.
- Added no-duplicate card assignment for the four dealt cards.
- Added strict invalid-action checks and exact call/bet validation.
- Added fold settlement, hand timeout recovery, turn timeout recovery, and reveal timeout recovery.
- Added split-pot tie handling.

### Wave 5 - Product UX

- Built the playable table UI with private hand area, opponent hidden cards, pot display, status chips, timers, and action dock.
- Added room inspector panels for seats, stakes, status, deadlines, contract address, and withdrawal state.
- Added responsive mobile layout fixes for the game table.
- Added a richer home page with live chain status, private-table flow, and production safeguard summaries.
- Added a favicon and browser metadata for a more finished production feel.

### Final Hardening

- Added event-indexed historical table reads from the deployment block.
- Added deployment metadata with transaction hash and block number.
- Added `docs/AUDIT_SCOPE.md` with invariants for payout, ACL, settlement, and randomness review.
- Added GitHub Actions CI for compile, tests, build, Vercel previews, and manual Sepolia deploys.
- Added `scripts/smoke-sepolia.ts` for full testnet smoke runs when the deployer has enough Sepolia ETH.
- Verified the app with compile, 8 CoFHE contract tests, and production build.

## Verified Locally

Run the full verification suite:

```bash
npm run verify:app
```

Current suite:

- Hardhat compile.
- 8 CoFHE contract tests.
- Vite production build.

The tests cover create, join, encrypted shuffle submission, no-duplicate dealing, private reads, invalid actions, exact betting, winner reveal, proof-gated settlement, split-pot ties, withdrawals, fold settlement, cancel flow, hand timeout, turn timeout, and reveal timeout.

## Run Locally

```bash
npm install
npm run verify:app
npm run dev
```

Create `.env.local` from `.env.example`:

```bash
VITE_DARKGAME_ADDRESS=0x8BB4Dcc8558E83DEfD4c447B0c44294d2AbA9167
VITE_DARKGAME_START_BLOCK=10968537
VITE_DEFAULT_CHAIN_ID=11155111
VITE_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

Never commit real private keys. Use throwaway testnet keys only.

## Deploy Contract

```bash
PRIVATE_KEY=0xYOUR_TESTNET_PRIVATE_KEY npm run deploy:sepolia
```

The deploy script writes `deployments/11155111.json` with the contract address, transaction hash, block number, and timestamp.

After deploying, update:

- `.env.local`
- `.env.example`
- Vercel production env `VITE_DARKGAME_ADDRESS`
- Vercel production env `VITE_DARKGAME_START_BLOCK`

## Testnet Smoke

```bash
PRIVATE_KEY=0xDEPLOYER_KEY npm run smoke:sepolia
```

For the full encrypted deal smoke, the deployer must have enough Sepolia ETH because `dealHands` is gas-heavy. The script can also use a funded second wallet:

```bash
PRIVATE_KEY=0xDEPLOYER_KEY SECOND_PRIVATE_KEY=0xSECOND_TEST_WALLET npm run smoke:sepolia
```

The smoke script estimates the deployer's required gas and value before sending transactions. When funded, it creates a tiny table, funds or uses a second wallet, joins, submits encrypted entropy, deals, decrypts both private hands through the SDK, checks both turns, settles the encrypted winner, withdraws payouts, and cleans up temporary wallet funds where possible.

## Project Structure

```text
contracts/DarkGame.sol          Encrypted game contract
src/                            React/Vite frontend
src/contracts/darkGameAbi.ts    Frontend ABI
src/lib/                        Chain, card, and CoFHE helpers
scripts/deploy.ts               Sepolia/local deploy script
scripts/smoke-sepolia.ts        Full testnet smoke script
test/DarkGame.test.ts           CoFHE contract tests
deployments/11155111.json       Current Sepolia deployment metadata
docs/AUDIT_SCOPE.md             Audit scope and invariants
docs/ROADMAP.md                 Completed work and external gates
vercel.json                     SPA route rewrites
```

## Production Notes

DarkGame is ready as a Sepolia Wavehack MVP: the contract is deployed, the frontend is wired to testnet, the app builds, and the core encrypted flow is covered by tests.

Two items remain external production gates before high-value real-money use:

- Native CoFHE RNG: Fhenix documents `FHE.randomEuint8()`, but the installed Hardhat mock currently reverts random tasks, so the app keeps the tested two-party encrypted shuffle-share path until local and testnet support match end to end.
- Formal audit: payout, ACL, settlement, timeout, and randomness assumptions should be reviewed by an independent auditor before mainnet or larger-value games.
