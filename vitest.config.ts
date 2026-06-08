import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  test: {
    // Default to node; client component tests opt into jsdom per-file via
    // `// @vitest-environment jsdom`.
    environment: "node",
    include: [
      "server/__tests__/**/*.test.ts",
      "client/src/**/*.test.{ts,tsx}",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});
