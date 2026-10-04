export const CARD_COLOR_KEYS = ["yellow", "pink", "mint", "blue", "lavender"] as const;

export type CardColor = (typeof CARD_COLOR_KEYS)[number];

export const CARD_COLORS = {
  yellow: { name: "노랑", hex: "#fff7c6" },
  pink: { name: "연분홍", hex: "#ffede8" },
  mint: { name: "민트", hex: "#e5f4e8" },
  blue: { name: "하늘", hex: "#e8f0fa" },
  lavender: { name: "연보라", hex: "#eee8f6" },
} as const satisfies Record<CardColor, { name: string; hex: string }>;
