#!/usr/bin/env node
/**
 * After Vite/rolldown code-splits the Cloudflare worker entry under
 * `_next/static/`, vinext 1.0.0 still emits some modules at the Worker
 * bundle root and leaves hard-coded `./name.js` externals in nested chunks.
 * Cloudflare then rejects the upload (APIError 10021) for any missing
 * `_next/static/<name>.js`.
 *
 * History:
 * - #50/#52: rewrote `__vinext_*` only → deploy then failed on
 *   `vinext-client-assets.js` (same class of bug).
 * - This script rewrites **all** nested relative imports that resolve only
 *   at the output root, then hard-fails if any remain.
 *
 * Deploy must use the shared pipeline:
 *   build:vinext = vite build && this script
 *   deploy:vinext = build:vinext && vinext-cloudflare deploy --skip-build
 */
import fs from "node:fs";
import path from "node:path";

const BUNDLE_ROOT = path.resolve(
  ".cloudflare/output/v0/workers/default/bundle",
);

function listJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

function rootJsBasenames(bundleRoot) {
  const names = new Set();
  for (const entry of fs.readdirSync(bundleRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.m?js$/.test(entry.name)) names.add(entry.name);
  }
  return names;
}

function posixRel(fromAbs, toAbs) {
  let rel = path.posix.relative(
    path.dirname(fromAbs).split(path.sep).join("/"),
    toAbs.split(path.sep).join("/"),
  );
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function* relativeSpecifiers(code) {
  // Simpler, robust scan: quoted ./ or ../ paths ending in .js/.mjs
  const re = /(["'])(\.\.?(?:\/[^"'\\]+)+\.m?js)\1/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    yield { quote: m[1], spec: m[2], index: m.index, length: m[0].length };
  }
}

function rewriteFile(filePath, rootNames) {
  const original = fs.readFileSync(filePath, "utf8");
  const relToBundle = path
    .relative(BUNDLE_ROOT, filePath)
    .split(path.sep)
    .join("/");
  // Root-level files already use ./ correctly for sibling root assets.
  if (!relToBundle.includes("/")) return { changed: false, code: original };

  const replacements = [];

  for (const { quote, spec, index, length } of relativeSpecifiers(original)) {
    const resolvedBeside = path.resolve(path.dirname(filePath), spec);
    if (fs.existsSync(resolvedBeside)) continue;

    const base = path.posix.basename(spec);
    if (!rootNames.has(base)) continue;

    const rootFile = path.join(BUNDLE_ROOT, base);
    if (!fs.existsSync(rootFile)) continue;

    const correct = posixRel(filePath, rootFile);
    if (correct === spec) continue;

    replacements.push({ index, length, next: `${quote}${correct}${quote}`, from: spec, to: correct });
  }

  if (!replacements.length) return { changed: false };

  // Apply from end so indices stay valid.
  replacements.sort((a, b) => b.index - a.index);
  let out = original;
  for (const r of replacements) {
    out = out.slice(0, r.index) + r.next + out.slice(r.index + r.length);
  }
  fs.writeFileSync(filePath, out);
  return {
    changed: true,
    replacements: replacements.map((r) => `${r.from} -> ${r.to}`),
  };
}

function assertNoBrokenRootImports(rootNames) {
  const broken = [];
  for (const file of listJsFiles(BUNDLE_ROOT)) {
    const rel = path.relative(BUNDLE_ROOT, file).split(path.sep).join("/");
    if (!rel.includes("/")) continue;
    const code = fs.readFileSync(file, "utf8");
    for (const { quote, spec } of relativeSpecifiers(code)) {
      const resolvedBeside = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(resolvedBeside)) continue;
      const base = path.posix.basename(spec);
      if (rootNames.has(base) && fs.existsSync(path.join(BUNDLE_ROOT, base))) {
        broken.push(`${rel} imports ${quote}${spec}${quote} (root has ${base})`);
      }
    }
  }
  if (broken.length) {
    console.error(
      "fix-vinext-worker-root-externals: unresolved nested imports of bundle-root modules:",
    );
    for (const b of broken) console.error("  ", b);
    process.exit(1);
  }
}

function main() {
  if (!fs.existsSync(BUNDLE_ROOT)) {
    console.error(`fix-vinext-worker-root-externals: missing ${BUNDLE_ROOT}`);
    process.exit(1);
  }

  const rootNames = rootJsBasenames(BUNDLE_ROOT);
  if (!rootNames.size) {
    console.log("fix-vinext-worker-root-externals: no root .js assets; nothing to do");
    return;
  }

  let changedFiles = 0;
  const details = [];
  for (const file of listJsFiles(BUNDLE_ROOT)) {
    const result = rewriteFile(file, rootNames);
    if (result.changed) {
      changedFiles += 1;
      const rel = path.relative(BUNDLE_ROOT, file).split(path.sep).join("/");
      details.push(`${rel}: ${(result.replacements || []).join("; ")}`);
    }
  }

  for (const d of details) console.log("rewrote", d);
  assertNoBrokenRootImports(rootNames);
  console.log(
    `fix-vinext-worker-root-externals: updated ${changedFiles} file(s); root modules: ${[...rootNames].sort().join(", ")}`,
  );
}

main();
