import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// 곡률 정본(globals.css)의 이름을 tailwind-merge에도 등록한다. 등록하지 않으면
// cn("rounded-full", "rounded-floor")가 둘 다 남아 CSS 순서로 알약이 이긴다.
const isRadiusInStep = (value: string) => /^in-\d+$/.test(value);

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["root", "floor", "mark"],
    },
    classGroups: {
      rounded: [{ rounded: [isRadiusInStep] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
