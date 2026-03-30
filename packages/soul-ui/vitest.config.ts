import { defineConfig } from "vitest/config";

const WORKTREE = "/home/eias/seosoyoung-workspace/.projects/soulstream--feed-exclude-filter";
const ORIGINAL = "/home/eias/seosoyoung-workspace/.projects/soulstream";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [`${WORKTREE}/packages/soul-ui/src/**/*.test.ts`],
    alias: {
      "@shared": `${WORKTREE}/packages/soul-ui/src/shared`,
      "@seosoyoung/soul-ui": `${WORKTREE}/packages/soul-ui/src`,
    },
    server: {
      deps: {
        moduleDirectories: [
          `${ORIGINAL}/unified-dashboard/node_modules`,
          `${ORIGINAL}/packages/soul-ui/node_modules`,
          "node_modules",
        ],
        inline: [/zustand/],
      },
    },
  },
});
