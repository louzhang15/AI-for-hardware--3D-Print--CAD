#!/usr/bin/env node
// Hook for Claude Code and Codex (SessionStart + UserPromptSubmit).
// Fetches from GitHub and reports what changed somewhere else (your computer
// vs. a cloud session) so the agent pulls before editing. Prints nothing when
// everything is in sync. Never blocks: any error just exits 0.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const git = (...a) =>
  execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trimEnd();

try {
  // Drain hook input so the host isn't blocked writing to us.
  try { readFileSync(0); } catch {}
  const gitDir = git("rev-parse", "--absolute-git-dir");
  const stamp = join(gitDir, "sync-check-stamp");
  const fresh = existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < 60_000;

  const notes = [];
  if (!fresh) {
    let out = "";
    try {
      out = execFileSync("git", ["fetch", "--prune", "origin"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000,
      });
    } catch (e) { out = String(e.stderr || ""); }
    writeFileSync(stamp, "");
    const updated = String(out).split("\n").filter((l) => /->/.test(l)).map((l) => l.trim());
    if (updated.length) notes.push("Branches updated on GitHub since the last check:\n  " + updated.join("\n  "));
  }

  let upstream = "";
  try { upstream = git("rev-parse", "--abbrev-ref", "@{u}"); } catch {}
  if (upstream) {
    const [ahead, behind] = git("rev-list", "--left-right", "--count", `HEAD...${upstream}`).split(/\s+/).map(Number);
    if (behind) notes.push(`${behind} commit(s) on ${upstream} are not here yet. Run \`git pull\` before editing.\n  ` +
      git("log", "--oneline", "-n", "10", `HEAD..${upstream}`).split("\n").join("\n  "));
    if (ahead) notes.push(`${ahead} commit(s) here are not pushed to ${upstream} yet.`);
  }
  const dirty = git("status", "--porcelain");
  if (dirty) notes.push("Uncommitted changes in this checkout:\n  " + dirty.split("\n").slice(0, 20).join("\n  "));

  if (notes.length) {
    console.log("[sync-check] This project is edited both on the user's computer and in cloud sessions.\n" +
      notes.join("\n") +
      "\nBefore changing files: pull or merge what's new, tell the user what changed, and don't overwrite their work.");
  }
} catch {
  // Not a git repo, no network, etc.: stay silent.
}
