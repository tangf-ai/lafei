import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { bootstrapDatabase } from "./db";
import { isTauri } from "./lib/util";
import { initializeFolderSync } from "./lib/folderSync";

async function start() {
  try {
    await bootstrapDatabase();
  } catch (error) {
    console.error("Failed to bootstrap database", error);
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  if (import.meta.env.PROD && !isTauri && "serviceWorker" in navigator) {
    void import("virtual:pwa-register").then(({ registerSW }) => {
      registerSW({ immediate: true });
    });
  }

  window.setTimeout(() => {
    void initializeFolderSync();
  }, 300);
}

void start();
