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
