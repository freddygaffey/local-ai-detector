#!/usr/bin/env node
// Copies vendored binary/worker assets (and their licences) from node_modules
// into public/, so they ship in the extension bundle instead of being fetched
// from a CDN at runtime (required for store review, see docs/feasibility.md
// §"CSP, permissions, store rules").
//
// Runs via `postinstall` and as a `pre*` hook before every dev/build/zip
// script (see package.json), so a fresh `npm install` is always enough.
// Output directories (public/ort, public/c2pa, public/licenses) are
// gitignored: they are entirely derived from node_modules.
//
// - public/ort/      onnxruntime-web WASM backend used by transformers.js.
//                     Verified (see docs/feasibility.md) that the *default*
//                     resolution of "onnxruntime-web/webgpu" only needs the
//                     "asyncify" threaded-SIMD pair, not jsep/jspi/plain.
// - public/c2pa/      @contentauth/c2pa-web WASM + its dedicated worker
//                      script (owned/wired up by T4; the worker must load
//                      this packaged file via `workerSrc`, since blob:
//                      workers are blocked by MV3's CSP).
// - public/licenses/  LICENSE text for every bundled runtime dependency.

import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeModules = join(root, "node_modules");

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function copy(src, destDir, destName = undefined) {
  if (!existsSync(src)) {
    console.warn(`[copy-vendor-assets] skipped (not found): ${src}`);
    return false;
  }
  ensureDir(destDir);
  const dest = join(destDir, destName ?? src.split("/").pop());
  copyFileSync(src, dest);
  return true;
}

// ---- 1. onnxruntime-web WASM backend -> public/ort/ ----
{
  const ortDist = join(nodeModules, "onnxruntime-web", "dist");
  const destDir = join(root, "public", "ort");
  for (const file of [
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
  ]) {
    copy(join(ortDist, file), destDir);
  }
}

// ---- 2. @contentauth/c2pa-web WASM + worker -> public/c2pa/ ----
{
  const c2paDist = join(nodeModules, "@contentauth", "c2pa-web", "dist");
  const destDir = join(root, "public", "c2pa");
  copy(join(c2paDist, "resources", "c2pa_bg.wasm"), destDir);
  copy(join(c2paDist, "c2pa_worker.js"), destDir);
  // Shared chunk emitted alongside c2pa_worker.js/index.js by the package's
  // own build; the exact hashed filename is pinned by the exact dependency
  // version (0.15.2), so this is safe to hardcode.
  copy(join(c2paDist, "c2pa-DdK7nuOh.js"), destDir);
}

// ---- 3. LICENSE files for bundled runtime deps -> public/licenses/ ----
{
  const destDir = join(root, "public", "licenses");
  ensureDir(destDir);
  const packages = [
    "@huggingface/transformers",
    "onnxruntime-web",
    "@contentauth/c2pa-web",
    "@contentauth/c2pa-wasm",
    "@contentauth/c2pa-types",
    "@contentauth/c2pa-utilities",
    "exifreader",
    "c2pa-text",
  ];
  for (const pkg of packages) {
    const pkgDir = join(nodeModules, ...pkg.split("/"));
    const pkgJsonPath = join(pkgDir, "package.json");
    let version = "unknown";
    let license = "unknown";
    if (existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        version = pkgJson.version ?? version;
        license = pkgJson.license ?? license;
      } catch {
        // ignore malformed package.json
      }
    }
    const safeName = pkg.replace("/", "__");
    const licenseSrc = ["LICENSE", "LICENSE.txt", "LICENSE.md", "license"]
      .map((f) => join(pkgDir, f))
      .find((p) => existsSync(p));
    if (licenseSrc) {
      copy(licenseSrc, destDir, `${safeName}.LICENSE.txt`);
    } else {
      // Some packages (e.g. onnxruntime-web, c2pa-text as of the pinned
      // versions here) declare a licence in package.json but don't ship the
      // licence text in the published tarball. Record what we know so T6
      // can fetch the real text from upstream before store submission.
      console.warn(
        `[copy-vendor-assets] no LICENSE file shipped for ${pkg}@${version} (declared: ${license}); wrote a placeholder`,
      );
      writeFileSync(
        join(destDir, `${safeName}.LICENSE.txt`),
        `${pkg}@${version}\nDeclared licence (from package.json): ${license}\n\n` +
          `No LICENSE file was included in the published npm package. Fetch the\n` +
          `full licence text from the upstream repository before store submission.\n`,
      );
    }
  }
}
