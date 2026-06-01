import hre from "hardhat";
import { expect } from "chai";
import { CofheClient, Encryptable, FheTypes } from "@cofhe/sdk";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const BUY_IN = hre.ethers.parseEther("0.01");
const ACTION_STAKE = hre.ethers.parseEther("0.001");
const HAND_TIMEOUT = 20 * 60;
const ACTION_TIMEOUT = 20 * 60;
const REVEAL_TIMEOUT = 20 * 60;

describe("DarkGame", () => {
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let aliceClient: CofheClient;
  let bobClient: CofheClient;

  before(async () => {
    [alice, bob] = await hre.ethers.getSigners();
    aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    bobClient = await hre.cofhe.createClientWithBatteries(bob);
  });

  async function deployGame() {
    const Factory = await hre.ethers.getContractFactory("DarkGame");
    const contract = await Factory.deploy();
    await contract.waitForDeployment();
    return contract;
  }

  async function createJoinedGame(contract: any) {
    await expect(contract.connect(alice).createGame(BUY_IN, { value: BUY_IN }))
      .to.emit(contract, "GameCreated")
      .withArgs(1, alice.address, BUY_IN);

    await expect(contract.connect(bob).joinGame(1, { value: BUY_IN }))
      .to.emit(contract, "GameJoined");
  }

  async function encryptEntropy(client: CofheClient, values: number[]) {
    return client
      .encryptInputs(values.map((value) => Encryptable.uint8(BigInt(value))))
      .execute();
  }

  async function submitShuffleEntropy(contract: any) {
    const aliceEntropy = await encryptEntropy(aliceClient, [7, 19, 31, 43]);
    const bobEntropy = await encryptEntropy(bobClient, [11, 23, 17, 5]);

    await expect(contract.connect(alice).submitShuffleEntropy(1, aliceEntropy))
      .to.emit(contract, "ShuffleEntropySubmitted")
      .withArgs(1, alice.address);
    await expect(contract.connect(bob).submitShuffleEntropy(1, bobEntropy))
      .to.emit(contract, "ShuffleEntropySubmitted")
      .withArgs(1, bob.address);

    const game = await contract.getPublicGame(1);
    expect(game.playerOneShuffleReady).to.equal(true);
    expect(game.playerTwoShuffleReady).to.equal(true);
  }

  async function dealHands(contract: any) {
    await submitShuffleEntropy(contract);
    await expect(contract.connect(alice).dealHands(1)).to.emit(contract, "CardsDealt");

    const game = await contract.getPublicGame(1);
    expect(game.handCount).to.equal(2n);
    expect(game.playerOneHandDealt).to.equal(true);
    expect(game.playerTwoHandDealt).to.equal(true);
  }

  async function increaseTime(seconds: number) {
    await hre.network.provider.send("evm_increaseTime", [seconds]);
    await hre.network.provider.send("evm_mine");
  }

  it("deals contract-owned encrypted cards, enforces betting, reveals winner, and queues payout", async () => {
    const contract = await deployGame();
    await createJoinedGame(contract);
    await dealHands(contract);

    const aliceCards = await contract.connect(alice).getPrivateHand(1);
    const bobCards = await contract.connect(bob).getPrivateHand(1);

    const [aliceCard, aliceSecondCard, bobCard, bobSecondCard] = await Promise.all([
      aliceClient.decryptForView(aliceCards[0], FheTypes.Uint8).execute(),
      aliceClient.decryptForView(aliceCards[1], FheTypes.Uint8).execute(),
      bobClient.decryptForView(bobCards[0], FheTypes.Uint8).execute(),
      bobClient.decryptForView(bobCards[1], FheTypes.Uint8).execute(),
    ]);
    const dealtCards = [aliceCard, aliceSecondCard, bobCard, bobSecondCard];

    for (const card of dealtCards) {
      expect(card).to.be.at.least(0n);
      expect(card).to.be.at.most(51n);
    }
    expect(new Set(dealtCards.map((card) => card.toString())).size).to.equal(4);

    await contract.connect(alice).act(1, 1, { value: ACTION_STAKE });
    await expect(contract.connect(bob).act(1, 0)).to.be.revertedWithCustomError(
      contract,
      "BetOutstanding"
    );
    await expect(
      contract.connect(bob).act(1, 2, { value: ACTION_STAKE - 1n })
    ).to.be.revertedWithCustomError(contract, "InvalidActionValue");

    await expect(contract.connect(bob).act(1, 2, { value: ACTION_STAKE }))
      .to.emit(contract, "WinnerReady");

    const awaitingSettlement = await contract.getPublicGame(1);
    const payout = BUY_IN * 2n + ACTION_STAKE * 2n;
    expect(awaitingSettlement.status).to.equal(3n);
    expect(awaitingSettlement.pot).to.equal(payout);

    const winnerHandle = await contract.getWinnerHandle(1);
    const decryptResult = await aliceClient
      .decryptForTx(winnerHandle)
      .withoutPermit()
      .execute();

    const winnerSeatCode = Number(decryptResult.decryptedValue);
    await contract.settleEncryptedWinner(
      1,
      winnerSeatCode,
      decryptResult.signature
    );

    const settledGame = await contract.getPublicGame(1);
    expect(settledGame.status).to.equal(4n);
    expect(settledGame.pot).to.equal(0n);

    if (winnerSeatCode === 0) {
      expect(settledGame.winner).to.equal(hre.ethers.ZeroAddress);
      expect(await contract.pendingWithdrawals(alice.address)).to.equal(payout / 2n);
      expect(await contract.pendingWithdrawals(bob.address)).to.equal(payout / 2n);
    } else {
      expect([alice.address, bob.address]).to.include(settledGame.winner);
      expect(await contract.pendingWithdrawals(settledGame.winner)).to.equal(payout);

      const winnerSigner =
        settledGame.winner.toLowerCase() === alice.address.toLowerCase() ? alice : bob;
      await contract.connect(winnerSigner).withdraw();
      expect(await contract.pendingWithdrawals(settledGame.winner)).to.equal(0n);
    }
  });

  it("requires encrypted shuffle contributions and rejects invalid actions", async () => {
    const contract = await deployGame();
    await createJoinedGame(contract);

    await expect(contract.connect(alice).dealHands(1)).to.be.revertedWithCustomError(
      contract,
      "ShuffleEntropyMissing"
    );

    const aliceEntropy = await encryptEntropy(aliceClient, [1, 2, 3, 4]);
    await contract.connect(alice).submitShuffleEntropy(1, aliceEntropy);
    await expect(contract.connect(alice).dealHands(1)).to.be.revertedWithCustomError(
      contract,
      "ShuffleEntropyMissing"
    );
    await expect(
      contract.connect(alice).submitShuffleEntropy(1, aliceEntropy)
    ).to.be.revertedWithCustomError(contract, "ShuffleEntropyAlreadySubmitted");

    const bobEntropy = await encryptEntropy(bobClient, [5, 6, 7, 8]);
    await contract.connect(bob).submitShuffleEntropy(1, bobEntropy);

    await expect(contract.connect(alice).dealHands(1)).to.emit(contract, "CardsDealt");
    await expect(contract.connect(alice).act(1, 4)).to.be.revertedWithCustomError(
      contract,
      "InvalidActionValue"
    );
  });

  it("refunds if the encrypted winner is not settled before the reveal deadline", async () => {
    const contract = await deployGame();
    await createJoinedGame(contract);
    await dealHands(contract);

    await contract.connect(alice).act(1, 0);
    await expect(contract.connect(bob).act(1, 0)).to.emit(contract, "WinnerReady");

    const awaitingSettlement = await contract.getPublicGame(1);
    expect(awaitingSettlement.status).to.equal(3n);
    expect(awaitingSettlement.deadline).to.be.greaterThan(0n);

    await increaseTime(REVEAL_TIMEOUT + 1);
    await expect(contract.claimTimeout(1)).to.emit(contract, "GameCancelled");

    const settledGame = await contract.getPublicGame(1);
    expect(settledGame.status).to.equal(5n);
    expect(settledGame.pot).to.equal(0n);
    expect(await contract.pendingWithdrawals(alice.address)).to.equal(BUY_IN);
    expect(await contract.pendingWithdrawals(bob.address)).to.equal(BUY_IN);
  });

  it("settles immediately to a pull payment when a player folds", async () => {
    const contract = await deployGame();
    await createJoinedGame(contract);
    await dealHands(contract);

    await expect(contract.connect(alice).act(1, 3))
      .to.emit(contract, "GameSettled")
      .withArgs(1, bob.address, 1, BUY_IN * 2n);

    const game = await contract.getPublicGame(1);
    expect(game.status).to.equal(4n);
    expect(game.winner).to.equal(bob.address);
    expect(await contract.pendingWithdrawals(bob.address)).to.equal(BUY_IN * 2n);
  });

  it("allows creators to cancel open games without pushing ether", async () => {
    const contract = await deployGame();

    await contract.connect(alice).createGame(BUY_IN, { value: BUY_IN });
    await expect(contract.connect(alice).cancelOpenGame(1)).to.emit(
      contract,
      "GameCancelled"
    );

    const game = await contract.getPublicGame(1);
    expect(game.status).to.equal(5n);
    expect(game.pot).to.equal(0n);
    expect(await contract.pendingWithdrawals(alice.address)).to.equal(BUY_IN);
  });

  it("refunds both players if cards are not dealt before the deadline", async () => {
    const contract = await deployGame();
    await createJoinedGame(contract);

    await increaseTime(HAND_TIMEOUT + 1);
    await expect(contract.claimTimeout(1)).to.emit(contract, "GameCancelled");

    const game = await contract.getPublicGame(1);
    expect(game.status).to.equal(5n);
    expect(game.pot).to.equal(0n);
    expect(await contract.pendingWithdrawals(alice.address)).to.equal(BUY_IN);
    expect(await contract.pendingWithdrawals(bob.address)).to.equal(BUY_IN);
  });

  it("awards the pot to the waiting player when a turn times out", async () => {
    const contract = await deployGame();
    await createJoinedGame(contract);
    await dealHands(contract);

    await increaseTime(ACTION_TIMEOUT + 1);
    await expect(contract.claimTimeout(1))
      .to.emit(contract, "GameSettled")
      .withArgs(1, bob.address, 1, BUY_IN * 2n);

    const game = await contract.getPublicGame(1);
    expect(game.status).to.equal(4n);
    expect(game.winner).to.equal(bob.address);
    expect(await contract.pendingWithdrawals(bob.address)).to.equal(BUY_IN * 2n);
  });
});
