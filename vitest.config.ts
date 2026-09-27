import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

// WxtVitest wires up the "@/" alias, WXT's auto-imports (browser,
// defineBackground, etc.) and a fake `browser` global from
// wxt/testing/fake-browser, based on wxt.config.ts, so tests for
// src/shared/** (and later, entrypoints) resolve the same way the real
// build does.
export default defineConfig({
  plugins: [WxtVitest()],
});
