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
//
// A few packages (onnxruntime-web, c2pa-text, at the pinned versions here)
// declare a licence in package.json but don't ship the licence *text* in the
// published npm tarball. For those, this script falls back to the real
// upstream LICENSE text committed under licenses/vendor/<pkg>/ (fetched from
// the matching upstream GitHub commit/tag; see licenses/vendor/README.md).
// If neither the npm package nor licenses/vendor/ has a licence file for a
// bundled dependency, this is a packaging bug and the build must fail rather
// than ship an unknown-licence dependency or a placeholder.
{
  const destDir = join(root, "public", "licenses");
  ensureDir(destDir);
  const vendorLicenseDir = join(root, "licenses", "vendor");
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
  const missing = [];
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
    const npmLicenseSrc = ["LICENSE", "LICENSE.txt", "LICENSE.md", "license"]
      .map((f) => join(pkgDir, f))
      .find((p) => existsSync(p));
    // Bare package name (last path segment) is the folder name under
    // licenses/vendor/, e.g. "onnxruntime-web" and "c2pa-text".
    const vendorPkgDir = join(vendorLicenseDir, pkg.split("/").pop());
    const vendorLicenseSrc = ["LICENSE", "LICENSE.txt", "LICENSE.md"]
      .map((f) => join(vendorPkgDir, f))
      .find((p) => existsSync(p));

    if (npmLicenseSrc) {
      copy(npmLicenseSrc, destDir, `${safeName}.LICENSE.txt`);
    } else if (vendorLicenseSrc) {
      console.warn(
        `[copy-vendor-assets] ${pkg}@${version} ships no LICENSE in npm; using the real upstream text committed at ${vendorLicenseSrc}`,
      );
      copy(vendorLicenseSrc, destDir, `${safeName}.LICENSE.txt`);
    } else {
      missing.push(`${pkg}@${version} (declared licence: ${license})`);
      continue;
    }

    // onnxruntime-web bundles third-party native code (e.g. the WASM SIMD
    // backend) whose notices are required alongside its own MIT licence.
    const noticeSrc = ["ThirdPartyNotices.txt", "THIRD-PARTY-NOTICES.txt"]
      .map((f) => join(vendorPkgDir, f))
      .find((p) => existsSync(p));
    if (noticeSrc) {
      copy(noticeSrc, destDir, `${safeName}.ThirdPartyNotices.txt`);
    }
  }

  if (missing.length > 0) {
    console.error(
      "[copy-vendor-assets] FATAL: no licence text found (neither in the npm package nor in licenses/vendor/) for:\n" +
        missing.map((m) => `  - ${m}`).join("\n") +
        "\nFetch the real upstream LICENSE and commit it under licenses/vendor/<package>/LICENSE " +
        "before building. Refusing to ship a bundled dependency with an unverified licence.",
    );
    process.exit(1);
  }
}
