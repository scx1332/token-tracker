import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy /api/* to the local backend (default port 39100 used during
// development; override with BACKEND_ORIGIN). In production the frontend is
// served by server.js / nginx which handle the same /api prefix.
const backend = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:39100";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
