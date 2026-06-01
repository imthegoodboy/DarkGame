import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";
import { Encryptable, FheTypes, type CofheClient } from "@cofhe/sdk";
import { chains as cofheChains } from "@cofhe/sdk/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const BUY_IN = hre.ethers.parseEther("0.0001");
const GAS_PRICE_SAFETY_MULTIPLIER = 2n;
const TEMP_WALLET_GAS_UNITS =
  350_000n + // joinGame
  1_200_000n + // submitShuffleEntropy
  650_000n + // act
  150_000n + // optional withdraw
  21_000n + // sweep remaining balance
  1_000_000n; // buffer for fee spikes
const DEPLOYER_SMOKE_GAS_UNITS =
  21_000n + // optional temp-wallet funding
  350_000n + // createGame
  1_200_000n + // submitShuffleEntropy
  10_000_000n + // dealHands
  650_000n + // act
  800_000n + // settleEncryptedWinner
  150_000n + // optional withdraw
  2_000_000n; // buffer for fee spikes and cleanup

function gasBudget(gasPrice: bigint, gasUnits: bigint) {
  return gasPrice * gasUnits * GAS_PRICE_SAFETY_MULTIPLIER;
}

function tempWalletFundingForGas(gasPrice: bigint) {
  return BUY_IN + gasBudget(gasPrice, TEMP_WALLET_GAS_UNITS);
}

async function waitFor(txPromise: Promise<any>, label: string) {
  const tx = await txPromise;
  console.log(`${label}: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} failed`);
  }
  return receipt;
}

async function encryptEntropy(client: CofheClient, values: number[]) {
  return client
    .encryptInputs(values.map((value) => Encryptable.uint8(BigInt(value))))
    .execute();
}

async function createSepoliaCofheClient(privateKey: string) {
  const normalizedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(normalizedKey as Hex);
  const rpcUrl = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const cofheClient = createCofheClient(
    createCofheConfig({
      supportedChains: [cofheChains.sepolia],
      useWorkers: false,
    })
  );

  await cofheClient.connect(publicClient as never, walletClient as never);
  await cofheClient.permits.getOrCreateSelfPermit();
  return cofheClient;
}

async function withdrawIfPending(contract: any, signer: any, label: string) {
  const amount = await contract.pendingWithdrawals(await signer.getAddress());
  if (amount > 0n) {
    await waitFor(contract.connect(signer).withdraw({ gasLimit: 150_000n }), label);
  }
}

async function sweepTempWallet(tempWallet: any, recipient: string) {
  try {
    const balance = await hre.ethers.provider.getBalance(tempWallet.address);
    const feeData = await hre.ethers.provider.getFeeData();
    const maxFeePerGas =
      (feeData.maxFeePerGas ?? feeData.gasPrice ?? hre.ethers.parseUnits("2", "gwei")) *
      GAS_PRICE_SAFETY_MULTIPLIER;
    const gasCost = maxFeePerGas * 21_000n;
    if (balance <= gasCost) return;

    await waitFor(
      tempWallet.sendTransaction({
        to: recipient,
        value: balance - gasCost,
        gasLimit: 21_000n,
        maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
      }),
      "Sweep temp wallet"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Sweep temp wallet skipped: ${message}`);
  }
}

async function cleanupOpenTables(contract: any, deployer: any) {
  const deployerAddress = await deployer.getAddress();
  const nextGameId = await contract.nextGameId();
  for (let id = nextGameId - 1n; id > 0n && id + 20n > nextGameId; id -= 1n) {
    const game = await contract.getPublicGame(id);
    if (
      game.status === 1n &&
      game.playerOne.toLowerCase() === deployerAddress.toLowerCase()
    ) {
      await waitFor(
        contract.cancelOpenGame(id, { gasLimit: 250_000n }),
        `Cancel open table #${id.toString()}`
      );
    }
  }
}

