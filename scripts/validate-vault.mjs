// scripts/validate-vault.mjs
// Validates every markdown note under docs/ (excluding .obsidian, superpowers/).
// Checks: (1) YAML frontmatter present with required keys; (2) every [[wikilink]]
// resolves to an existing note (by basename or vault-relative path); (3) every
// asset embed ![[file.ext]] resolves to an existing non-.md file in the vault;
// (4) every superpowers spec/plan declares where its decisions propagate to.
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

// Enum values, per CLAUDE.md. Checked because a key being PRESENT says nothing about it being
// VALID: the JE-83 backfill produced five notes typed `decision`, which is not in the enum,
// and the presence-only check passed them silently.
const ENUMS = {
  type: ["spec", "adr", "runbook", "convention", "pattern", "lesson", "retro", "plan", "reference"],
  area: ["users", "orders", "tracking", "events-pipeline", "infra", "shared"],
  status: ["draft", "active", "accepted", "superseded"],
};

// Propagation gate (see docs/shared/conventions/doc-propagation.md).
// superpowers/ output is where decisions are MADE; the organized vault is where they LIVE.
// Every spec/plan must declare `propagates-to:` listing the vault notes it feeds, so a
// decision cannot be made without saying where it lands.
//
// The gate is PROSPECTIVE: notes created on or after PROPAGATION_EPOCH must declare it.
// The 33 specs / 30 plans predating the rule are exempt — backfilling them is tracked
// separately, and failing on them would have made the gate unadoptable. They are reported
// as a debt count, not as errors.
const PROPAGATION_EPOCH = "2026-07-28";
const PROPAGATION_KEY = "propagates-to";
// `propagates-to: none — <reason>` opts a note out (e.g. a spike whose outcome was
// "don't do this"). The reason is mandatory: silent opt-out is what this gate exists to stop.
const PROPAGATION_NONE = /^none\s*[—-]\s*\S/;

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

// Minimal frontmatter parser: scalars (`key: value`) plus block sequences
//   key:
//     - item
//     - item
// Block-sequence items are collected into an array so list-valued keys (related,
// propagates-to) can be inspected; a scalar stays a string. Inline flow lists
// (`tags: [a, b]`) remain the raw string, which is all the required-key check needs.
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const obj = {};
  let listKey = null;
  for (const line of m[1].split("\n")) {
    const item = line.match(/^[ \t]+-[ \t]+(.*)$/);
    if (listKey && item) {
      obj[listKey].push(item[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const mm = line.match(/^([A-Za-z_-]+):[ \t]*(.*)$/);
    if (!mm) continue;
    const [, key, value] = mm;
    if (value === "") {
      // Could open a block sequence; seed an array and let following items fill it.
      listKey = key;
      obj[key] = [];
    } else {
      listKey = null;
      obj[key] = value;
    }
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
  for (const [k, allowed] of Object.entries(ENUMS)) {
    const raw = fm[k];
    if (typeof raw !== "string" || raw === "") continue; // absent is already reported above
    // Templates carry an inline comment listing the options (`spec  # spec | adr | ...`).
    const value = raw.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (value.startsWith("<")) continue; // template placeholder, e.g. <users|orders|…>
    if (!allowed.includes(value)) {
      errors.push(`${f}: invalid '${k}: ${value}' — must be one of ${allowed.join(", ")}`);
    }
  }
  const body = stripCode(text);
  // Anchor written OUTSIDE the brackets (`[[note]]#Heading`) instead of inside
  // (`[[note#Heading]]`). Obsidian renders that as a plain link followed by literal text, so the
  // anchor silently does nothing — and the link check below can't see it, since it only reads the
  // part before the `#`.
  for (const bad of body.matchAll(/\[\[[^\]]+\]\]#\S/g)) {
    errors.push(`${f}: anchor outside the wikilink — '${bad[0].slice(0, 40)}…' (use [[note#Heading]])`);
  }
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

// --- Propagation gate -------------------------------------------------------
// Every superpowers spec/plan created on or after PROPAGATION_EPOCH must declare
// `propagates-to:` — the vault notes its decisions feed — and each declared target must
// resolve to a real note. Notes predating the epoch are counted as debt, not failed.
const superpowersNotes = walk(join(ROOT, "superpowers"), false, (p) => extname(p) === ".md");
let propagationDebt = 0;

for (const f of superpowersNotes) {
  const fm = frontmatter(readFileSync(f, "utf8"));

  // No frontmatter at all: raw plugin output that predates normalization. 14 such plans
  // exist today — the same un-propagated debt this gate targets. Counted, not failed,
  // since normalizing them is backfill. New notes hit the epoch branch below instead:
  // a missing `created` sorts before the epoch only when the file is also unnormalized.
  if (!fm) { propagationDebt++; continue; }

  const declared = fm[PROPAGATION_KEY];

  // Pre-epoch notes are not REQUIRED to declare propagation (backfilling them was optional).
  // But once one does, it is held to the same standard as a new note — a declared target
  // still has to resolve. Skipping validation here would let backfilled declarations rot
  // silently, which is the exact failure this gate exists to prevent.
  if (String(fm.created ?? "") < PROPAGATION_EPOCH && declared === undefined) {
    propagationDebt++;
    continue;
  }

  if (declared === undefined) {
    errors.push(
      `${f}: missing frontmatter key '${PROPAGATION_KEY}' — declare which vault notes this ` +
      `feeds, or 'none — <reason>' (see shared/conventions/doc-propagation.md)`,
    );
    continue;
  }

  if (typeof declared === "string") {
    if (!PROPAGATION_NONE.test(declared.trim())) {
      errors.push(`${f}: '${PROPAGATION_KEY}' must be a list of targets, or 'none — <reason>'`);
    }
    continue;
  }

  if (declared.length === 0) {
    errors.push(`${f}: '${PROPAGATION_KEY}' is empty — list target notes, or 'none — <reason>'`);
    continue;
  }

  // Targets are wikilinks ([[note]]) or vault-relative paths; both must resolve.
  for (const raw of declared) {
    const target = raw.replace(/^\[\[|\]\]$/g, "").split(/[|#]/)[0].trim();
    if (!resolves(target)) {
      errors.push(`${f}: '${PROPAGATION_KEY}' target does not resolve: ${target}`);
    }
  }
}

if (errors.length) {
  console.error(`Vault validation FAILED (${errors.length}):`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`Vault validation passed: ${files.length} notes OK.`);
if (propagationDebt) {
  console.log(
    `Propagation debt: ${propagationDebt}/${superpowersNotes.length} superpowers note(s) ` +
    `predating ${PROPAGATION_EPOCH} without '${PROPAGATION_KEY}' (exempt from the gate).`,
  );
} else {
  console.log(`Propagation: all ${superpowersNotes.length} superpowers notes declare '${PROPAGATION_KEY}'.`);
}
