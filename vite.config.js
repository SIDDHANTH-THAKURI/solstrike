import { defineConfig } from "vite";

// base "./" so the built dist/ works from any static host or subfolder
// (GitHub Pages, Netlify drag-drop, itch.io zip upload).
export default defineConfig({
  base: "./",
  build: {
    chunkSizeWarningLimit: 1500,
    target: "es2020"
  },
  server: {
    port: 5173,
    strictPort: false
  }
});
