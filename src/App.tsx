import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CircleDollarSign,
  Clock3,
  Crown,
  Eye,
  Gamepad2,
  Loader2,
  LogIn,
  Plus,
  RefreshCw,
  Shield,
  TimerReset,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  parseEventLogs,
  http,
  parseEther,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { configuredChain } from "./lib/chains";
import { darkGameAbi } from "./contracts/darkGameAbi";
import { cardIndexToCard, type DisplayCard } from "./lib/cards";

const contractAddress = import.meta.env.VITE_DARKGAME_ADDRESS as Address | undefined;
const requiredChain = configuredChain();
const deploymentStartBlock = parseOptionalBlock(import.meta.env.VITE_DARKGAME_START_BLOCK);
const publicClient = createPublicClient({
  chain: requiredChain,
  transport: http(
    requiredChain.id === 31337
      ? "http://127.0.0.1:8545"
      : import.meta.env.VITE_SEPOLIA_RPC_URL
  ),
});
const gasLimits = {
  createGame: 350_000n,
  joinGame: 350_000n,
  submitShuffleEntropy: 1_200_000n,
  dealHands: 10_000_000n,
  act: 650_000n,
  cancelOpenGame: 250_000n,
  claimTimeout: 450_000n,
  settleEncryptedWinner: 800_000n,
  withdraw: 150_000n,
} as const;

async function loadCofhe() {
  const [{ cofheClient }, sdk] = await Promise.all([
    import("./lib/cofheClient"),
    import("@cofhe/sdk"),
  ]);

  return {
    cofheClient,
    FheTypes: sdk.FheTypes,
    Encryptable: sdk.Encryptable,
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
  playerOneShuffleReady: boolean;
  playerTwoShuffleReady: boolean;
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
  shuffleReady: boolean;
  committed: bigint;
  roundStake: bigint;
  pendingWithdrawal: bigint;
};

type FheHandle = `0x${string}`;
type EncryptedUint8Input = {
  ctHash: bigint;
  securityZone: number;
  utype: number;
  signature: `0x${string}`;
};
type ShuffleEntropyInput = readonly [
  EncryptedUint8Input,
  EncryptedUint8Input,
  EncryptedUint8Input,
  EncryptedUint8Input,
];

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
const shuffleShareModuli = [52, 51, 50, 49] as const;

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

function sortGames(games: Game[]) {
  return [...games].sort((left, right) => {
    const priorityDelta = gamePriority(left) - gamePriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    return Number(right.id - left.id);
  });
}

function upsertGame(games: Game[], nextGame: Game) {
  return sortGames([...games.filter((game) => game.id !== nextGame.id), nextGame]);
}

function routeGameId(route: AppRoute) {
  return route.page === "room" || route.page === "game" ? route.gameId : undefined;
}

function randomShareBelow(modulo: number) {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) {
    throw new Error("Secure browser randomness is unavailable.");
  }

  const bytes = new Uint8Array(1);
  const limit = Math.floor(256 / modulo) * modulo;
  let value = 0;
  do {
    crypto.getRandomValues(bytes);
    value = bytes[0];
  } while (value >= limit);

  return BigInt(value % modulo);
}

function createShuffleShares() {
  return shuffleShareModuli.map((modulo) => randomShareBelow(modulo));
}

function formatTimer(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function CardBack({ label }: { label: string }) {
  return (
    <div className="playing-card hidden" aria-label={label}>
      <div className="card-back-pattern" />
      <Shield size={24} />
    </div>
  );
}

function CardFace({ card }: { card: DisplayCard }) {
  return (
    <div className={`playing-card ${card.color}`}>
      <span>{card.rank}</span>
      <strong>{card.suit}</strong>
      <span>{card.rank}</span>
    </div>
  );
}

type RoutePage = "home" | "lobby" | "room" | "game" | "protocol";

type AppRoute = {
  page: RoutePage;
  gameId?: bigint;
};

const navItems: Array<{ label: string; path: string; page: RoutePage }> = [
  { label: "Home", path: "/", page: "home" },
  { label: "Lobby", path: "/lobby", page: "lobby" },
  { label: "Protocol", path: "/protocol", page: "protocol" },
];

function parsePositiveBigInt(value?: string) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : undefined;
}

function parseOptionalBlock(value?: string) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

function parseAppRoute(pathname: string): AppRoute {
  const segments = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const [first, second] = segments;

  if (first === "lobby") return { page: "lobby" };
  if (first === "room") {
    return { page: "room", gameId: segments.length === 2 ? parsePositiveBigInt(second) : undefined };
  }
  if (first === "game") {
    return { page: "game", gameId: segments.length === 2 ? parsePositiveBigInt(second) : undefined };
  }
  if (first === "protocol") return { page: "protocol" };
  return { page: "home" };
}

