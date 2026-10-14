import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// The AutoTool UI. Built into autotool/dist and served by the local server (src/server/main.ts).
export default defineConfig({
  root: resolve(import.meta.dirname, "src/ui"),
  base: "./",
  plugins: [svelte()],
  publicDir: false,
  css: { postcss: {} }, // the upstream visualizer's Tailwind config is not ours
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 900 },
  server: { host: "127.0.0.1", fs: { allow: [resolve(import.meta.dirname, "..")] } },
});
