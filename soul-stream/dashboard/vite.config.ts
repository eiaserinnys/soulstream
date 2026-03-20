import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: ".",
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../../packages/soul-ui/src/shared"),
      "@seosoyoung/soul-ui": resolve(__dirname, "../../packages/soul-ui/src"),
      "client": resolve(__dirname, "client"),
    },
    // soul-ui 소스를 직접 alias로 참조하므로, soul-ui의 node_modules도 탐색 경로에 포함
    modules: [
      resolve(__dirname, "../../packages/soul-ui/node_modules"),
      resolve(__dirname, "node_modules"),
      "node_modules",
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5201,
    proxy: {
      "/api": {
        target: "http://localhost:5200",
        changeOrigin: true,
      },
    },
  },
});