function routeTitle(route: AppRoute) {
  if (route.page === "lobby") return "DarkGame Lobby";
  if (route.page === "room") return route.gameId ? `DarkGame Room #${route.gameId}` : "DarkGame Room";
  if (route.page === "game") return route.gameId ? `DarkGame Table #${route.gameId}` : "DarkGame Table";
  if (route.page === "protocol") return "DarkGame Protocol";
  return "DarkGame";
}

async function waitForSuccessfulReceipt(
  client: PublicClient,
  hash: `0x${string}`,
  label: string
): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${label} reverted on-chain.`);
  }
  return receipt;
}

function gameCreatedIdFromReceipt(receipt: TransactionReceipt) {
  try {
    const [created] = parseEventLogs({
      abi: darkGameAbi,
      eventName: "GameCreated",
      logs: receipt.logs,
    });
    return created?.args.gameId;
  } catch {
    return undefined;
  }
}

export default function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<bigint | null>(null);
  const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.pathname));
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
  const routeRequiresGame = route.page === "room" || route.page === "game";

  const selectedGame = useMemo(
    () => {
      if (routeRequiresGame) {
        return route.gameId ? games.find((game) => game.id === route.gameId) : undefined;
      }
      const matchedGame = selectedGameId
        ? games.find((game) => game.id === selectedGameId)
        : undefined;
      return matchedGame ?? games[0];
    },
    [games, route.gameId, routeRequiresGame, selectedGameId]
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
      ? selectedGame.playerOneShuffleReady && selectedGame.playerTwoShuffleReady
        ? "Dealing"
        : "Shuffling"
      : selectedGame
        ? statusLabels[selectedGame.status] ?? "Unknown"
        : "None";
  const needsNetwork = isConnected && chainId !== requiredChain.id;
  const playerHandDealt =
    selectedGame && playerSeat !== null
      ? playerSeat === 0
        ? selectedGame.playerOneHandDealt
        : selectedGame.playerTwoHandDealt
      : false;
  const playerShuffleReady =
    selectedGame && playerSeat !== null
      ? playerSeat === 0
        ? selectedGame.playerOneShuffleReady
        : selectedGame.playerTwoShuffleReady
      : false;
  const allShuffleReady = Boolean(
    selectedGame?.playerOneShuffleReady && selectedGame.playerTwoShuffleReady
  );
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
  const topSeat = playerSeat === 1 ? 0 : 1;
  const topSeatAddress = selectedGame
    ? topSeat === 0
      ? selectedGame.playerOne
      : selectedGame.playerTwo
    : undefined;
  const topSeatHasCards = selectedGame
    ? topSeat === 0
      ? selectedGame.playerOneHandDealt
      : selectedGame.playerTwoHandDealt
    : false;
  const topSeatActive = selectedGame?.status === 2 && selectedGame.turn === topSeat;
  const bottomSeatActive = selectedGame?.status === 2 && playerSeat !== null && selectedGame.turn === playerSeat;
  const bottomSeatNumber = playerSeat === null ? null : playerSeat + 1;
  const playerTableLabel = bottomSeatNumber === null ? (isConnected ? "Spectator" : "Not seated") : `Seat ${bottomSeatNumber}`;
  const winnerSeatLabel = (() => {
    if (!selectedGame || selectedGame.winner === zeroAddress) return null;
    if (selectedGame.winner.toLowerCase() === selectedGame.playerOne.toLowerCase()) return "Seat 1";
    if (selectedGame.winner.toLowerCase() === selectedGame.playerTwo.toLowerCase()) return "Seat 2";
    return "Settled";
  })();
  const playerHasCards = Boolean(playerHandDealt || selectedGame?.handCount === 2);
  const tablePrompt = (() => {
    if (!selectedGame) return "Choose a table";
    if (selectedGame.status === 1) return "Waiting for seat 2";
    if (selectedGame.status === 2 && selectedGame.handCount === 0 && !allShuffleReady) {
      return "Submit encrypted shuffle";
    }
    if (selectedGame.status === 2 && selectedGame.handCount === 0) return "Ready to deal";
    if (selectedGame.status === 2 && playerSeat === selectedGame.turn) return "Your turn";
    if (selectedGame.status === 2) return `Seat ${selectedGame.turn + 1} to act`;
    if (selectedGame.status === 3) return "Settle or timeout";
    if (selectedGame.status === 4 && selectedGame.winner === zeroAddress) return "Split pot";
    if (selectedGame.status === 4) return "Finished";
    if (selectedGame.status === 5) return "Cancelled";
    return statusLabel;
  })();

  const notify = useCallback((next: Toast) => {
    setToast(next);
    window.setTimeout(() => setToast(null), 4600);
  }, []);

  const clearPrivateView = useCallback(() => {
    setHand(null);
    setScore(null);
  }, []);

  const navigate = useCallback((pathname: string) => {
    const nextRoute = parseAppRoute(pathname);
    if (routeGameId(nextRoute) !== routeGameId(route)) {
      clearPrivateView();
    }
    if (window.location.pathname !== pathname) {
      window.history.pushState(null, "", pathname);
    }
    setRoute(nextRoute);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [clearPrivateView, route]);

  const handleRouteClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, pathname: string) => {
      event.preventDefault();
      navigate(pathname);
    },
    [navigate]
  );

  useEffect(() => {
    const onPopState = () => {
      const nextRoute = parseAppRoute(window.location.pathname);
      setRoute((currentRoute) => {
        if (routeGameId(nextRoute) !== routeGameId(currentRoute)) {
          clearPrivateView();
        }
        return nextRoute;
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [clearPrivateView]);

  useEffect(() => {
    document.title = routeTitle(route);
    if (route.gameId) setSelectedGameId(route.gameId);
  }, [route]);

  const hydrateWallet = useCallback(async (provider: EIP1193Provider, requestedAccounts?: Address[]) => {
    const accounts =
      requestedAccounts ??
      ((await provider.request({ method: "eth_accounts" })) as Address[]);
    const activeAddress = accounts[0];
    const chainHex = (await provider.request({ method: "eth_chainId" })) as string;

    if (!activeAddress) {
      clearPrivateView();
      setAddress(undefined);
      setWalletClient(undefined);
      return;
    }

    setAddress((currentAddress) => {
      if (currentAddress?.toLowerCase() !== activeAddress.toLowerCase()) {
        clearPrivateView();
      }
      return activeAddress;
    });
    setChainId(Number(chainHex));
    setWalletClient(
      createWalletClient({
        account: activeAddress,
        chain: requiredChain,
        transport: custom(provider),
      })
    );
  }, [clearPrivateView]);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;

    void hydrateWallet(provider);

    const onAccountsChanged = (accounts: unknown) => {
      void hydrateWallet(provider, accounts as Address[]);
    };
    const onChainChanged = (chain: unknown) => {
      clearPrivateView();
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

  const connectCofhe = useCallback(async (options: { permit?: boolean } = {}) => {
    const clients = await ensureWallet();
    const cofhe = await loadCofhe();
    await cofhe.cofheClient.connect(
      clients.publicClient as never,
      clients.walletClient as never
    );
    if (options.permit !== false) {
      await cofhe.cofheClient.permits.getOrCreateSelfPermit();
    }
    return { ...clients, ...cofhe };
  }, [ensureWallet]);

  const readPublicGame = useCallback(async (gameId: bigint) => {
    if (!isContractReady || !contractAddress) {
      throw new Error("Set VITE_DARKGAME_ADDRESS to a deployed DarkGame contract.");
    }

    return publicClient.readContract({
      address: contractAddress,
      abi: darkGameAbi,
      functionName: "getPublicGame",
      args: [gameId],
    }) as Promise<Game>;
  }, [isContractReady]);

  const refreshGames = useCallback(async (preferredGameId?: bigint, silent = false) => {
    if (!isContractReady || !contractAddress) return;

    try {
      if (!silent) setBusy("Refreshing tables");
      const nextId = (await publicClient.readContract({
        address: contractAddress,
        abi: darkGameAbi,
        functionName: "nextGameId",
      })) as bigint;

      const latestIds: bigint[] = [];
      for (let id = nextId - 1n; id > 0n && latestIds.length < 12; id -= 1n) {
        latestIds.push(id);
      }
      const indexedIds: bigint[] = [];
      if (deploymentStartBlock !== undefined) {
        try {
          const createdLogs = await publicClient.getContractEvents({
            address: contractAddress,
            abi: darkGameAbi,
            eventName: "GameCreated",
            fromBlock: deploymentStartBlock,
            toBlock: "latest",
            strict: true,
          });
          indexedIds.push(
            ...createdLogs
              .map((log) => log.args.gameId)
              .filter((id): id is bigint => typeof id === "bigint" && id > 0n && id < nextId)
              .reverse()
          );
        } catch {
          // Some public RPCs limit historical log scans; the latest window below keeps the app usable.
        }
      }
      const pinnedIds = [preferredGameId, route.gameId].filter(
        (id): id is bigint => Boolean(id && id > 0n && id < nextId)
      );
      const ids = Array.from(
        new Set([...pinnedIds, ...indexedIds, ...latestIds].map((id) => id.toString()))
      )
        .slice(0, 150)
        .map((id) => BigInt(id));

      const loaded = await Promise.all(ids.map((id) => readPublicGame(id)));
      const sorted = sortGames(loaded);

      setGames(sorted);
      setSelectedGameId((current) => {
        if (preferredGameId && sorted.some((game) => game.id === preferredGameId)) {
          return preferredGameId;
        }
        if (route.gameId) {
          return route.gameId;
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
  }, [isContractReady, notify, readPublicGame, route.gameId]);

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
        try {
          const nextPlayerState = (await publicClient.readContract({
            address: contractAddress,
            abi: darkGameAbi,
            functionName: "getPlayerState",
            args: [selectedGame.id, address],
          })) as PlayerState;
          setPlayerState(nextPlayerState);
        } catch {
          setPlayerState(null);
        }
      } else {
        setPlayerState(null);
      }
    } catch {
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
    preferredGameId?: bigint,
    onConfirmed?: (receipt: TransactionReceipt) => bigint | void | Promise<bigint | void>
  ) {
    setBusy(label);
    try {
      const clients = await ensureWallet();
      const hash = await tx(clients);
      const receipt = await waitForSuccessfulReceipt(clients.publicClient, hash, label);
      const confirmedGameId = await onConfirmed?.(receipt);
      const refreshGameId = typeof confirmedGameId === "bigint" ? confirmedGameId : preferredGameId;
      notify({ tone: "success", text: `${label} confirmed.` });
      setHand(null);
      setScore(null);
      await refreshGames(refreshGameId);
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
    let expectedGameId =
      games.length > 0
        ? games.reduce((highest, game) => (game.id > highest ? game.id : highest), 0n) + 1n
        : 1n;

    if (isContractReady && contractAddress) {
      try {
        expectedGameId = (await publicClient.readContract({
          address: contractAddress,
          abi: darkGameAbi,
          functionName: "nextGameId",
        })) as bigint;
      } catch {
        // Keep the optimistic local id; the transaction result will still refresh the lobby.
      }
    }

    await runTx(
      "Create table",
      (clients) =>
        clients.walletClient.writeContract({
          address: clients.contractAddress,
          abi: darkGameAbi,
          functionName: "createGame",
          args: [value],
          value,
          gas: gasLimits.createGame,
          account: clients.account,
          chain: requiredChain,
        }),
      expectedGameId,
      (receipt) => {
        const createdGameId = gameCreatedIdFromReceipt(receipt) ?? expectedGameId;
        navigate(`/room/${createdGameId.toString()}`);
        return createdGameId;
      }
    );
  }

  async function joinGame(id = joinId) {
    const normalizedId = id.trim();
    if (!normalizedId || !/^\d+$/.test(normalizedId)) {
      notify({ tone: "error", text: "Select or enter a table ID first." });
      return;
    }

    const requestedGameId = BigInt(normalizedId);
    let game = games.find((item) => item.id === requestedGameId);
    if (!game) {
      setBusy("Loading table");
      try {
        game = await readPublicGame(requestedGameId);
        setGames((currentGames) => upsertGame(currentGames, game as Game));
        setSelectedGameId(game.id);
      } catch {
        notify({ tone: "error", text: "That table was not found on-chain." });
        return;
      } finally {
        setBusy(null);
      }
    }
    if (game.status !== 1) {
      notify({ tone: "error", text: "That table is not open for joining." });
      return;
    }
    if (address && game.playerOne.toLowerCase() === address.toLowerCase()) {
      notify({ tone: "error", text: "Use a second wallet to join this table." });
      return;
    }

    await runTx("Join table", (clients) =>
      clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "joinGame",
        args: [game.id],
        value: game.buyIn,
        gas: gasLimits.joinGame,
        account: clients.account,
        chain: requiredChain,
      }),
      game.id,
      () => {
        navigate(`/game/${game.id.toString()}`);
        return game.id;
      }
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
        gas: gasLimits.act,
        account: clients.account,
        chain: requiredChain,
      }),
      selectedGame.id
    );
  }

  async function submitShuffleEntropy() {
    if (!selectedGame) return;

    setBusy("Encrypting shuffle");
    try {
      const clients = await connectCofhe({ permit: false });
      const shares = createShuffleShares();
      const encryptedEntropy = (await clients.cofheClient
        .encryptInputs(shares.map((share) => clients.Encryptable.uint8(share)))
        .execute()) as unknown as ShuffleEntropyInput;

      const hash = await clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "submitShuffleEntropy",
        args: [selectedGame.id, encryptedEntropy],
        gas: gasLimits.submitShuffleEntropy,
        account: clients.account,
        chain: requiredChain,
      });

      await waitForSuccessfulReceipt(clients.publicClient, hash, "Submit shuffle");
      notify({ tone: "success", text: "Encrypted shuffle submitted." });
      clearPrivateView();
      await refreshGames(selectedGame.id);
      await refreshWalletState();
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "Unable to submit shuffle." });
    } finally {
      setBusy(null);
    }
  }

  async function dealHand() {
    if (!selectedGame) return;
    await runTx("Deal cards", (clients) =>
      clients.walletClient.writeContract({
        address: clients.contractAddress,
        abi: darkGameAbi,
        functionName: "dealHands",
        args: [selectedGame.id],
        gas: gasLimits.dealHands,
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
        gas: gasLimits.cancelOpenGame,
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
        gas: gasLimits.claimTimeout,
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
        gas: gasLimits.withdraw,
        account: clients.account,
        chain: requiredChain,
      })
    );
  }

  async function revealHand() {
    if (!selectedGame || !contractAddress) return;

    try {
      setBusy("Decrypting hand");
      const clients = await connectCofhe({ permit: true });
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
      const clients = await connectCofhe({ permit: false });
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
        gas: gasLimits.settleEncryptedWinner,
        account: clients.account,
        chain: requiredChain,
      });

      await waitForSuccessfulReceipt(clients.publicClient, hash, "Settle winner");
      notify({ tone: "success", text: "Winner settled on-chain." });
      await refreshGames();
      await refreshWalletState();
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "Unable to settle winner." });
    } finally {
      setBusy(null);
    }
  }

  const canUseContract = isContractReady && isConnected && !needsNetwork;
  const canSubmitShuffle =
    canUseContract &&
    selectedGame?.status === 2 &&
    selectedGame.handCount === 0 &&
    playerSeat !== null &&
    !playerShuffleReady;
  const canDeal =
    canUseContract &&
    selectedGame?.status === 2 &&
    playerSeat !== null &&
    selectedGame.handCount === 0 &&
    allShuffleReady;
  const canAct =
    canUseContract &&
    selectedGame?.status === 2 &&
    selectedGame.handCount === 2 &&
    playerSeat === selectedGame.turn;
  const canCheck = canAct && owedToCall === 0n;
  const canBet = canAct && owedToCall === 0n;
  const canCall = canAct && owedToCall > 0n;
  const canFold = canAct;
  const canReveal = canUseContract && playerSeat !== null && playerHandDealt;
  const canSettle = canUseContract && selectedGame?.status === 3;
  const canTimeout = Boolean(
    canUseContract &&
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

  const openTableCount = games.filter((game) => game.status === 1).length;
  const activeTableCount = games.filter((game) => game.status === 2 || game.status === 3).length;
  const finishedTableCount = games.filter((game) => game.status === 4).length;
  const selectedGamePath = selectedGame ? `/game/${selectedGame.id.toString()}` : "/lobby";
  const homeTableLabel = selectedGame
    ? `#${selectedGame.id.toString()} · ${formatEther(selectedGame.buyIn)} ETH buy-in`
    : "No table selected";
  const homeTimerLabel =
    selectedGame && selectedGame.deadline > 0n
      ? secondsLeft > 0
        ? formatTimer(secondsLeft)
        : "Timeout ready"
      : "No active timer";
  const isSelectedCreator =
    Boolean(
      selectedGame &&
        address &&
        selectedGame.playerOne.toLowerCase() === address.toLowerCase()
    );
  const canJoinSelectedRoom =
    Boolean(selectedGame?.status === 1 && isContractReady && isConnected && !needsNetwork && !isSelectedCreator);

  function renderLobbyPanel() {
    return (
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
          <button className="primary-button compact" type="button" onClick={createGame} disabled={!canUseContract}>
            <Plus size={16} />
            Create
          </button>
        </div>

        <div className="join-row">
          <label>
            Table ID
            <input value={joinId} onChange={(event) => setJoinId(event.target.value)} inputMode="numeric" />
          </label>
          <button className="ghost-button compact" type="button" onClick={() => joinGame()} disabled={!joinId || !canUseContract}>
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
                  navigate(`/room/${game.id.toString()}`);
                }}
              >
                <span>#{game.id.toString()}</span>
                <strong>{statusLabels[game.status]}</strong>
                <small>
                  {formatEther(game.buyIn)} ETH
                  {game.status === 1 ? " · open seat" : ""}
                </small>
              </button>
            ))
          )}
        </div>
      </aside>
    );
  }

  function renderTableStage() {
    return (
      <section className="table-stage">
        <div className="table-surface">
          <div className={`opponent-seat seat ${topSeatActive ? "active-seat" : ""}`}>
            <div>
              <span>Seat {topSeat + 1}</span>
              <strong>{topSeatHasCards ? "In hand" : "Waiting"}</strong>
            </div>
            {selectedGame?.winner === topSeatAddress && selectedGame?.winner !== zeroAddress && (
              <Crown size={18} />
            )}
          </div>

          <div className="opponent-cards card-row" aria-label="Opponent hand">
            {topSeatHasCards ? (
              <>
                <CardBack label="Opponent hidden card one" />
                <CardBack label="Opponent hidden card two" />
              </>
            ) : (
              <>
                <div className="card-slot" />
                <div className="card-slot" />
              </>
            )}
          </div>

          <div className="pot-core">
            <div className="chip-stack" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <span className="eyebrow">Pot</span>
            <strong>{selectedGame ? `${formatEther(selectedGame.pot)} ETH` : "0 ETH"}</strong>
            <div className={`status-chip status-${statusLabel.toLowerCase()}`}>{statusLabel}</div>
          </div>

          <div className="table-message">
            <span>{tablePrompt}</span>
            {Boolean(selectedGame?.deadline && selectedGame.deadline > 0n) && (
              <strong>
                <Clock3 size={15} />
                {formatTimer(secondsLeft)}
              </strong>
            )}
          </div>

          <div className="hand-zone card-row" aria-label="Private hand">
            {hand ? (
              hand.map((card, index) => <CardFace card={card} key={`${card.rank}-${card.suit}-${index}`} />)
            ) : playerHasCards ? (
              <>
                <CardBack label="Private hidden card one" />
                <CardBack label="Private hidden card two" />
              </>
            ) : (
              <>
                <div className="card-slot" />
                <div className="card-slot" />
              </>
            )}
          </div>

          <div className={`player-seat seat ${bottomSeatActive ? "active-seat" : ""}`}>
            <div>
              <span>{playerTableLabel}</span>
              <strong>{playerSeat === null ? "Private view locked" : "Private view"}</strong>
            </div>
            {selectedGame?.winner === address && selectedGame?.winner !== zeroAddress && (
              <Crown size={18} />
            )}
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
          <button className="ghost-button" type="button" onClick={submitShuffleEntropy} disabled={!canSubmitShuffle}>
            <RefreshCw size={17} />
            Submit Shuffle
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
    );
  }

  function renderInspectorPanel() {
    return (
      <aside className="inspector-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">State</span>
            <h2>On-chain</h2>
          </div>
        </div>

        <dl className="stats-list">
          <div>
            <dt>Players</dt>
            <dd>
              <Users size={15} />
              {selectedGame?.playerTwo && selectedGame.playerTwo !== zeroAddress ? "2/2" : "1/2"}
            </dd>
          </div>
          <div>
            <dt>Table</dt>
            <dd>{selectedGame ? `#${selectedGame.id.toString()}` : "None"}</dd>
          </div>
          <div>
            <dt>Turn</dt>
            <dd>{selectedGame?.status === 2 ? `Seat ${selectedGame.turn + 1}` : "Closed"}</dd>
          </div>
          <div>
            <dt>Shuffle</dt>
            <dd>{playerState?.shuffleReady ? "Your share submitted" : `${Number(Boolean(selectedGame?.playerOneShuffleReady)) + Number(Boolean(selectedGame?.playerTwoShuffleReady))}/2`}</dd>
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
            <dd>{score !== null ? score.toString() : "Encrypted"}</dd>
          </div>
          <div>
            <dt>Pending</dt>
            <dd>{`${formatEther(pendingWithdrawal)} ETH`}</dd>
          </div>
          <div>
            <dt>Winner</dt>
            <dd>
              {selectedGame?.status === 4 && selectedGame.winner === zeroAddress ? (
                "Split pot"
              ) : selectedGame?.winner && selectedGame.winner !== zeroAddress ? (
                <>
                  <Trophy size={15} />
                  {winnerSeatLabel}
                </>
              ) : (
                "Encrypted"
              )}
            </dd>
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
    );
  }

  function renderMissingTable() {
    return (
      <section className="missing-page">
        <Gamepad2 size={30} />
        <h1>Table not found</h1>
        <p>The requested room is not in the latest on-chain table window.</p>
        <button className="primary-button" type="button" onClick={() => navigate("/lobby")}>
          <Users size={17} />
          Open Lobby
        </button>
      </section>
    );
  }

  function renderHomePage() {
    return (
      <section className="home-page">
        <div className="home-hero">
          <div className="hero-copy">
            <span className="eyebrow">CoFHE testnet game</span>
            <h1>Private high-card, settled on-chain.</h1>
            <p>
              Create a table, join with a second wallet, decrypt only your hand, and settle the encrypted high-card
              result through the contract.
            </p>
            <div className="hero-actions">
              <button className="primary-button" type="button" onClick={() => navigate("/lobby")}>
                <Users size={17} />
                Open Lobby
              </button>
              <button className="ghost-button" type="button" onClick={() => navigate(selectedGamePath)}>
                <Gamepad2 size={17} />
                Current Table
              </button>
            </div>
          </div>

          <div className="hero-table" aria-label="DarkGame table preview">
            <div className="hero-table-felt">
              <div className="preview-seat top">Seat 1</div>
              <div className="preview-cards">
                <CardBack label="Encrypted preview card one" />
                <CardBack label="Encrypted preview card two" />
              </div>
              <div className="preview-pot">
                <span>Live pot</span>
                <strong>{selectedGame ? `${formatEther(selectedGame.pot)} ETH` : "0 ETH"}</strong>
              </div>
              <div className="preview-seat bottom">Seat 2</div>
            </div>
          </div>
        </div>

        <div className="home-stats">
          <div>
            <span>Open</span>
            <strong>{openTableCount}</strong>
          </div>
          <div>
            <span>Active</span>
            <strong>{activeTableCount}</strong>
          </div>
          <div>
            <span>Finished</span>
            <strong>{finishedTableCount}</strong>
          </div>
          <div>
            <span>Contract</span>
            <strong>{isContractReady ? "Configured" : "Pending"}</strong>
          </div>
        </div>

        <section className="home-detail-grid" aria-label="DarkGame readiness details">
          <article className="page-panel home-flow-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">End to end</span>
                <h2>Private table flow</h2>
              </div>
              <div className={`status-chip status-${statusLabel.toLowerCase()}`}>{statusLabel}</div>
            </div>

            <div className="flow-rail">
              <div className="flow-step">
                <span className="flow-icon">
                  <Plus size={18} />
                </span>
                <div>
                  <strong>Create or join</strong>
                  <p>Both players lock the same buy-in on-chain before a hand can start.</p>
                </div>
              </div>
              <div className="flow-step">
                <span className="flow-icon">
                  <RefreshCw size={18} />
                </span>
                <div>
                  <strong>Encrypted shuffle</strong>
                  <p>Each seat contributes encrypted shuffle entropy, then the contract deals two private cards.</p>
                </div>
              </div>
              <div className="flow-step">
                <span className="flow-icon">
                  <Eye size={18} />
                </span>
                <div>
                  <strong>Private reveal</strong>
                  <p>Cards stay hidden from the table; only the seated wallet can decrypt its own hand.</p>
                </div>
              </div>
              <div className="flow-step">
                <span className="flow-icon">
                  <BadgeCheck size={18} />
                </span>
                <div>
                  <strong>Settle and withdraw</strong>
                  <p>The encrypted winner result moves funds into pull payouts, including split-pot ties.</p>
                </div>
              </div>
            </div>
          </article>

          <aside className="page-panel home-live-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Live chain</span>
                <h2>Current table</h2>
              </div>
              <Gamepad2 size={22} />
            </div>

            <div className="proof-list">
              <div>
                <span>Selected</span>
                <strong>{homeTableLabel}</strong>
                <small>{tablePrompt}</small>
              </div>
              <div>
                <span>Network</span>
                <strong>{requiredChain.name}</strong>
                <small>Chain ID {requiredChain.id}</small>
              </div>
              <div>
                <span>Action timer</span>
                <strong>{homeTimerLabel}</strong>
                <small>Hands, turns, and reveal windows can recover on timeout.</small>
              </div>
              <div>
                <span>Your withdrawal</span>
                <strong>{formatEther(pendingWithdrawal)} ETH</strong>
                <small>Winnings stay claimable from the contract.</small>
              </div>
            </div>

            <button className="ghost-button" type="button" onClick={() => navigate(selectedGamePath)}>
              <Gamepad2 size={17} />
              Inspect Table
            </button>
          </aside>
        </section>

        <section className="home-assurance-grid" aria-label="DarkGame production safeguards">
          <article className="assurance-card">
            <Shield size={21} />
            <h3>CoFHE-gated hands</h3>
            <p>Private hand decryptions are granted only to the wallet seated in the game.</p>
          </article>
          <article className="assurance-card">
            <TimerReset size={21} />
            <h3>Timeout recovery</h3>
            <p>Open rooms, stalled turns, and reveal delays have contract-level exits.</p>
          </article>
          <article className="assurance-card">
            <CircleDollarSign size={21} />
            <h3>Pull payouts</h3>
            <p>Settled funds are withdrawn by players, reducing payout failure risk.</p>
          </article>
          <article className="assurance-card">
            <Trophy size={21} />
            <h3>Split-pot ties</h3>
            <p>Equal encrypted scores finish cleanly with both players able to claim.</p>
          </article>
        </section>
      </section>
    );
  }

  function renderLobbyPage() {
    return (
      <section className="lobby-page page-grid">
        {renderLobbyPanel()}
        <section className="page-panel directory-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Rooms</span>
              <h2>On-chain directory</h2>
            </div>
            <div className="status-chip status-active">{games.length} loaded</div>
          </div>

          <div className="room-list">
            {games.length === 0 ? (
              <div className="empty-state">
                <Shield size={24} />
                <span>Create the first testnet table</span>
              </div>
            ) : (
              games.map((game) => (
                <article className="room-row" key={game.id.toString()}>
                  <div>
                    <span className="eyebrow">Table #{game.id.toString()}</span>
                    <h3>{statusLabels[game.status]}</h3>
                    <p>
                      {formatEther(game.buyIn)} ETH buy-in · pot {formatEther(game.pot)} ETH
                    </p>
                  </div>
                  <div className="room-row-actions">
                    <button className="ghost-button compact" type="button" onClick={() => navigate(`/room/${game.id}`)}>
                      Room
                    </button>
                    <button className="primary-button compact" type="button" onClick={() => navigate(`/game/${game.id}`)}>
                      Play
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </section>
    );
  }

  function renderRoomPage() {
    if (!selectedGame) return renderMissingTable();

    return (
      <section className="room-page page-grid">
        <section className="page-panel room-brief">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Room #{selectedGame.id.toString()}</span>
              <h2>{statusLabel}</h2>
            </div>
            <div className={`status-chip status-${statusLabel.toLowerCase()}`}>{statusLabel}</div>
          </div>

          <div className="room-summary-grid">
            <div>
              <span>Buy-in</span>
              <strong>{formatEther(selectedGame.buyIn)} ETH</strong>
            </div>
            <div>
              <span>Pot</span>
              <strong>{formatEther(selectedGame.pot)} ETH</strong>
            </div>
            <div>
              <span>Current bet</span>
              <strong>{formatEther(selectedGame.currentBet)} ETH</strong>
            </div>
            <div>
              <span>Deadline</span>
              <strong>{selectedGame.deadline > 0n ? formatTimer(secondsLeft) : "None"}</strong>
            </div>
          </div>

          <div className="seat-grid">
            <div className={`seat-card ${playerSeat === 0 ? "is-you" : ""}`}>
              <span>Seat 1</span>
              <strong>{playerSeat === 0 ? "You" : "Private"}</strong>
              <small>
                {selectedGame.playerOneHandDealt
                  ? "Hand dealt"
                  : selectedGame.playerOneShuffleReady
                    ? "Shuffle ready"
                    : "Waiting"}
              </small>
            </div>
            <div className={`seat-card ${playerSeat === 1 ? "is-you" : ""}`}>
              <span>Seat 2</span>
              <strong>{playerSeat === 1 ? "You" : selectedGame.playerTwo === zeroAddress ? "Open" : "Private"}</strong>
              <small>
                {selectedGame.playerTwoHandDealt
                  ? "Hand dealt"
                  : selectedGame.playerTwoShuffleReady
                    ? "Shuffle ready"
                    : "Open"}
              </small>
            </div>
          </div>

          <div className="room-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => joinGame(selectedGame.id.toString())}
              disabled={!canJoinSelectedRoom}
            >
              <LogIn size={17} />
              Join Room
            </button>
            <button className="ghost-button" type="button" onClick={() => navigate(selectedGamePath)}>
              <Gamepad2 size={17} />
              Open Table
            </button>
            <button className="ghost-button" type="button" onClick={withdrawPayout} disabled={!canWithdraw}>
              <CircleDollarSign size={17} />
              Withdraw
            </button>
          </div>
        </section>

        {renderInspectorPanel()}
      </section>
    );
  }

  function renderGamePage() {
    if (!selectedGame) return renderMissingTable();

    return (
      <section className="game-page">
        {renderTableStage()}
        {renderInspectorPanel()}
      </section>
    );
  }

  function renderProtocolPage() {
    return (
      <section className="protocol-page">
        <section className="page-panel protocol-hero">
          <span className="eyebrow">Protocol</span>
          <h1>Encrypted state, public settlement.</h1>
          <p>
            DarkGame keeps private hands behind CoFHE ACLs, combines encrypted shuffle shares, and reveals only the
            final high-card winner code for proof-backed settlement.
          </p>
        </section>

        <section className="protocol-grid">
          <article className="protocol-card">
            <Shield size={22} />
            <h3>Private hands</h3>
            <p>Card handles are allowed to the contract and the seated wallet only.</p>
          </article>
          <article className="protocol-card">
            <Eye size={22} />
            <h3>Local reveal</h3>
            <p>`decryptForView` renders a player hand without publishing the cards.</p>
          </article>
          <article className="protocol-card">
            <BadgeCheck size={22} />
            <h3>Verified winner</h3>
            <p>`decryptForTx` returns a signature checked by `FHE.verifyDecryptResult`, including split-pot ties.</p>
          </article>
          <article className="protocol-card">
            <CircleDollarSign size={22} />
            <h3>Pull payouts</h3>
            <p>Winners withdraw queued balances instead of receiving pushed transfers.</p>
          </article>
        </section>

        <section className="page-panel production-note">
          <h2>Production note</h2>
          <p>
            The deployed contract uses bounded two-party encrypted shuffle shares, no-duplicate high-card dealing,
            exact on-chain betting, proof-backed settlement, reveal timeout recovery, and pull withdrawals.
          </p>
        </section>
      </section>
    );
  }

  return (
    <main className={`app-shell route-${route.page}`}>
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => handleRouteClick(event, "/")}>
          <div className="brand-mark">
            <Shield size={22} />
          </div>
          <div>
            <p>DarkGame</p>
            <span>Encrypted high-card table</span>
          </div>
        </a>

        <nav className="app-nav" aria-label="Primary">
          {navItems.map((item) => (
            <a
              aria-current={route.page === item.page ? "page" : undefined}
              className={route.page === item.page ? "active" : ""}
              href={item.path}
              key={item.path}
              onClick={(event) => handleRouteClick(event, item.path)}
            >
              {item.label}
            </a>
          ))}
          <a
            aria-current={route.page === "game" ? "page" : undefined}
            className={route.page === "game" ? "active" : ""}
            href={selectedGamePath}
            onClick={(event) => handleRouteClick(event, selectedGamePath)}
          >
            Game
          </a>
        </nav>

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
                {needsNetwork ? "Switch" : "Connected"}
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  clearPrivateView();
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
      </header>

      {!isContractReady && (
        <section className="warning-band">
          <AlertTriangle size={18} />
          <span>Deploy DarkGame and set VITE_DARKGAME_ADDRESS before playing.</span>
        </section>
      )}

      {route.page === "home" && renderHomePage()}
      {route.page === "lobby" && renderLobbyPage()}
      {route.page === "room" && renderRoomPage()}
      {route.page === "game" && renderGamePage()}
      {route.page === "protocol" && renderProtocolPage()}

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
