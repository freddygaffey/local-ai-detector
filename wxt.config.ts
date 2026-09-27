import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";

// See docs/feasibility.md §1 for why each of these manifest fields exists.
export default defineConfig({
  srcDir: ".",
  outDir: ".output",
  // Firefox defaults to MV2 unless we force MV3 here (equivalent to `--mv3`).
  manifestVersion: 3,
  // T1: transformers.js imports "onnxruntime-web/webgpu", whose default
  // export is the *bundle* build: it embeds the ORT glue and references the
  // 27 MB .wasm via `new URL(..., import.meta.url)`, so Vite would emit a
  // second copy of the wasm (and inline it as base64 into IIFE bundles such
  // as the Firefox inference worker). The non-bundle build loads both files
  // from `env.backends.onnx.wasm.wasmPaths`, which src/engine/runtime.ts
  // points at the bundled public/ort/ copies.
  vite: () => ({
    resolve: {
      alias: [
        {
          find: /^onnxruntime-web\/webgpu$/,
          replacement: fileURLToPath(
            new URL("./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs", import.meta.url),
          ),
        },
      ],
    },
  }),
  manifest: ({ browser }) => {
    const base = {
      name: "Local AI Detector",
      description:
        "Free, open-source, fully local AI-content detector. No servers, no API keys.",
      permissions: ["storage", "activeTab", "scripting", "contextMenus"],
      host_permissions: ["https://huggingface.co/*", "https://*.hf.co/*"],
      optional_host_permissions: ["<all_urls>"],
      icons: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
      // Chrome's allowed minimum; Firefox MV3 accepts the same directive.
      // See docs/feasibility.md §"CSP, permissions, store rules".
      content_security_policy: {
        extension_pages:
          "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
      },
    };

    if (browser === "firefox") {
      return {
        ...base,
        browser_specific_settings: {
          gecko: {
            // Placeholder ID; the real add-on ID is assigned/confirmed at AMO signing time.
            id: "local-ai-detector@freddygaffey.github.io",
            // Firefox 109 is the first release with general MV3 support.
            strict_min_version: "109.0",
          },
        },
      };
    }

    // Chrome-only: offscreen document (inference host) + cross-origin
    // isolation so ORT WASM can use SharedArrayBuffer / multiple threads.
    return {
      ...base,
      permissions: [...base.permissions, "offscreen"],
      cross_origin_embedder_policy: { value: "require-corp" },
      cross_origin_opener_policy: { value: "same-origin" },
    };
  },
});
