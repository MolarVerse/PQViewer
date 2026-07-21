import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "../pqviewer/static",
    emptyOutDir: true,
    chunkSizeWarningLimit: 520,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three/examples/jsm/") && !id.includes("/controls/")) return "publication";
          if (id.includes("node_modules/three")) return "three";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765",
    },
  },
});