async function assertDeployerCanRunSmoke(deployer: any, tempWalletFunding: bigint) {
  const deployerAddress = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddress);
  const feeData = await hre.ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? hre.ethers.parseUnits("2", "gwei");
  const valueRequired = BUY_IN + tempWalletFunding;
  const required = valueRequired + gasBudget(gasPrice, DEPLOYER_SMOKE_GAS_UNITS);

  if (balance < required) {
    throw new Error(
      `The deployer needs about ${hre.ethers.formatEther(
        required
      )} Sepolia ETH for the encrypted smoke at the current gas price; balance is ${hre.ethers.formatEther(
        balance
      )} ETH.`
    );
  }
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const metadataPath = path.join(process.cwd(), "deployments", "11155111.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { address: string };
  const darkGame = await hre.ethers.getContractAt("DarkGame", metadata.address, deployer);

  await cleanupOpenTables(darkGame, deployer);

  const secondPrivateKey = process.env.SECOND_PRIVATE_KEY;
  const tempWallet = secondPrivateKey
    ? new hre.ethers.Wallet(
        secondPrivateKey.startsWith("0x") ? secondPrivateKey : `0x${secondPrivateKey}`,
        hre.ethers.provider
      )
    : hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  console.log(`Smoke contract: ${metadata.address}`);
  console.log("Deployer: configured");
  console.log(secondPrivateKey ? "Second wallet: configured" : "Second wallet: temporary");

  if (!process.env.PRIVATE_KEY) {
    throw new Error("Set PRIVATE_KEY for the deployer before running the smoke test.");
  }
  const feeData = await hre.ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? hre.ethers.parseUnits("2", "gwei");
  const tempWalletFunding = secondPrivateKey ? 0n : tempWalletFundingForGas(gasPrice);
  await assertDeployerCanRunSmoke(deployer, tempWalletFunding);
  const aliceClient = await createSepoliaCofheClient(process.env.PRIVATE_KEY);
  const bobClient = await createSepoliaCofheClient(tempWallet.privateKey);
  let tempFunded = false;

  try {
    if (!secondPrivateKey) {
      await waitFor(
        deployer.sendTransaction({
          to: tempWallet.address,
          value: tempWalletFunding,
          gasLimit: 21_000n,
        }),
        "Fund temp wallet"
      );
      tempFunded = true;
    }

    await waitFor(
      darkGame.createGame(BUY_IN, { value: BUY_IN, gasLimit: 350_000n }),
      "Create table"
    );
    const gameId = (await darkGame.nextGameId()) - 1n;
    await waitFor(
      darkGame.connect(tempWallet).joinGame(gameId, { value: BUY_IN, gasLimit: 350_000n }),
      "Join table"
    );

    const aliceEntropy = await encryptEntropy(aliceClient, [7, 19, 31, 43]);
    const bobEntropy = await encryptEntropy(bobClient, [11, 23, 17, 5]);
    await waitFor(
      darkGame.submitShuffleEntropy(gameId, aliceEntropy, { gasLimit: 1_200_000n }),
      "Alice shuffle"
    );
    await waitFor(
      darkGame.connect(tempWallet).submitShuffleEntropy(gameId, bobEntropy, { gasLimit: 1_200_000n }),
      "Bob shuffle"
    );
    await waitFor(darkGame.dealHands(gameId, { gasLimit: 10_000_000n }), "Deal hands");

    const aliceCards = await darkGame.getPrivateHand(gameId);
    const bobCards = await darkGame.connect(tempWallet).getPrivateHand(gameId);
    const dealtCards = await Promise.all([
      aliceClient.decryptForView(aliceCards[0], FheTypes.Uint8).execute(),
      aliceClient.decryptForView(aliceCards[1], FheTypes.Uint8).execute(),
      bobClient.decryptForView(bobCards[0], FheTypes.Uint8).execute(),
      bobClient.decryptForView(bobCards[1], FheTypes.Uint8).execute(),
    ]);
    const uniqueCards = new Set(dealtCards.map((card) => card.toString()));
    if (uniqueCards.size !== 4 || dealtCards.some((card) => card < 0n || card > 51n)) {
      throw new Error(`Invalid dealt cards: ${dealtCards.join(", ")}`);
    }

    await waitFor(darkGame.act(gameId, 0, { gasLimit: 650_000n }), "Alice check");
    await waitFor(
      darkGame.connect(tempWallet).act(gameId, 0, { gasLimit: 650_000n }),
      "Bob check"
    );

    const winnerHandle = await darkGame.getWinnerHandle(gameId);
    const decryptResult = await aliceClient.decryptForTx(winnerHandle).withoutPermit().execute();
    const winnerSeatCode = Number(decryptResult.decryptedValue);
    await waitFor(
      darkGame.settleEncryptedWinner(gameId, winnerSeatCode, decryptResult.signature, {
        gasLimit: 800_000n,
      }),
      "Settle winner"
    );

    await withdrawIfPending(darkGame, deployer, "Withdraw deployer");
    await withdrawIfPending(darkGame, tempWallet, "Withdraw temp wallet");
    await sweepTempWallet(tempWallet, deployer.address);

    const finalGame = await darkGame.getPublicGame(gameId);
    console.log(`Smoke table: #${gameId.toString()}`);
    console.log(`Winner code: ${winnerSeatCode}`);
    console.log(`Final status: ${finalGame.status.toString()}`);
    console.log(`Final pot: ${hre.ethers.formatEther(finalGame.pot)} ETH`);
  } finally {
    if (tempFunded) {
      await sweepTempWallet(tempWallet, deployer.address).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
