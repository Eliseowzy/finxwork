import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "node:path";
export default defineConfig({
  root: path.join(import.meta.dirname, "fixtures"),
  plugins: [react()], worker: { format: "es" },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 5187, strictPort: true },
});
