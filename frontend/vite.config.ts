import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    base: env.VITE_BASE_PATH || "/",
    build: {
      outDir: env.PQVIEWER_OUT_DIR || "../pqviewer/static",
      emptyOutDir: true,
      chunkSizeWarningLimit: 520,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/3dmol")) return "3dmol";
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
  };
});
