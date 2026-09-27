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
    plugins: [
      {
        // transformers.js sets a jsDelivr default for ORT's wasmPaths at
        // import time. src/engine/runtime.ts always overrides it with the
        // bundled ort/ copy (and refuses to run otherwise), so the URL is
        // dead code, but store reviewers grep bundles for CDN URLs. Replace it
        // with an inert extension-relative path that can't reach the network.
        name: "strip-ort-cdn-fallback",
        enforce: "pre" as const,
        transform(code: string, id: string) {
          if (!id.includes("@huggingface/transformers") || !code.includes("cdn.jsdelivr.net")) return null;
          return {
            code: code.replace(
              /https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\$\{[^}]+\}\/dist\//g,
              "/ort-cdn-disabled/",
            ),
            map: null,
          };
        },
      },
    ],
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
  manifest: ({ browser, mode }) => {
    // `wxt build --mode e2e` (npm run build:e2e, output .output/chrome-mv3-e2e)
    // adds host access to the local fixture server so the automated E2E
    // suite (scripts/e2e/) can test image provenance without the optional
    // permission prompt, which automation can't click. Never shipped.
    const e2eHosts = mode === "e2e" ? ["http://localhost/*"] : [];
    const base = {
      name: "Local AI Detector",
      description:
        "Free, open-source, fully local AI-content detector. No servers, no API keys.",
      permissions: ["storage", "activeTab", "scripting", "contextMenus", "alarms"],
      host_permissions: [
        "https://huggingface.co/*",
        "https://*.hf.co/*",
        // T11: voice-check model download (GitHub Release asset + its redirect host).
        "https://github.com/*",
        "https://release-assets.githubusercontent.com/*",
        ...e2eHosts,
      ],
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
      // T9: keyboard shortcuts (docs/plan.md "More entry points"). All
      // user-rebindable (chrome://extensions/shortcuts, about:addons on
      // Firefox). Alt+Shift (Control+Shift on macOS): the old Ctrl+Shift
      // defaults took over paste-as-plain-text (Cmd/Ctrl+Shift+V), Chrome's
      // tab search (Cmd+Shift+A) and Firefox's add-ons page and screenshots.
      commands: {
        "analyze-page": {
          suggested_key: { default: "Alt+Shift+A", mac: "MacCtrl+Shift+A" },
          description: "Analyze this page for AI writing",
        },
        "analyze-selection": {
          suggested_key: { default: "Alt+Shift+S", mac: "MacCtrl+Shift+S" },
          description: "Analyze the selected text for AI writing",
        },
        "toggle-visibility": {
          suggested_key: { default: "Alt+Shift+V", mac: "MacCtrl+Shift+V" },
          description: "Show/hide the AI detector on this page",
        },
      },
    };

    if (browser === "firefox") {
      return {
        ...base,
        browser_specific_settings: {
          gecko: {
            // Placeholder ID; the real add-on ID is assigned/confirmed at AMO signing time.
            id: "local-ai-detector@freddygaffey.github.io",
            // 140 (the current ESR): optional_host_permissions (128+),
            // data_collection_permissions (140+) and the CSS Custom Highlight
            // API used for highlights (140+).
            strict_min_version: "140.0",
            // Nothing is collected or transmitted (AMO's built-in consent).
            data_collection_permissions: { required: ["none"] },
          },
          // Firefox for Android added data_collection_permissions in 142.
          gecko_android: { strict_min_version: "142.0" },
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
