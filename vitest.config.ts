import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@cue/daemon/protocol", replacement: fileURLToPath(new URL("./packages/daemon/src/protocol.ts", import.meta.url)) },
      ...["core", "store", "harness", "router", "daemon", "cli"].map((n) => ({ find: `@cue/${n}`, replacement: pkg(n) })),
    ],
  },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
