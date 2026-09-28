import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webRoot = fileURLToPath(new URL("./web", import.meta.url));
const webSrc = fileURLToPath(new URL("./web/src", import.meta.url));
const webOut = fileURLToPath(new URL("./dist/web", import.meta.url));
const contracts = fileURLToPath(new URL("./src/contracts", import.meta.url));
const nodeModules = fileURLToPath(new URL("./node_modules", import.meta.url));

/**
 * The development server's exposure. The SPA and its /api proxy are one
 * origin, so no other origin needs CORS: Vite's default would let any page on
 * another localhost port read conversations through the proxy. It serves
 * only the web app, the shared contracts and dependencies (fs.allow), never
 * the state directory (./data, the SQLite database), configuration or keys. Remote images are
 * refused, as in production (src/server/security.ts); scripts are not
 * restricted here because Vite's development client runs inline code.
 */
export const DEV_SERVER_SECURITY = {
  cors: false,
  fs: {
    strict: true,
    allow: [webRoot, contracts, nodeModules],
    deny: [
      ".env",
      ".env.*",
      "*.{crt,pem,key,p12,pfx,cer,der}",
      ".npmrc",
      "**/.git/**",
      "**/*.sqlite*",
    ],
  },
  headers: {
    "Content-Security-Policy": "img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  },
} as const;

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
    cors: DEV_SERVER_SECURITY.cors,
    fs: {
      strict: DEV_SERVER_SECURITY.fs.strict,
      allow: [...DEV_SERVER_SECURITY.fs.allow],
      deny: [...DEV_SERVER_SECURITY.fs.deny],
    },
    headers: { ...DEV_SERVER_SECURITY.headers },
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
    cors: false,
  },
  build: {
    outDir: webOut,
    emptyOutDir: true,
    sourcemap: true,
  },
});
