export type DisplayCard = {
  rank: string;
  suit: string;
  color: "red" | "black";
};

const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const suits = [
  { suit: "♠", color: "black" as const },
  { suit: "♥", color: "red" as const },
  { suit: "♣", color: "black" as const },
  { suit: "♦", color: "red" as const },
];

export function cardIndexToCard(value: bigint): DisplayCard {
  const normalized = Number(value % 52n);
  const rankIndex = normalized % ranks.length;
  const suit = suits[Math.floor(normalized / ranks.length) % suits.length];

  return {
    rank: ranks[rankIndex],
    suit: suit.suit,
    color: suit.color,
  };
}

export function shortAddress(address?: string) {
  if (!address) return "Not connected";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
