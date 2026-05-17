import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CircleDollarSign,
  Eye,
  Gamepad2,
  Loader2,
  LogIn,
  Plus,
  RefreshCw,
  Shield,
  TimerReset,
  Wallet,
} from "lucide-react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  parseEther,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from "viem";
import { configuredChain } from "./lib/chains";
import { darkGameAbi } from "./contracts/darkGameAbi";
import { cardIndexToCard, shortAddress, type DisplayCard } from "./lib/cards";

const contractAddress = import.meta.env.VITE_DARKGAME_ADDRESS as Address | undefined;
const requiredChain = configuredChain();
const publicClient = createPublicClient({
  chain: requiredChain,
  transport: http(
    requiredChain.id === 31337
      ? "http://127.0.0.1:8545"
      : import.meta.env.VITE_SEPOLIA_RPC_URL
  ),
});

async function loadCofhe() {
  const [{ cofheClient }, sdk] = await Promise.all([
    import("./lib/cofheClient"),
    import("@cofhe/sdk"),
  ]);

  return {
    cofheClient,
    FheTypes: sdk.FheTypes,
  };
}

type GameStatus = "None" | "Open" | "Active" | "AwaitingReveal" | "Finished" | "Cancelled";

type Game = {
  id: bigint;
  playerOne: Address;
  playerTwo: Address;
  buyIn: bigint;
  pot: bigint;
  handCount: number;
  status: number;
  turn: number;
  actionCount: number;
  winner: Address;
  playerOneHandDealt: boolean;
  playerTwoHandDealt: boolean;
  currentBet: bigint;
  playerOneRoundStake: bigint;
  playerTwoRoundStake: bigint;
  deadline: bigint;
  createdAt: bigint;
  updatedAt: bigint;
};

type PlayerState = {
  joined: boolean;
  acted: boolean;
  folded: boolean;
  handDealt: boolean;
  committed: bigint;
  roundStake: bigint;
  pendingWithdrawal: bigint;
};

type FheHandle = `0x${string}`;

type Toast = {
  tone: "info" | "success" | "error";
  text: string;
};

const statusLabels: GameStatus[] = [
  "None",
  "Open",
  "Active",
  "AwaitingReveal",
  "Finished",
  "Cancelled",
];

const actionLabels = ["Check", "Bet", "Call", "Fold"] as const;

function isUsableAddress(value?: Address) {
  return Boolean(value && value !== zeroAddress);
}

function parseEthInput(value: string) {
  try {
    return parseEther(value || "0");
  } catch {
    return null;
  }
}

function gamePriority(game: Game) {
  if (game.status === 1) return 0;
  if (game.status === 2) return 1;
  if (game.status === 3) return 2;
  if (game.status === 4) return 3;
  if (game.status === 5) return 4;
  return 5;
}

