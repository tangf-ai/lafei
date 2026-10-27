import { defineConfig } from "vite";
import pkg from "./package.json";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Lafei — 笔记、任务与 AI",
        short_name: "Lafei",
        description: "把知识收好，把行动理清。一个内置 AI 的本地优先笔记与任务应用。",
        theme_color: "#F4F1EA",
        background_color: "#F4F1EA",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        lang: "zh-CN",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallbackDenylist: [/^\/api/]
      }
    })
  ],
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"]
});
