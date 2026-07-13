import type { VitePWAOptions } from "vite-plugin-pwa";

export const DASHBOARD_PWA_OPTIONS = {
  injectRegister: false,
  registerType: "autoUpdate",
  workbox: {
    skipWaiting: true,
    clientsClaim: true,
    navigateFallback: null,
    importScripts: ["/sw-update-migration.js"],
    globIgnores: [
      "**/index.html",
      "**/manifest.webmanifest",
      "**/registerSW.js",
      "**/sw-update-migration.js",
    ],
    runtimeCaching: [
      {
        urlPattern: ({ request, url }) =>
          request.mode === "navigate"
          && !url.pathname.startsWith("/api/")
          && !url.pathname.startsWith("/cogito"),
        handler: "NetworkFirst",
        options: {
          cacheName: "soulstream-navigation-v1",
        },
      },
    ],
  },
  manifest: {
    name: "Soulstream",
    short_name: "Soulstream",
    description: "Claude Code session hosting dashboard",
    start_url: "/",
    theme_color: "#000000",
    background_color: "#000000",
    display: "standalone",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  },
} satisfies Partial<VitePWAOptions>;
