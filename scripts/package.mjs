#!/usr/bin/env node
// `npm run package`: the one command that produces the three release
// artifacts under release/ from a clean checkout.
//
//   1. Preflight: report the Node/npm versions against the pins in .nvmrc /
//      package.json engines (docs/release.md explains why they're pinned).
//   2. Clean .output/ and release/.
//   3. Regenerate public/ort, public/c2pa, public/licenses
//      (scripts/copy-vendor-assets.mjs) — fails the build if any bundled
//      dependency lacks a real licence file (see licenses/vendor/).
//   4. `npm run typecheck`, `npm test`.
//   5. Production build for Chrome and Firefox.
//   6. `web-ext lint` on the Firefox build; fails on errors or on any
//      warning that isn't one of the two already reviewed in docs/qa.md.
//   7. `wxt zip` (Chrome), `wxt zip -b firefox --sources` (Firefox + the
//      AMO source-code submission).
//   8. Strip the generated public/{ort,c2pa,licenses} from the sources zip
//      (they're rebuilt by step 3 from node_modules, not "source").
//   9. Verify every zip: no source maps, no .env files, no node_modules;
//      manifest_version 3 in both; Firefox has a gecko id and
//      data_collection_permissions.
//  10. Copy zips to release/, print sizes + SHA-256, write release/SHA256SUMS.
//  11. Extract the sources zip into a scratch dir, rebuild the Firefox
//      target from it, and diff the file list + hashes against the release
//      build (set SKIP_REBUILD_CHECK=1 to skip this step).
//
// Local git / no publishing: this script never touches AMO, the Chrome Web
// Store, or any remote. See docs/release.md for the manual publishing steps.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const releaseDir = join(root, "release");
const outBase = join(root, ".output");

// Warnings `web-ext lint` is known and expected to produce (justified in
// docs/qa.md: both come from vendored, unmodified third-party code and are
// blocked at runtime by the extension CSP). Any warning code not in this set
// fails the build, so a real new issue can't slip through silently.
const KNOWN_LINT_WARNINGS = new Set(["DANGEROUS_EVAL", "UNSAFE_VAR_ASSIGNMENT"]);

function header(title) {
  console.log(`\n=== ${title} ===`);
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
}

