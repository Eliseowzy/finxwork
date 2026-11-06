import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// pdf.js's data files, served at pdfjs/ beside the page: character maps for Chinese, Japanese
// and Korean fonts, the standard fonts a PDF may not embed, and its image decoders.
const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const pdfjsData = ["cmaps", "standard_fonts", "wasm"];
function pdfjsAssets(): Plugin {
  return {
    name: "finxwork-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = path.normalize(path.join(pdfjsDir, rel));
        if (!pdfjsData.some((d) => file.startsWith(path.join(pdfjsDir, d) + path.sep)) || !fs.existsSync(file)) return next();
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of pdfjsData)
        for (const name of fs.readdirSync(path.join(pdfjsDir, dir)))
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: fs.readFileSync(path.join(pdfjsDir, dir, name)) });
    },
  };
}

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
    plugins: [react(), pdfjsAssets()],
    worker: { format: "es" },
    resolve: { dedupe: ["react", "react-dom"] },
    build: { outDir: path.join(out, "renderer") },
  },
});