export default function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<bigint | null>(null);
  const [buyIn, setBuyIn] = useState("0.0005");
  const [actionStake, setActionStake] = useState("0.0001");
  const [joinId, setJoinId] = useState("");
  const [hand, setHand] = useState<DisplayCard[] | null>(null);
  const [score, setScore] = useState<bigint | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState | null>(null);
  const [pendingWithdrawal, setPendingWithdrawal] = useState<bigint>(0n);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [walletClient, setWalletClient] = useState<WalletClient>();
  const [connecting, setConnecting] = useState(false);

  const selectedGame = useMemo(
    () => games.find((game) => game.id === selectedGameId) ?? games[0],
    [games, selectedGameId]
  );

  const isContractReady = isUsableAddress(contractAddress);
  const isConnected = Boolean(address);
  const playerSeat = useMemo(() => {
    if (!selectedGame || !address) return null;
    if (selectedGame.playerOne.toLowerCase() === address.toLowerCase()) return 0;
    if (selectedGame.playerTwo.toLowerCase() === address.toLowerCase()) return 1;
    return null;
  }, [address, selectedGame]);

  const statusLabel =
    selectedGame?.status === 2 && selectedGame.handCount < 2
      ? "Dealing"
      : selectedGame
        ? statusLabels[selectedGame.status]
        : "None";
  const needsNetwork = isConnected && chainId !== requiredChain.id;
  const playerHandDealt =
    selectedGame && playerSeat !== null
      ? playerSeat === 0
        ? selectedGame.playerOneHandDealt
        : selectedGame.playerTwoHandDealt
      : false;
  const playerRoundStake =
    selectedGame && playerSeat !== null
      ? playerSeat === 0
        ? selectedGame.playerOneRoundStake
        : selectedGame.playerTwoRoundStake
      : 0n;
  const owedToCall =
    selectedGame && selectedGame.currentBet > playerRoundStake
      ? selectedGame.currentBet - playerRoundStake
      : 0n;
  const deadlineSeconds = Number(selectedGame?.deadline ?? 0n);
  const secondsLeft = deadlineSeconds > 0 ? Math.max(deadlineSeconds - nowSeconds, 0) : 0;

  const notify = useCallback((next: Toast) => {
    setToast(next);
    window.setTimeout(() => setToast(null), 4600);
  }, []);

  const hydrateWallet = useCallback(async (provider: EIP1193Provider, requestedAccounts?: Address[]) => {
    const accounts =
      requestedAccounts ??
      ((await provider.request({ method: "eth_accounts" })) as Address[]);
    const activeAddress = accounts[0];
    const chainHex = (await provider.request({ method: "eth_chainId" })) as string;

    if (!activeAddress) {
      setAddress(undefined);
      setWalletClient(undefined);
      return;
    }

    setAddress(activeAddress);
    setChainId(Number(chainHex));
    setWalletClient(
      createWalletClient({
        account: activeAddress,
        chain: requiredChain,
        transport: custom(provider),
      })
    );
  }, []);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;

    void hydrateWallet(provider);

    const onAccountsChanged = (accounts: unknown) => {
      void hydrateWallet(provider, accounts as Address[]);
    };
    const onChainChanged = (chain: unknown) => {
      setChainId(Number(chain as string));
      void hydrateWallet(provider);
    };

    provider.on?.("accountsChanged", onAccountsChanged);
    provider.on?.("chainChanged", onChainChanged);

    return () => {
      provider.removeListener?.("accountsChanged", onAccountsChanged);
      provider.removeListener?.("chainChanged", onChainChanged);
    };
  }, [hydrateWallet]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const connectWallet = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) {
      notify({ tone: "error", text: "No injected wallet was found in this browser." });
      return;
    }

    try {
      setConnecting(true);
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as Address[];
      await hydrateWallet(provider, accounts);
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "Wallet connection failed." });
    } finally {
      setConnecting(false);
    }
  }, [hydrateWallet, notify]);

  const switchToRequiredChain = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) throw new Error("No injected wallet was found in this browser.");

    const chainHex = `0x${requiredChain.id.toString(16)}`;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : undefined;
      if (code !== 4902) throw error;

      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainHex,
            chainName: requiredChain.name,
            nativeCurrency: requiredChain.nativeCurrency,
            rpcUrls: requiredChain.rpcUrls.default.http,
          },
        ],
      });
    }
    await hydrateWallet(provider);
  }, [hydrateWallet]);

  const ensureWallet = useCallback(async () => {
    if (!isConnected || !address) {
      throw new Error("Connect a wallet first.");
    }
    if (!walletClient) {
      throw new Error("Wallet clients are not ready yet.");
    }
    if (chainId !== requiredChain.id) {
      await switchToRequiredChain();
    }
    if (!isContractReady || !contractAddress) {
      throw new Error("Set VITE_DARKGAME_ADDRESS to a deployed DarkGame contract.");
    }
    return { publicClient, walletClient, account: address, contractAddress };
  }, [
    address,
    chainId,
    isConnected,
    isContractReady,
    switchToRequiredChain,
    walletClient,
  ]);

  const connectCofhe = useCallback(async () => {
    const clients = await ensureWallet();
    const cofhe = await loadCofhe();
    await cofhe.cofheClient.connect(
      clients.publicClient as never,
      clients.walletClient as never
    );
    await cofhe.cofheClient.permits.getOrCreateSelfPermit();
    return { ...clients, ...cofhe };
  }, [ensureWallet]);

  const refreshGames = useCallback(async (preferredGameId?: bigint, silent = false) => {
    if (!isContractReady || !contractAddress) return;

    try {
      if (!silent) setBusy("Refreshing tables");
      const nextId = (await publicClient.readContract({
        address: contractAddress,
        abi: darkGameAbi,
        functionName: "nextGameId",
      })) as bigint;

      const ids = Array.from({ length: Math.max(Number(nextId - 1n), 0) }, (_, index) => BigInt(index + 1))
        .reverse()
        .slice(0, 12);

      const loaded = await Promise.all(
        ids.map((id) =>
          publicClient.readContract({
            address: contractAddress,
            abi: darkGameAbi,
            functionName: "getPublicGame",
            args: [id],
          }) as Promise<Game>
        )
      );

      const sorted = [...loaded].sort((left, right) => {
        const priorityDelta = gamePriority(left) - gamePriority(right);
        if (priorityDelta !== 0) return priorityDelta;
        return Number(right.id - left.id);
      });

      setGames(sorted);
      setSelectedGameId((current) => {
        if (preferredGameId && sorted.some((game) => game.id === preferredGameId)) {
          return preferredGameId;
        }
        if (current && sorted.some((game) => game.id === current)) {
          return current;
        }
        return sorted[0]?.id ?? null;
      });
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "Unable to refresh tables." });
    } finally {
      if (!silent) setBusy(null);
    }
  }, [isContractReady, notify]);

  const refreshWalletState = useCallback(async () => {
    if (!isContractReady || !contractAddress || !address) {
      setPlayerState(null);
      setPendingWithdrawal(0n);
      return;
    }

    try {
      const pending = (await publicClient.readContract({
        address: contractAddress,
        abi: darkGameAbi,
        functionName: "pendingWithdrawals",
        args: [address],
      })) as bigint;

      setPendingWithdrawal(pending);

      if (selectedGame && playerSeat !== null) {
        const nextPlayerState = (await publicClient.readContract({
          address: contractAddress,
          abi: darkGameAbi,
          functionName: "getPlayerState",
          args: [selectedGame.id, address],
        })) as PlayerState;
        setPlayerState(nextPlayerState);
      } else {
        setPlayerState(null);
      }
    } catch {
      setPlayerState(null);
      setPendingWithdrawal(0n);
    }
  }, [address, isContractReady, playerSeat, selectedGame]);

  useEffect(() => {
    void refreshGames();
  }, [refreshGames]);

  useEffect(() => {
    const poll = window.setInterval(() => {
      void refreshGames(undefined, true);
    }, 15000);

    return () => window.clearInterval(poll);
  }, [refreshGames]);

  useEffect(() => {
    void refreshWalletState();
  }, [refreshWalletState]);

  async function runTx(
    label: string,
    tx: (clients: Awaited<ReturnType<typeof ensureWallet>>) => Promise<`0x${string}`>,
    preferredGameId?: bigint
  ) {
    setBusy(label);
    try {
      const clients = await ensureWallet();
      const hash = await tx(clients);
      await clients.publicClient.waitForTransactionReceipt({ hash });
      notify({ tone: "success", text: `${label} confirmed.` });
      setHand(null);
      setScore(null);
      await refreshGames(preferredGameId);
      await refreshWalletState();
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : `${label} failed.` });
    } finally {
      setBusy(null);
    }
  }

  async function createGame() {
    const value = parseEthInput(buyIn);
    if (value === null || value <= 0n) {
      notify({ tone: "error", text: "Enter a valid buy-in amount." });
      return;
    }
    const expectedGameId =
      games.length > 0
        ? games.reduce((highest, game) => (game.id > highest ? game.id : highest), 0n) + 1n
        : undefined;

    await runTx(
      "Create table",
      (clients) =>
        clients.walletClient.writeContract({
          address: clients.contractAddress,
          abi: darkGameAbi,
          functionName: "createGame",
          args: [value],
          value,
          account: clients.account,
          chain: requiredChain,
        }),
      expectedGameId
    );
  }

  async function joinGame(id = joinId) {
    const normalizedId = id.trim();
    if (!normalizedId || !/^\d+$/.test(normalizedId)) {
      notify({ tone: "error", text: "Select or enter a table ID first." });
      return;
    }

    const game = games.find((item) => item.id === BigInt(normalizedId));
    if (!game) {
      notify({ tone: "error", text: "Load the table before joining." });
      return;
    }
    if (game.status !== 1) {
      notify({ tone: "error", text: "That table is not open for joining." });
      return;
    }

    await runTx("Join table", (clients) =>
      clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "joinGame",
        args: [game.id],
        value: game.buyIn,
        account: clients.account,
        chain: requiredChain,
      }),
      game.id
    );
  }

  async function sendAction(action: number) {
    if (!selectedGame) return;
    const betValue = parseEthInput(actionStake);
    if (action === 1 && (betValue === null || betValue <= 0n)) {
      notify({ tone: "error", text: "Enter a valid bet amount." });
      return;
    }

    const value =
      action === 1 ? betValue ?? 0n : action === 2 ? owedToCall : 0n;

    if (action === 2 && owedToCall === 0n) {
      notify({ tone: "error", text: "There is no open bet to call." });
      return;
    }

    await runTx(actionLabels[action], (clients) =>
      clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "act",
        args: [selectedGame.id, action],
        value,
        account: clients.account,
        chain: requiredChain,
      }),
      selectedGame.id
    );
  }

  async function dealHand() {
    if (!selectedGame) return;
    await runTx("Deal cards", (clients) =>
      clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "dealHands",
        args: [selectedGame.id],
        account: clients.account,
        chain: requiredChain,
      }),
      selectedGame.id
    );
  }

  async function cancelTable() {
    if (!selectedGame) return;
    await runTx("Cancel table", (clients) =>
      clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "cancelOpenGame",
        args: [selectedGame.id],
        account: clients.account,
        chain: requiredChain,
      }),
      selectedGame.id
    );
  }

  async function claimTimeout() {
    if (!selectedGame) return;
    await runTx("Claim timeout", (clients) =>
      clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "claimTimeout",
        args: [selectedGame.id],
        account: clients.account,
        chain: requiredChain,
      }),
      selectedGame.id
    );
  }

  async function withdrawPayout() {
    await runTx("Withdraw", (clients) =>
      clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "withdraw",
        account: clients.account,
        chain: requiredChain,
      })
    );
  }

  async function revealHand() {
    if (!selectedGame || !contractAddress) return;

    try {
      setBusy("Decrypting hand");
      const clients = await connectCofhe();
      const [cardAHandle, cardBHandle] = (await clients.publicClient.readContract({
        address: contractAddress,
        abi: darkGameAbi,
        functionName: "getPrivateHand",
        args: [selectedGame.id],
        account: clients.account,
      })) as readonly [FheHandle, FheHandle];

      const scoreHandle = (await clients.publicClient.readContract({
        address: contractAddress,
        abi: darkGameAbi,
        functionName: "getPrivateScore",
        args: [selectedGame.id],
        account: clients.account,
      })) as FheHandle;

      const [cardA, cardB, handScore] = await Promise.all([
        clients.cofheClient.decryptForView(cardAHandle, clients.FheTypes.Uint8).execute(),
        clients.cofheClient.decryptForView(cardBHandle, clients.FheTypes.Uint8).execute(),
        clients.cofheClient.decryptForView(scoreHandle, clients.FheTypes.Uint8).execute(),
      ]);

      setHand([cardIndexToCard(cardA as bigint), cardIndexToCard(cardB as bigint)]);
      setScore(handScore as bigint);
      notify({ tone: "success", text: "Private hand decrypted locally." });
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "Unable to decrypt hand." });
    } finally {
      setBusy(null);
    }
  }

  async function settleWinner() {
    if (!selectedGame || !contractAddress) return;

    try {
      const clients = await connectCofhe();
      setBusy("Settling winner");
      const winnerHandle = (await publicClient.readContract({
        address: contractAddress,
        abi: darkGameAbi,
        functionName: "getWinnerHandle",
        args: [selectedGame.id],
      })) as FheHandle;

      const decryptResult = await clients.cofheClient
        .decryptForTx(winnerHandle)
        .withoutPermit()
        .execute();

      const hash = await clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "settleEncryptedWinner",
        args: [
          selectedGame.id,
          Number(decryptResult.decryptedValue),
          decryptResult.signature as `0x${string}`,
        ],
        account: clients.account,
        chain: requiredChain,
      });

      await clients.publicClient.waitForTransactionReceipt({ hash });
      notify({ tone: "success", text: "Winner settled on-chain." });
      await refreshGames();
      await refreshWalletState();
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "Unable to settle winner." });
    } finally {
      setBusy(null);
    }
  }

  const canDeal = selectedGame?.status === 2 && playerSeat !== null && selectedGame.handCount === 0;
  const canAct = selectedGame?.status === 2 && selectedGame.handCount === 2 && playerSeat === selectedGame.turn;
  const canCheck = canAct && owedToCall === 0n;
  const canBet = canAct && owedToCall === 0n;
  const canCall = canAct && owedToCall > 0n;
  const canFold = canAct;
  const canReveal = playerSeat !== null && playerHandDealt;
  const canSettle = selectedGame?.status === 3;
  const canTimeout = Boolean(
    selectedGame &&
    (selectedGame.status === 2 || selectedGame.status === 3) &&
    selectedGame.deadline > 0n &&
    secondsLeft === 0
  );
  const canWithdraw = pendingWithdrawal > 0n;
  const canCancel =
    selectedGame?.status === 1 &&
    address &&
    selectedGame.playerOne.toLowerCase() === address.toLowerCase();

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Shield size={22} />
          </div>
          <div>
            <p>DarkGame</p>
            <span>Encrypted heads-up poker</span>
          </div>
        </div>

        <div className="wallet-strip">
          <div className="network-pill">
            <BadgeCheck size={16} />
            {requiredChain.name}
          </div>
          {isConnected ? (
            <>
              <button
                className="ghost-button"
                type="button"
                onClick={() => needsNetwork && switchToRequiredChain()}
                disabled={!needsNetwork}
                title="Switch network"
              >
                <RefreshCw size={17} />
                {needsNetwork ? "Switch" : shortAddress(address)}
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setAddress(undefined);
                  setWalletClient(undefined);
                }}
                title="Disconnect wallet"
              >
                <Wallet size={18} />
              </button>
            </>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={connectWallet}
              disabled={connecting}
              title="Connect wallet"
            >
              {connecting ? <Loader2 className="spin" size={18} /> : <Wallet size={18} />}
              Connect
            </button>
          )}
        </div>
      </section>

      {!isContractReady && (
        <section className="warning-band">
          <AlertTriangle size={18} />
          <span>Deploy DarkGame and set VITE_DARKGAME_ADDRESS before playing.</span>
        </section>
      )}

      <section className="game-layout">
        <aside className="lobby-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Lobby</span>
              <h2>Tables</h2>
            </div>
            <button className="icon-button" type="button" onClick={() => refreshGames()} title="Refresh tables">
              <RefreshCw size={17} />
            </button>
          </div>

          <div className="create-row">
            <label>
              Buy-in
              <input value={buyIn} onChange={(event) => setBuyIn(event.target.value)} inputMode="decimal" />
            </label>
            <button className="primary-button compact" type="button" onClick={createGame} disabled={!isContractReady}>
              <Plus size={16} />
              Create
            </button>
          </div>

          <div className="join-row">
            <label>
              Table ID
              <input value={joinId} onChange={(event) => setJoinId(event.target.value)} inputMode="numeric" />
            </label>
            <button className="ghost-button compact" type="button" onClick={() => joinGame()} disabled={!joinId}>
              <LogIn size={16} />
              Join
            </button>
          </div>

          <div className="table-list">
            {games.length === 0 ? (
              <div className="empty-state">
                <Gamepad2 size={24} />
                <span>No live tables yet</span>
              </div>
            ) : (
              games.map((game) => (
                <button
                  className={`table-item ${selectedGame?.id === game.id ? "selected" : ""}`}
                  key={game.id.toString()}
                  type="button"
                  onClick={() => {
                    setSelectedGameId(game.id);
                    setJoinId(game.status === 1 ? game.id.toString() : "");
                    setHand(null);
                    setScore(null);
                  }}
                >
                  <span>#{game.id.toString()}</span>
                  <strong>{statusLabels[game.status]}</strong>
                  <small>
                    {formatEther(game.buyIn)} ETH
                    {game.status === 1 ? " · click then Join" : ""}
                  </small>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="table-stage">
          <div className="table-surface">
            <div className="opponent-seat seat">
              <span>Seat 2</span>
              <strong>{shortAddress(selectedGame?.playerTwo)}</strong>
            </div>

            <div className="pot-core">
              <span className="eyebrow">Pot</span>
              <strong>{selectedGame ? `${formatEther(selectedGame.pot)} ETH` : "0 ETH"}</strong>
              <div className={`status-chip status-${statusLabel.toLowerCase()}`}>{statusLabel}</div>
            </div>

            <div className="hand-zone" aria-label="Private hand">
              {(hand ?? [null, null]).map((card, index) => (
                <div className={`playing-card ${card?.color ?? "hidden"}`} key={index}>
                  {card ? (
                    <>
                      <span>{card.rank}</span>
                      <strong>{card.suit}</strong>
                      <span>{card.rank}</span>
                    </>
                  ) : (
                    <Shield size={28} />
                  )}
                </div>
              ))}
            </div>

            <div className="player-seat seat">
              <span>{playerSeat === null ? "Spectator" : `Seat ${playerSeat + 1}`}</span>
              <strong>{shortAddress(address)}</strong>
            </div>
          </div>

          <div className="control-dock">
            <label className="action-stake">
              Bet
              <input value={actionStake} onChange={(event) => setActionStake(event.target.value)} inputMode="decimal" />
            </label>
            <button className="primary-button" type="button" onClick={dealHand} disabled={!canDeal}>
              <Shield size={17} />
              Deal Cards
            </button>
            <button className="ghost-button" type="button" onClick={revealHand} disabled={!canReveal}>
              <Eye size={17} />
              Reveal Hand
            </button>
            <button className="primary-button" type="button" onClick={() => sendAction(0)} disabled={!canCheck}>
              Check
            </button>
            <button className="primary-button" type="button" onClick={() => sendAction(1)} disabled={!canBet}>
              Bet
            </button>
            <button className="primary-button" type="button" onClick={() => sendAction(2)} disabled={!canCall}>
              {owedToCall > 0n ? `Call ${formatEther(owedToCall)}` : "Call"}
            </button>
            <button className="danger-button" type="button" onClick={() => sendAction(3)} disabled={!canFold}>
              Fold
            </button>
            <button className="settle-button" type="button" onClick={settleWinner} disabled={!canSettle}>
              <CircleDollarSign size={17} />
              Settle
            </button>
            <button className="ghost-button" type="button" onClick={withdrawPayout} disabled={!canWithdraw}>
              <CircleDollarSign size={17} />
              Withdraw
            </button>
            <button className="ghost-button" type="button" onClick={claimTimeout} disabled={!canTimeout}>
              <TimerReset size={17} />
              Timeout
            </button>
            <button className="ghost-button" type="button" onClick={cancelTable} disabled={!canCancel}>
              <TimerReset size={17} />
              Cancel
            </button>
          </div>
        </section>

        <aside className="inspector-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">State</span>
              <h2>On-chain</h2>
            </div>
          </div>

          <dl className="stats-list">
            <div>
              <dt>Table</dt>
              <dd>{selectedGame ? `#${selectedGame.id.toString()}` : "None"}</dd>
            </div>
            <div>
              <dt>Turn</dt>
              <dd>{selectedGame?.status === 2 ? `Seat ${selectedGame.turn + 1}` : "Closed"}</dd>
            </div>
            <div>
              <dt>Hands</dt>
              <dd>{playerState?.handDealt ? "Your hand dealt" : `${selectedGame?.handCount ?? 0}/2`}</dd>
            </div>
            <div>
              <dt>Actions</dt>
              <dd>{selectedGame?.actionCount ?? 0}</dd>
            </div>
            <div>
              <dt>Current bet</dt>
              <dd>{selectedGame ? `${formatEther(selectedGame.currentBet)} ETH` : "0 ETH"}</dd>
            </div>
            <div>
              <dt>To call</dt>
              <dd>{`${formatEther(owedToCall)} ETH`}</dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>{selectedGame?.deadline && selectedGame.deadline > 0n ? `${secondsLeft}s` : "None"}</dd>
            </div>
            <div>
              <dt>Score</dt>
              <dd>{score ? score.toString() : "Encrypted"}</dd>
            </div>
            <div>
              <dt>Pending</dt>
              <dd>{`${formatEther(pendingWithdrawal)} ETH`}</dd>
            </div>
            <div>
              <dt>Winner</dt>
              <dd>{selectedGame?.winner && selectedGame.winner !== zeroAddress ? shortAddress(selectedGame.winner) : "Encrypted"}</dd>
            </div>
          </dl>

          <div className="privacy-stack">
            <div>
              <Shield size={18} />
              <span>Private hand handles are ACL-restricted to seated wallets.</span>
            </div>
            <div>
              <BadgeCheck size={18} />
              <span>Payouts are pull-based and verified by the encrypted winner proof.</span>
            </div>
          </div>
        </aside>
      </section>

      {busy && (
        <div className="busy-toast">
          <Loader2 className="spin" size={18} />
          {busy}
        </div>
      )}

      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </main>
  );
}
