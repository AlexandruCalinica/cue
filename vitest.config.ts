import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(["core", "store", "harness", "router", "daemon", "cli"].map((n) => [`@cue/${n}`, pkg(n)])),
  },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
