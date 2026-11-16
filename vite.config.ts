import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  publicDir: ".s0-work/web-assets",
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
