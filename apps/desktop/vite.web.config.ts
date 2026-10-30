import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

// The page alone in a browser, for a quick look at the layout: no bridge, so
// it talks to a mock server of its own (renderer/src/kernel.ts).
export default defineConfig({
  root: path.join(import.meta.dirname, "src/renderer"),
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 5174), strictPort: true },
});
