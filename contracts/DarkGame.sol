// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint8} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract DarkGame is ReentrancyGuard {
    enum GameStatus {
        None,
        Open,
        Active,
        AwaitingReveal,
        Finished,
        Cancelled
    }

    enum PlayerAction {
        Check,
        Bet,
        Call,
        Fold
    }

    struct PublicGame {
        uint256 id;
        address playerOne;
        address playerTwo;
        uint256 buyIn;
        uint256 pot;
        uint8 handCount;
        GameStatus status;
        uint8 turn;
        uint8 actionCount;
        address winner;
        bool playerOneHandDealt;
        bool playerTwoHandDealt;
        uint256 currentBet;
        uint256 playerOneRoundStake;
        uint256 playerTwoRoundStake;
        uint256 deadline;
        uint256 createdAt;
        uint256 updatedAt;
    }

    struct PlayerView {
        bool joined;
        bool acted;
        bool folded;
        bool handDealt;
        uint256 committed;
        uint256 roundStake;
        uint256 pendingWithdrawal;
    }

    struct PlayerState {
        address wallet;
        bool joined;
        bool acted;
        bool folded;
        bool handSubmitted;
        uint256 committed;
        uint256 roundStake;
        euint8 cardA;
        euint8 cardB;
        euint8 score;
    }

    struct GameState {
        uint256 id;
        uint256 buyIn;
        uint256 pot;
        GameStatus status;
        uint8 turn;
        uint8 actionCount;
        uint8 handCount;
        euint8 winnerCode;
        address winner;
        uint256 currentBet;
        uint256 deadline;
        uint256 createdAt;
        uint256 updatedAt;
    }

    uint256 public constant HAND_TIMEOUT = 20 minutes;
    uint256 public constant ACTION_TIMEOUT = 20 minutes;
    uint256 public constant REVEAL_TIMEOUT = 20 minutes;

    uint256 public nextGameId = 1;
    mapping(uint256 => GameState) private games;
    mapping(uint256 => mapping(uint8 => PlayerState)) private players;
    mapping(address => uint256) public pendingWithdrawals;

    event GameCreated(
        uint256 indexed gameId,
        address indexed creator,
        uint256 buyIn
    );
    event GameJoined(
        uint256 indexed gameId,
        address indexed challenger,
        uint256 pot
    );
    event CardsDealt(uint256 indexed gameId);
    event HandSubmitted(uint256 indexed gameId, address indexed player);
    event PlayerActed(
        uint256 indexed gameId,
        address indexed player,
        PlayerAction action,
        uint256 value
    );
    event WinnerReady(uint256 indexed gameId, euint8 encryptedWinnerCode);
    event GameSettled(
        uint256 indexed gameId,
        address indexed winner,
        uint8 winnerSeat,
        uint256 payout
    );
    event GameCancelled(uint256 indexed gameId);
    event GameTimedOut(uint256 indexed gameId, address indexed caller);
    event WithdrawalQueued(address indexed recipient, uint256 amount);
    event WithdrawalClaimed(address indexed recipient, uint256 amount);

    error InvalidBuyIn();
    error InvalidGame();
    error InvalidStatus();
    error InvalidSeat();
    error NotPlayer();
    error NotTurn();
    error HandsNotReady();
    error HandsAlreadyDealt();
    error InvalidActionValue();
    error SamePlayer();
    error InvalidWinner();
    error InvalidDecryptProof();
    error DeadlineActive();
    error DeadlinePassed();
    error BetOutstanding();
    error NoBetToCall();
    error NoWithdrawal();
    error TransferFailed();

    function createGame(uint256 buyIn)
        external
        payable
        nonReentrant
        returns (uint256 gameId)
    {
        if (buyIn == 0 || msg.value != buyIn) revert InvalidBuyIn();

        gameId = nextGameId++;
        GameState storage game = games[gameId];
        game.id = gameId;
        game.buyIn = buyIn;
        game.pot = msg.value;
        game.status = GameStatus.Open;
        game.createdAt = block.timestamp;
        game.updatedAt = block.timestamp;

        PlayerState storage seatOne = players[gameId][0];
        seatOne.wallet = msg.sender;
        seatOne.joined = true;
        seatOne.committed = msg.value;

        emit GameCreated(gameId, msg.sender, buyIn);
    }

    function joinGame(uint256 gameId) external payable nonReentrant {
        GameState storage game = _game(gameId);
        if (game.status != GameStatus.Open) revert InvalidStatus();
        if (msg.value != game.buyIn) revert InvalidBuyIn();
        if (players[gameId][0].wallet == msg.sender) revert SamePlayer();

        PlayerState storage seatTwo = players[gameId][1];
        seatTwo.wallet = msg.sender;
        seatTwo.joined = true;
        seatTwo.committed = msg.value;

        game.pot += msg.value;
        game.status = GameStatus.Active;
        game.turn = 0;
        game.deadline = block.timestamp + HAND_TIMEOUT;
        game.updatedAt = block.timestamp;

        emit GameJoined(gameId, msg.sender, game.pot);
    }

    function dealHands(uint256 gameId) external nonReentrant {
        GameState storage game = _game(gameId);
        if (game.status != GameStatus.Active) revert InvalidStatus();
        _seatOf(gameId, msg.sender);
        if (game.handCount != 0) revert HandsAlreadyDealt();
        if (block.timestamp > game.deadline) revert DeadlinePassed();

        uint8[4] memory dealt = _drawFour(gameId);
        _storePlainHand(gameId, 0, dealt[0], dealt[1]);
        _storePlainHand(gameId, 1, dealt[2], dealt[3]);

        players[gameId][0].handSubmitted = true;
        players[gameId][1].handSubmitted = true;
        game.handCount = 2;
        game.turn = 0;
        game.actionCount = 0;
        game.currentBet = 0;
        game.deadline = block.timestamp + ACTION_TIMEOUT;
        game.updatedAt = block.timestamp;

        _refreshWinner(gameId);

        emit HandSubmitted(gameId, players[gameId][0].wallet);
        emit HandSubmitted(gameId, players[gameId][1].wallet);
        emit CardsDealt(gameId);
    }

    function act(uint256 gameId, PlayerAction action)
        external
        payable
        nonReentrant
    {
        GameState storage game = _game(gameId);
        if (game.status != GameStatus.Active) revert InvalidStatus();
        if (game.handCount < 2) revert HandsNotReady();
        if (block.timestamp > game.deadline) revert DeadlinePassed();

        uint8 seat = _seatOf(gameId, msg.sender);
        if (seat != game.turn) revert NotTurn();

        uint8 otherSeat = seat == 0 ? 1 : 0;
        PlayerState storage player = players[gameId][seat];
        PlayerState storage other = players[gameId][otherSeat];

        if (action == PlayerAction.Fold) {
            if (msg.value != 0) revert InvalidActionValue();
            player.folded = true;
            player.acted = true;
            game.actionCount += 1;
            game.updatedAt = block.timestamp;
            emit PlayerActed(gameId, msg.sender, action, msg.value);
            _finishWithWinner(gameId, otherSeat);
            return;
        }

        if (action == PlayerAction.Check) {
            if (msg.value != 0) revert InvalidActionValue();
            if (player.roundStake != game.currentBet) revert BetOutstanding();
            player.acted = true;
        } else if (action == PlayerAction.Bet) {
            if (player.roundStake != game.currentBet) revert BetOutstanding();
            if (msg.value == 0) revert InvalidActionValue();
            player.roundStake += msg.value;
            player.committed += msg.value;
            game.pot += msg.value;
            game.currentBet = player.roundStake;
            player.acted = true;
            other.acted = false;
        } else if (action == PlayerAction.Call) {
            uint256 owed = _owed(gameId, seat);
            if (owed == 0) revert NoBetToCall();
            if (msg.value != owed) revert InvalidActionValue();
            player.roundStake += msg.value;
            player.committed += msg.value;
            game.pot += msg.value;
            player.acted = true;
        }

        game.actionCount += 1;
        game.updatedAt = block.timestamp;
        emit PlayerActed(gameId, msg.sender, action, msg.value);

        if (
            players[gameId][0].acted &&
            players[gameId][1].acted &&
            players[gameId][0].roundStake == players[gameId][1].roundStake
        ) {
            game.status = GameStatus.AwaitingReveal;
            game.deadline = block.timestamp + REVEAL_TIMEOUT;
            FHE.allowPublic(game.winnerCode);
            emit WinnerReady(gameId, game.winnerCode);
        } else {
            game.turn = otherSeat;
            game.deadline = block.timestamp + ACTION_TIMEOUT;
        }
    }

    function settleEncryptedWinner(
        uint256 gameId,
        uint8 winnerSeatCode,
        bytes calldata signature
    ) external nonReentrant {
        GameState storage game = _game(gameId);
        if (game.status != GameStatus.AwaitingReveal) revert InvalidStatus();
        if (winnerSeatCode != 1 && winnerSeatCode != 2) revert InvalidWinner();

        bool isValid = FHE.verifyDecryptResult(
            game.winnerCode,
            winnerSeatCode,
            signature
        );
        if (!isValid) revert InvalidDecryptProof();

        _finishWithWinner(gameId, winnerSeatCode - 1);
    }

    function cancelOpenGame(uint256 gameId) external nonReentrant {
        GameState storage game = _game(gameId);
        if (game.status != GameStatus.Open) revert InvalidStatus();

        PlayerState storage seatOne = players[gameId][0];
        if (seatOne.wallet != msg.sender) revert NotPlayer();

        _cancelAndRefund(gameId);
    }

    function claimTimeout(uint256 gameId) external nonReentrant {
        GameState storage game = _game(gameId);
        if (
            game.status != GameStatus.Active &&
            game.status != GameStatus.AwaitingReveal
        ) revert InvalidStatus();
        if (game.deadline == 0 || block.timestamp <= game.deadline) {
            revert DeadlineActive();
        }

        emit GameTimedOut(gameId, msg.sender);

        if (game.status == GameStatus.Active && game.handCount == 2) {
            _finishWithWinner(gameId, game.turn == 0 ? 1 : 0);
        } else {
            _cancelAndRefund(gameId);
        }
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NoWithdrawal();

        pendingWithdrawals[msg.sender] = 0;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        if (!sent) {
            pendingWithdrawals[msg.sender] = amount;
            revert TransferFailed();
        }

        emit WithdrawalClaimed(msg.sender, amount);
    }

    function getPublicGame(uint256 gameId)
        external
        view
        returns (PublicGame memory)
    {
        GameState storage game = _game(gameId);
        return
            PublicGame({
                id: game.id,
                playerOne: players[gameId][0].wallet,
                playerTwo: players[gameId][1].wallet,
                buyIn: game.buyIn,
                pot: game.pot,
                handCount: game.handCount,
                status: game.status,
                turn: game.turn,
                actionCount: game.actionCount,
                winner: game.winner,
                playerOneHandDealt: players[gameId][0].handSubmitted,
                playerTwoHandDealt: players[gameId][1].handSubmitted,
                currentBet: game.currentBet,
                playerOneRoundStake: players[gameId][0].roundStake,
                playerTwoRoundStake: players[gameId][1].roundStake,
                deadline: game.deadline,
                createdAt: game.createdAt,
                updatedAt: game.updatedAt
            });
    }

    function getPlayerState(uint256 gameId, address account)
        external
        view
        returns (PlayerView memory)
    {
        uint8 seat = _seatOf(gameId, account);
        PlayerState storage player = players[gameId][seat];
        return
            PlayerView({
                joined: player.joined,
                acted: player.acted,
                folded: player.folded,
                handDealt: player.handSubmitted,
                committed: player.committed,
                roundStake: player.roundStake,
                pendingWithdrawal: pendingWithdrawals[account]
            });
    }

    function getPrivateHand(uint256 gameId) external view returns (euint8, euint8) {
        uint8 seat = _seatOf(gameId, msg.sender);
        if (!players[gameId][seat].handSubmitted) revert HandsNotReady();
        return (players[gameId][seat].cardA, players[gameId][seat].cardB);
    }

    function getPrivateScore(uint256 gameId) external view returns (euint8) {
        uint8 seat = _seatOf(gameId, msg.sender);
        if (!players[gameId][seat].handSubmitted) revert HandsNotReady();
        return players[gameId][seat].score;
    }

    function getWinnerHandle(uint256 gameId) external view returns (euint8) {
        GameState storage game = _game(gameId);
        if (
            game.status != GameStatus.AwaitingReveal &&
            game.status != GameStatus.Finished
        ) revert InvalidStatus();
        return game.winnerCode;
    }

    function _storePlainHand(
        uint256 gameId,
        uint8 seat,
        uint8 cardA,
        uint8 cardB
    ) private {
        if (seat > 1) revert InvalidSeat();

        PlayerState storage player = players[gameId][seat];
        euint8 encryptedCardA = FHE.asEuint8(cardA);
        euint8 encryptedCardB = FHE.asEuint8(cardB);
        euint8 rankA = FHE.asEuint8(_rank(cardA));
        euint8 rankB = FHE.asEuint8(_rank(cardB));
        euint8 highCard = FHE.max(rankA, rankB);
        euint8 pairBonus = FHE.select(
            FHE.eq(rankA, rankB),
            FHE.asEuint8(20),
            FHE.asEuint8(0)
        );
        euint8 score = FHE.add(highCard, pairBonus);

        player.cardA = encryptedCardA;
        player.cardB = encryptedCardB;
        player.score = score;

        FHE.allowThis(encryptedCardA);
        FHE.allowThis(encryptedCardB);
        FHE.allowThis(score);
        FHE.allow(encryptedCardA, player.wallet);
        FHE.allow(encryptedCardB, player.wallet);
        FHE.allow(score, player.wallet);
    }

    function _refreshWinner(uint256 gameId) private {
        euint8 seatOneCode = FHE.asEuint8(1);
        euint8 seatTwoCode = FHE.asEuint8(2);
        euint8 seatOneScore = players[gameId][0].score;
        euint8 seatTwoScore = players[gameId][1].score;

        euint8 winnerCode = FHE.select(
            FHE.gte(seatOneScore, seatTwoScore),
            seatOneCode,
            seatTwoCode
        );

        games[gameId].winnerCode = winnerCode;
        FHE.allowThis(winnerCode);
    }

    function _finishWithWinner(uint256 gameId, uint8 winnerSeat) private {
        GameState storage game = games[gameId];
        address winner = players[gameId][winnerSeat].wallet;
        uint256 payout = game.pot;

        game.pot = 0;
        game.winner = winner;
        game.status = GameStatus.Finished;
        game.deadline = 0;
        game.updatedAt = block.timestamp;

        _credit(winner, payout);
        emit GameSettled(gameId, winner, winnerSeat, payout);
    }

    function _cancelAndRefund(uint256 gameId) private {
        GameState storage game = games[gameId];
        uint256 seatOneRefund = players[gameId][0].joined
            ? players[gameId][0].committed
            : 0;
        uint256 seatTwoRefund = players[gameId][1].joined
            ? players[gameId][1].committed
            : 0;

        game.pot = 0;
        game.status = GameStatus.Cancelled;
        game.deadline = 0;
        game.updatedAt = block.timestamp;

        _credit(players[gameId][0].wallet, seatOneRefund);
        _credit(players[gameId][1].wallet, seatTwoRefund);
        emit GameCancelled(gameId);
    }

    function _credit(address recipient, uint256 amount) private {
        if (recipient == address(0) || amount == 0) return;
        pendingWithdrawals[recipient] += amount;
        emit WithdrawalQueued(recipient, amount);
    }

    function _owed(uint256 gameId, uint8 seat) private view returns (uint256) {
        uint256 roundStake = players[gameId][seat].roundStake;
        uint256 currentBet = games[gameId].currentBet;
        if (roundStake >= currentBet) return 0;
        return currentBet - roundStake;
    }

    function _drawFour(uint256 gameId)
        private
        view
        returns (uint8[4] memory dealt)
    {
        bytes32 entropy = keccak256(
            abi.encodePacked(
                block.prevrandao,
                blockhash(block.number - 1),
                address(this),
                gameId,
                games[gameId].createdAt,
                games[gameId].updatedAt,
                players[gameId][0].wallet,
                players[gameId][1].wallet
            )
        );
        uint256 nonce;

        for (uint8 i = 0; i < 4; i++) {
            while (true) {
                uint8 candidate = uint8(
                    uint256(keccak256(abi.encodePacked(entropy, nonce))) % 52
                );
                nonce++;

                bool used;
                for (uint8 j = 0; j < i; j++) {
                    if (dealt[j] == candidate) {
                        used = true;
                        break;
                    }
                }

                if (!used) {
                    dealt[i] = candidate;
                    break;
                }
            }
        }
    }

    function _rank(uint8 card) private pure returns (uint8) {
        return (card % 13) + 2;
    }

    function _game(uint256 gameId)
        private
        view
        returns (GameState storage game)
    {
        game = games[gameId];
        if (game.id == 0) revert InvalidGame();
    }

    function _seatOf(uint256 gameId, address account)
        private
        view
        returns (uint8)
    {
        if (players[gameId][0].wallet == account) return 0;
        if (players[gameId][1].wallet == account) return 1;
        revert NotPlayer();
    }
}
