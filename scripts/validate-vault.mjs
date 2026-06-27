// scripts/validate-vault.mjs
// Validates every markdown note under docs/ (excluding .obsidian, superpowers/).
// Checks: (1) YAML frontmatter present with required keys; (2) every [[wikilink]]
// resolves to an existing note (by basename or vault-relative path); (3) every
// asset embed ![[file.ext]] resolves to an existing non-.md file in the vault.
// Exits 1 with a report on any failure.
//
// Notes:
// - Frontmatter is validated only for notes NOT under SKIP dirs (.obsidian, superpowers,
//   .trash). But wikilink targets are resolved against EVERY .md in the vault — including
//   superpowers/ — so cross-references into the design specs/plans resolve.
// - Asset embed targets are resolved against every non-.md file in the vault (excluding
//   .obsidian and .trash), by bare basename or vault-relative path.
// - Wikilinks inside inline code spans and fenced code blocks are ignored (syntax shown
//   as an example is not a real link).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, extname, relative, sep } from "node:path";

const ROOT = "docs";
const SKIP = new Set([".obsidian", "superpowers", ".trash"]);
const REQUIRED = ["title", "type", "area", "status", "created", "updated", "tags"];

// Walk the vault collecting files that match the given predicate.
// `respectSkip` toggles whether SKIP dirs are pruned:
//   - notes to validate  -> respectSkip = true  (don't lint superpowers/, etc.)
//   - resolvable targets  -> respectSkip = false (but still skip .obsidian/.trash dotdirs)
function walk(dir, respectSkip, predicate = () => true) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (respectSkip && SKIP.has(entry)) continue;
    // Never descend into .obsidian / .trash even when collecting link targets.
    if (!respectSkip && (entry === ".obsidian" || entry === ".trash")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, respectSkip, predicate));
    else if (predicate(p)) out.push(p);
  }
  return out;
}

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const obj = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (mm) obj[mm[1]] = mm[2];
  }
  return obj;
}

// Remove fenced code blocks (``` / ~~~) and inline code spans (`...`) so wikilink syntax
// shown as an example inside code is not treated as a real link.
function stripCode(text) {
  return text
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, "") // fenced blocks
    .replace(/`[^`\n]*`/g, ""); // inline spans
}

const files = walk(ROOT, true, (p) => extname(p) === ".md"); // notes subject to frontmatter validation
const targets = walk(ROOT, false, (p) => extname(p) === ".md"); // every .md that can be a wikilink destination
const assetFiles = walk(ROOT, false, (p) => extname(p) !== ".md" && extname(p) !== ""); // non-.md assets

// Resolvable names: bare basenames AND vault-relative paths (with and without .md),
// using forward slashes so [[a/b/name]] resolves on any platform.
const noteNames = new Set();
// Vault-relative paths (no extension), e.g. "00-overview/sources/index". Used to resolve
// folder-relative path links like [[sources/index]] by suffix match on segment boundaries.
const notePaths = [];
for (const t of targets) {
  noteNames.add(basename(t, ".md"));
  const rel = relative(ROOT, t).split(sep).join("/"); // e.g. 00-overview/index.md
  noteNames.add(rel);
  const relNoExt = rel.replace(/\.md$/, ""); // e.g. 00-overview/index
  noteNames.add(relNoExt);
  notePaths.push(relNoExt);
}

// A wikilink target resolves if it matches a bare basename, a full vault-relative path, or
// the suffix (on a path-segment boundary) of some note's vault-relative path — the latter
// covers Obsidian folder-relative links like [[sources/index]] from docs/00-overview/.
function resolves(target) {
  if (noteNames.has(target)) return true;
  const t = target.replace(/\.md$/, "");
  return notePaths.some((p) => p === t || p.endsWith("/" + t));
}

// Asset embed targets: bare basename (with extension) OR vault-relative path.
// Uses the same suffix-match scheme as resolves() so [[diagrams/foo.svg]] works too.
const assetNames = new Set();
const assetPaths = [];
for (const a of assetFiles) {
  const rel = relative(ROOT, a).split(sep).join("/"); // e.g. 00-overview/diagrams/architecture.drawio.svg
  assetNames.add(basename(a)); // architecture.drawio.svg
  assetNames.add(rel);         // 00-overview/diagrams/architecture.drawio.svg
  assetPaths.push(rel);
}

function resolvesAsset(target) {
  if (assetNames.has(target)) return true;
  return assetPaths.some((p) => p === target || p.endsWith("/" + target));
}

const errors = [];

for (const f of files) {
  const text = readFileSync(f, "utf8");
  const fm = frontmatter(text);
  if (!fm) { errors.push(`${f}: missing frontmatter`); continue; }
  for (const k of REQUIRED) {
    if (!(k in fm)) errors.push(`${f}: missing frontmatter key '${k}'`);
  }
  const body = stripCode(text);
  for (const link of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const target = link[1].trim();
    const targetExt = extname(target).toLowerCase();
    if (targetExt && targetExt !== ".md") {
      // Asset embed (e.g. ![[diagram.drawio.svg]]): resolve against real vault files.
      if (!resolvesAsset(target)) errors.push(`${f}: broken embed [[${target}]]`);
    } else {
      // Note wikilink: resolve against .md files.
      if (!resolves(target)) errors.push(`${f}: broken wikilink [[${target}]]`);
    }
  }
}

if (errors.length) {
  console.error(`Vault validation FAILED (${errors.length}):`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`Vault validation passed: ${files.length} notes OK.`);
