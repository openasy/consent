import { defineConfig } from "vite";

// c.js, small and with no dependencies: the server wraps it per site and calls OAC.start() with its settings.
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: "../dist/banner",
    emptyOutDir: true,
    target: "es2019",
    lib: { entry: "c.ts", formats: ["iife"], name: "OAC", fileName: () => "c.js" },
  },
});
