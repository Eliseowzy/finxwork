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

// The metric-compatible stand-ins for Calibri and Cambria (docs/pptx/fonts.ts), served at fonts/ beside the page.
// The same files the kernel embeds (crates/finx-slide/fonts, with their OFL); the packaged renderer carries them as
// assets (build-app.mjs checks they are there). @betteroffice/fonts now ships its faces compressed, in font packs.
const fontsDir = path.join(import.meta.dirname, "../../crates/finx-slide/fonts");
const standInFonts = ["Carlito", "Caladea"].flatMap((f) => ["Regular", "Bold", "Italic", "BoldItalic"].map((s) => `${f}-${s}.ttf`));
function standInFontAssets(): Plugin {
  return {
    name: "finxwork-stand-in-fonts",
    configureServer(server) {
      server.middlewares.use("/fonts", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        if (!standInFonts.includes(name)) return next();
        res.setHeader("Content-Type", "font/ttf");
        fs.createReadStream(path.join(fontsDir, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of standInFonts)
        this.emitFile({ type: "asset", fileName: `fonts/${name}`, source: fs.readFileSync(path.join(fontsDir, name)) });
    },
  };
}

// The Word engine's wasm (@betteroffice/docx), which its modules load with `new URL("./generated/…", import.meta.url)`:
// the main build leaves those URLs as they are, so each file is copied to where the chunk that names it looks.
const docxDist = path.join(import.meta.dirname, "node_modules/@betteroffice/docx/dist"); // its exports leave out package.json
function docxWasm(): Plugin {
  return {
    name: "finxwork-docx-wasm",
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const [, rel] of chunk.code.matchAll(/new URL\("\.\/(generated\/[\w/]+\.wasm)", import\.meta\.url\)/g))
          this.emitFile({ type: "asset", fileName: path.posix.join(path.posix.dirname(chunk.fileName), rel), source: fs.readFileSync(path.join(docxDist, rel)) });
      }
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
    plugins: [docxWasm()],
    // Everything bundled (the workspace packages included): the packaged app ships no node_modules.
    // The docx serializer is a utilityProcess of its own (main/docx/host.ts); its engine's wasm is emitted beside it.
    build: {
      externalizeDeps: false,
      outDir: path.join(out, "main"),
      rollupOptions: { input: { index: path.resolve("src/main/index.ts"), "docx-serializer": path.resolve("src/main/docx/serializer.ts") } },
    },
    define: fixed,
  },
  preload: {
    // A sandboxed preload must be CommonJS.
    build: { outDir: path.join(out, "preload"), rollupOptions: { input: { index: path.resolve("src/preload/index.ts"), browser: path.resolve("src/preload/browser.ts") }, output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    plugins: [react(), pdfjsAssets(), standInFontAssets()],
    worker: { format: "es" },
    resolve: { dedupe: ["react", "react-dom"] },
    build: { outDir: path.join(out, "renderer") },
  },
});
