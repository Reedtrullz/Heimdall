#!/usr/bin/env node
/**
 * vinext 1.0.0 marks cacheability/pregenerated modules as externals with a
 * hard-coded `./__vinext_*.js` specifier and emits the files at the Worker
 * output root. Vite 8.3.5 / rolldown can turn the Cloudflare worker entry into
 * a facade and place the real entry under `_next/static/`. The relative
 * `./__vinext_*` imports then resolve next to that chunk, Cloudflare upload
 * fails with APIError 10021 ("No such module _next/static/__vinext_…").
 *
 * vinext 1.3.0 fixed this with rewriteOutputRootExternals. Heimdall still uses
 * vinext 1.0.0 + @cloudflare/vite-plugin 2.0 / `cf` (not the dist/ wrangler
 * layout), so we mirror that rewrite after `vite build`.
 *
 * See: https://github.com/Reedtrullz/Heimdall/pull/47 deploy failure.
 */
import fs from "node:fs";
import path from "node:path";

const BUNDLE_ROOT = path.resolve(
  ".cloudflare/output/v0/workers/default/bundle",
);

const ROOT_EXTERNAL_NAMES = [
  "__vinext_cacheability_manifest.js",
  "__vinext_cacheability_request_projection.js",
  "__vinext_pregenerated_concrete_paths.js",
  "__vinext_action_owner_manifest.js",
];

function listJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function rewriteFile(filePath) {
  const original = fs.readFileSync(filePath, "utf8");
  let code = original;
  const chunkDir = path.posix.dirname(
    path.relative(BUNDLE_ROOT, filePath).split(path.sep).join("/"),
  );

  for (const name of ROOT_EXTERNAL_NAMES) {
    const target = name; // at output root
    let specifier = path.posix.relative(chunkDir === "." ? "" : chunkDir, target);
    // path.posix.relative("", "file") => "file"; ensure leading ./
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;

    // Only rewrite the broken same-dir form vinext 1.0 emits.
    const patterns = [
      [`"./${name}"`, `"${specifier}"`],
      [`'./${name}'`, `'${specifier}'`],
    ];
    for (const [from, to] of patterns) {
      if (from === to) continue;
      if (code.includes(from)) code = code.split(from).join(to);
    }
  }

  if (code !== original) {
    fs.writeFileSync(filePath, code);
    return true;
  }
  return false;
}

function hasQuotedSameDirImport(code, name) {
  // Exact quoted "./name" only — avoids matching a substring of "../../name".
  return code.includes(`"./${name}"`) || code.includes(`'./${name}'`);
}

function assertNoBrokenImports() {
  const files = listJsFiles(BUNDLE_ROOT);
  const broken = [];
  for (const file of files) {
    const rel = path.relative(BUNDLE_ROOT, file).split(path.sep).join("/");
    // Skip root-level files: ./__vinext_* is correct there.
    if (!rel.includes("/")) continue;
    const code = fs.readFileSync(file, "utf8");
    for (const name of ROOT_EXTERNAL_NAMES) {
      if (!hasQuotedSameDirImport(code, name)) continue;
      const resolved = path.resolve(path.dirname(file), `./${name}`);
      if (!fs.existsSync(resolved) && fs.existsSync(path.join(BUNDLE_ROOT, name))) {
        broken.push(`${rel} -> ./${name}`);
      }
    }
  }
  if (broken.length) {
    console.error("fix-vinext-worker-root-externals: unresolved ./__vinext_* imports remain:");
    for (const b of broken) console.error("  ", b);
    process.exit(1);
  }
}

function main() {
  if (!fs.existsSync(BUNDLE_ROOT)) {
    console.error(`fix-vinext-worker-root-externals: missing ${BUNDLE_ROOT}`);
    process.exit(1);
  }

  const rootPresent = ROOT_EXTERNAL_NAMES.filter((n) =>
    fs.existsSync(path.join(BUNDLE_ROOT, n)),
  );
  if (!rootPresent.length) {
    console.log("fix-vinext-worker-root-externals: no root __vinext_* assets; nothing to do");
    return;
  }

  let changed = 0;
  for (const file of listJsFiles(BUNDLE_ROOT)) {
    if (rewriteFile(file)) {
      changed += 1;
      console.log(
        "rewrote",
        path.relative(BUNDLE_ROOT, file).split(path.sep).join("/"),
      );
    }
  }
  assertNoBrokenImports();
  console.log(
    `fix-vinext-worker-root-externals: updated ${changed} file(s); root assets: ${rootPresent.join(", ")}`,
  );
}

main();
