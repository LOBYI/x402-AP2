import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Lets test/protect.test.ts force GC, reproducing undici's clone-cancellation bug.
    execArgv: ["--expose-gc"],
  },
});
