import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webRoot = fileURLToPath(new URL("./web", import.meta.url));
const webSrc = fileURLToPath(new URL("./web/src", import.meta.url));
const webOut = fileURLToPath(new URL("./dist/web", import.meta.url));

// The API server (src/server/main.ts) listens on 127.0.0.1:4320. In development
// Vite serves the SPA on 4321 and proxies /api to it; in production the API
// server serves the built SPA from dist/web itself.
export default defineConfig({
  root: webRoot,
  // Only VITE_-prefixed variables from web/.env* reach the browser bundle.
  envDir: webRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": webSrc,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4321,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4320",
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4321,
    strictPort: true,
  },
  build: {
    outDir: webOut,
    emptyOutDir: true,
    sourcemap: true,
  },
});
