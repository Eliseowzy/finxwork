import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import path from "node:path";

// FINXWORK_DESKTOP_OUT builds somewhere other than out/ (scripts/build-app.mjs stages the app there).
const out = process.env.FINXWORK_DESKTOP_OUT || path.join(import.meta.dirname, "out");

// What scripts/build-app.mjs fixes in the app (main/build.ts): where it updates from, and for test builds their folder.
const fixed = {
  __FINXWORK_RELEASES__: JSON.stringify(process.env.FINXWORK_RELEASES ?? ""),
  __FINXWORK_TEST_HOME__: JSON.stringify(process.env.FINXWORK_TEST_HOME ?? ""),
};

export default defineConfig({
  main: {
    // Everything bundled (the workspace packages included): the packaged app ships no node_modules.
    build: { externalizeDeps: false, outDir: path.join(out, "main") },
    define: fixed,
  },
  preload: {
    // A sandboxed preload must be CommonJS.
    build: { outDir: path.join(out, "preload"), rollupOptions: { input: { index: path.resolve("src/preload/index.ts"), browser: path.resolve("src/preload/browser.ts") }, output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    plugins: [react()],
    resolve: { dedupe: ["react", "react-dom"] },
    build: { outDir: path.join(out, "renderer") },
  },
});
