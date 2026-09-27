// Tiny Node module-resolution hook so dev scripts (scripts/calibrate.mjs,
// smoke tests) can import the engine's TypeScript sources directly, relying
// on Node's built-in type stripping (Node >= 22.18 / 23.6). It only adds
// what the extension's bundler does implicitly: extensionless relative
// imports resolve to `.ts` (or `/index.ts`), and `@/` maps to the repo root.
//
// Usage: node --import ./scripts/lib/ts-hooks.mjs <script>
import { register } from "node:module";

const hooks = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = ${JSON.stringify(new URL("../../", import.meta.url).href)};
export async function resolve(specifier, context, next) {
  let spec = specifier;
  if (spec.startsWith("@/")) spec = new URL(spec.slice(2), root).href;
  const isRel = spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("file:");
  if (isRel && !/\\.[cm]?[jt]s$/.test(spec) && context.parentURL) {
    const base = new URL(spec, context.parentURL);
    for (const cand of [base.href + ".ts", base.href + "/index.ts"]) {
      if (existsSync(fileURLToPath(cand))) return next(cand, context);
    }
  }
  return next(spec, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks), import.meta.url);