function fail(message) {
  console.error(`\npackage: FAILED — ${message}`);
  process.exit(1);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function listZipEntries(zipPath) {
  return runCapture("unzip", ["-Z1", zipPath]).split("\n").filter(Boolean);
}

function readZipEntry(zipPath, entry) {
  return runCapture("unzip", ["-p", zipPath, entry]);
}

function findFiles(dir) {
  return runCapture("find", [".", "-type", "f"], { cwd: dir })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

function diffBuildDirs(a, b) {
  const listA = new Set(findFiles(a));
  const listB = new Set(findFiles(b));
  const removed = [...listA].filter((f) => !listB.has(f));
  const added = [...listB].filter((f) => !listA.has(f));
  const changed = [...listA]
    .filter((f) => listB.has(f))
    .filter((f) => sha256(join(a, f)) !== sha256(join(b, f)));
  return { added, removed, changed, total: listA.size };
}

// Cross-platform (macOS + Linux CI) check that the plain POSIX tools this
// script shells out to (`zip`, `unzip`, `find`; sha256 itself is computed in
// Node, never via `shasum`/`sha256sum`) are on PATH, with a clear error
// instead of a raw ENOENT deep in a child process.
function requireTools(tools) {
  const missing = tools.filter((t) => {
    try {
      execFileSync("sh", ["-c", `command -v ${t}`], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    fail(
      `required command-line tool(s) not found on PATH: ${missing.join(", ")}. ` +
        `On Debian/Ubuntu (incl. GitHub Actions' ubuntu-latest): \`sudo apt-get install -y zip unzip findutils\`. ` +
        `On macOS these ship with the OS.`,
    );
  }
}

// ---------------------------------------------------------------------
header("Preflight: toolchain versions");
requireTools(["zip", "unzip", "find", "sh"]);
const nvmrc = existsSync(join(root, ".nvmrc")) ? readFileSync(join(root, ".nvmrc"), "utf8").trim() : null;
const npmVersion = runCapture("npm", ["--version"]).trim();
console.log(`Node ${process.version} (pinned: ${nvmrc ?? "n/a"} in .nvmrc; engines.node: ${pkg.engines?.node ?? "n/a"})`);
console.log(`npm  ${npmVersion} (engines.npm: ${pkg.engines?.npm ?? "n/a"})`);
if (nvmrc && process.version.replace(/^v/, "") !== nvmrc) {
  console.warn(
    `WARNING: building with Node ${process.version}, but .nvmrc pins ${nvmrc}. ` +
      `The build should still work (see engines.node), but for a byte-for-byte-reproducible ` +
      `release, use the pinned version (\`nvm use\`).`,
  );
}

// ---------------------------------------------------------------------
header("Clean");
for (const dir of [outBase, releaseDir]) rmSync(dir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// ---------------------------------------------------------------------
header("Vendor assets + licence check");
run("node", ["scripts/copy-vendor-assets.mjs"]);

// ---------------------------------------------------------------------
header("Typecheck");
run("npm", ["run", "typecheck"]);

header("Unit tests");
run("npm", ["test"]);

// ---------------------------------------------------------------------
header("Build: Chrome (production)");
run("npx", ["wxt", "build"]);

header("Build: Firefox (production)");
run("npx", ["wxt", "build", "-b", "firefox"]);

// ---------------------------------------------------------------------
header("web-ext lint (Firefox)");
run("npx", ["web-ext", "lint", "-s", ".output/firefox-mv3"]);
const lint = JSON.parse(runCapture("npx", ["web-ext", "lint", "-s", ".output/firefox-mv3", "-o", "json", "--boring"]));
if (lint.errors.length > 0) {
  fail(`web-ext lint found ${lint.errors.length} error(s) (see above).`);
}
const unknownWarnings = lint.warnings.filter((w) => !KNOWN_LINT_WARNINGS.has(w.code));
if (unknownWarnings.length > 0) {
  fail(
    `web-ext lint found new warning(s) not yet reviewed: ${unknownWarnings.map((w) => w.code).join(", ")}. ` +
      `If they're acceptable, add a justification to docs/qa.md and to KNOWN_LINT_WARNINGS in this script.`,
  );
}
console.log(`web-ext lint: 0 errors, ${lint.warnings.length} warning(s), all previously reviewed (docs/qa.md).`);

// ---------------------------------------------------------------------
header("Zip: Chrome");
run("npx", ["wxt", "zip"]);

header("Zip: Firefox + AMO sources");
run("npx", ["wxt", "zip", "-b", "firefox", "--sources"]);

const artifacts = {
  chrome: join(outBase, `local-ai-detector-${version}-chrome.zip`),
  firefox: join(outBase, `local-ai-detector-${version}-firefox.zip`),
  sources: join(outBase, `local-ai-detector-${version}-sources.zip`),
};
for (const [name, p] of Object.entries(artifacts)) {
  if (!existsSync(p)) fail(`expected artifact missing: ${p} (did the "name"/"version" in package.json change?)`);
  void name;
}

// ---------------------------------------------------------------------
header("Sources zip: strip generated vendor assets");
// public/ort, public/c2pa and public/licenses are entirely regenerated by
// `node scripts/copy-vendor-assets.mjs` (run by postinstall/prebuild) from
// node_modules per the committed package-lock.json. They aren't "source", so
// strip them from the AMO submission — BUILD_FROM_SOURCE.md documents that
// the build command regenerates them.
run("zip", ["-q", "-d", artifacts.sources, "public/ort/*", "public/c2pa/*", "public/licenses/*"]);

// ---------------------------------------------------------------------
header("Verify zip contents");
const FORBIDDEN = [
  { re: /\.map$/i, label: "a source map" },
  { re: /(^|\/)\.env(\..*)?$/i, label: "a .env file" },
  { re: /(^|\/)node_modules\//, label: "node_modules" },
];
for (const [name, p] of Object.entries(artifacts)) {
  const entries = listZipEntries(p);
  for (const { re, label } of FORBIDDEN) {
    const hits = entries.filter((e) => re.test(e));
    if (hits.length > 0) {
      fail(`${name}.zip contains ${label}: ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ", ..." : ""}`);
    }
  }
  console.log(`${name}.zip: ${entries.length} entries, clean (no source maps / .env / node_modules)`);
}

const chromeManifest = JSON.parse(readZipEntry(artifacts.chrome, "manifest.json"));
const firefoxManifest = JSON.parse(readZipEntry(artifacts.firefox, "manifest.json"));
if (chromeManifest.manifest_version !== 3) fail(`Chrome manifest_version is ${chromeManifest.manifest_version}, expected 3`);
if (firefoxManifest.manifest_version !== 3) fail(`Firefox manifest_version is ${firefoxManifest.manifest_version}, expected 3`);
const geckoId = firefoxManifest.browser_specific_settings?.gecko?.id;
if (!geckoId) fail("Firefox manifest is missing browser_specific_settings.gecko.id");
const dcp = firefoxManifest.browser_specific_settings?.gecko?.data_collection_permissions;
if (!dcp?.required?.includes?.("none")) {
  fail(`Firefox manifest data_collection_permissions unexpected: ${JSON.stringify(dcp)}`);
}
console.log(
  `Chrome manifest_version=3; Firefox manifest_version=3, gecko.id="${geckoId}", ` +
    `data_collection_permissions.required=${JSON.stringify(dcp.required)}`,
);

// ---------------------------------------------------------------------
header("Artifacts");
const rows = [];
for (const [name, p] of Object.entries(artifacts)) {
  const dest = join(releaseDir, `local-ai-detector-${version}-${name}.zip`);
  cpSync(p, dest);
  rows.push({ file: relative(root, dest), size: statSync(dest).size, hash: sha256(dest) });
}
const nameWidth = Math.max(...rows.map((r) => r.file.length));
for (const r of rows) {
  console.log(`${r.file.padEnd(nameWidth)}  ${humanSize(r.size).padStart(9)}  sha256:${r.hash}`);
}
// Plain `sha256sum`-compatible format ("<hash>  <filename>"), so
// `sha256sum -c SHA256SUMS` (run from release/) verifies it directly. Fixed
// filename (no version suffix) so CI can upload it as a build artifact
// without knowing the version in advance (see .github/workflows/ci.yml).
const sumsPath = join(releaseDir, "SHA256SUMS");
writeFileSync(sumsPath, rows.map((r) => `${r.hash}  ${r.file.split("/").pop()}`).join("\n") + "\n");
console.log(`Wrote ${relative(root, sumsPath)}`);

// ---------------------------------------------------------------------
if (process.env.SKIP_REBUILD_CHECK === "1") {
  header("Rebuild-determinism check: SKIPPED (SKIP_REBUILD_CHECK=1)");
} else {
  header("Rebuild-determinism check (sources zip -> wxt build -b firefox)");
  const scratch = mkdtempSync(join(tmpdir(), "lad-package-rebuild-"));
  try {
    console.log(`Extracting sources zip into ${scratch}`);
    run("unzip", ["-q", artifacts.sources, "-d", scratch]);
    console.log("Copying node_modules into the scratch dir (not re-running `npm ci`; see note below)");
    cpSync(join(root, "node_modules"), join(scratch, "node_modules"), { recursive: true });
    console.log("Regenerating public/ort, public/c2pa, public/licenses (scripts/copy-vendor-assets.mjs)");
    execFileSync("node", ["scripts/copy-vendor-assets.mjs"], { cwd: scratch, stdio: "inherit" });
    console.log("Rebuilding the Firefox target from the extracted sources");
    execFileSync("npx", ["wxt", "build", "-b", "firefox"], { cwd: scratch, stdio: "inherit" });

    const origDir = join(outBase, "firefox-mv3");
    const rebuiltDir = join(scratch, ".output", "firefox-mv3");
    const diff = diffBuildDirs(origDir, rebuiltDir);
    if (diff.added.length || diff.removed.length || diff.changed.length) {
      for (const f of diff.removed) console.error(`  missing in rebuild: ${f}`);
      for (const f of diff.added) console.error(`  extra in rebuild:   ${f}`);
      for (const f of diff.changed) console.error(`  hash differs:       ${f}`);
      fail("rebuilding the Firefox target from the sources zip did not reproduce the release build (see above).");
    }
    console.log(`Rebuild is byte-identical to the release build: ${diff.total} files, same SHA-256 hashes.`);
    console.log(
      "Known non-determinism: none observed for this release. This check reuses the\n" +
        "already-installed node_modules/ instead of running `npm ci` against the npm\n" +
        "registry, so it proves the *source tree* rebuilds deterministically; it does not\n" +
        "re-verify npm's own dependency resolution (that is what the committed\n" +
        "package-lock.json is for). See docs/release.md#reproducibility.",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log("\npackage: OK");
