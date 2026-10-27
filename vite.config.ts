import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        headers: { origin: "http://localhost:3000" },
      },
    },
  },
});
