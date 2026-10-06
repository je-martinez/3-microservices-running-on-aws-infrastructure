import { execFileSync } from "node:child_process";
import { catalog } from "../catalog";
import { affectedDiagrams } from "./drift";

const repoRoot = new URL("../../../", import.meta.url).pathname;
const base = process.env.DIAGRAMS_BASE ?? "main";
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);

try {
  let changed: string[] = [];

  try {
    const mergeBase = git("merge-base", base, "HEAD")[0] ?? base;
    // WHY: committed branch changes + uncommitted edits + untracked files, so the check is useful before the first commit too.
    changed = [
      ...new Set([
        ...git("diff", "--name-only", mergeBase, "HEAD"),
        ...git("diff", "--name-only", "HEAD"),
        ...git("ls-files", "--others", "--exclude-standard"),
      ]),
    ];
  } catch {
    console.log(`diagrams-check: warning — base "${base}" could not be resolved; checking uncommitted changes only`);
    changed = [
      ...new Set([
        ...git("diff", "--name-only", "HEAD"),
        ...git("ls-files", "--others", "--exclude-standard"),
      ]),
    ];
  }

  const results = affectedDiagrams(changed, catalog);
  if (results.length === 0) {
    console.log(`diagrams-check: no diagram watches a path changed since ${base}`);
  } else {
    for (const r of results) {
      const mark = r.status === "stale" ? "STALE?  " : "updated ";
      console.log(`${mark} ${r.id}  ← ${r.matches.slice(0, 3).join(", ")}${r.matches.length > 3 ? ", …" : ""}`);
    }
    const stale = results.filter((r) => r.status === "stale").length;
    console.log(`\n${stale} possibly stale. Re-render (make diagrams-render ID=<id>) or justify in the PR. See [[diagrams]].`);
  }
} catch (e) {
  const reason = e instanceof Error ? e.message : String(e);
  console.log(`diagrams-check: skipped (${reason})`);
}
