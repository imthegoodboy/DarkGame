import hre from "hardhat";
import { expect } from "chai";
import { CofheClient, FheTypes } from "@cofhe/sdk";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const BUY_IN = hre.ethers.parseEther("0.01");
const ACTION_STAKE = hre.ethers.parseEther("0.001");
const HAND_TIMEOUT = 20 * 60;
const ACTION_TIMEOUT = 20 * 60;

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

  async function dealHands(contract: any) {
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

    const [aliceCard, bobCard] = await Promise.all([
      aliceClient.decryptForView(aliceCards[0], FheTypes.Uint8).execute(),
      bobClient.decryptForView(bobCards[0], FheTypes.Uint8).execute(),
    ]);

    expect(aliceCard).to.be.at.least(0n);
    expect(aliceCard).to.be.at.most(51n);
    expect(bobCard).to.be.at.least(0n);
    expect(bobCard).to.be.at.most(51n);

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

    await expect(
      contract.settleEncryptedWinner(
        1,
        Number(decryptResult.decryptedValue),
        decryptResult.signature
      )
    ).to.emit(contract, "GameSettled");

    const settledGame = await contract.getPublicGame(1);
    expect(settledGame.status).to.equal(4n);
    expect(settledGame.pot).to.equal(0n);
    expect([alice.address, bob.address]).to.include(settledGame.winner);
    expect(await contract.pendingWithdrawals(settledGame.winner)).to.equal(payout);

    const winnerSigner =
      settledGame.winner.toLowerCase() === alice.address.toLowerCase() ? alice : bob;
    await contract.connect(winnerSigner).withdraw();
    expect(await contract.pendingWithdrawals(settledGame.winner)).to.equal(0n);
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
