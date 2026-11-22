# Claude Code and Codex handoff

Both tools use the Wiremap instructions in `AGENTS.md`. When changing the shared instructions, edit `skills/wiremap/SKILL.md` and run `node scripts/sync-skill.mjs`.

Before editing, check the local worktree and the cloud comparison branch with `node scripts/sync-check.mjs --refresh` from this checkout. The session and prompt hooks also check automatically once approved in the clients. Local edits are checked every time. The hook refreshes remote references at most once a minute after a successful fetch. It reports changes and leaves reconciliation to the current task.

When switching assistants, use the same checkout to share files, the Graphify graph in `graphify-out/`, and the Wiremap correction log. Run `graphify extract . --code-only` to build the local map from source before querying it. Use `graphify update .` after code changes. A separate checkout sees changes through commits published to the shared remote branch. Live chat and separate local state stay in their respective clients and checkouts.

Ponytail, Addy Osmani's Agent Skills, Graphify, and Wiremap are user-scope installations on the workstation. Both assistants' user instructions prefer focused Graphify queries, and their shared Stop hook refreshes existing graphs locally. Codex requires hook review before running the installed hooks. Other workstations and cloud environments need their own installations.

Windows can start a client through a running OmniRoute gateway with `pwsh -File scripts/omniroute.ps1 -Client Codex -Model <router-model-id>` or `-Client Claude`. The launcher checks the local endpoint, prompts for a gateway key if needed, and gives the selected client its session settings. It leaves the client's saved provider configuration untouched. Configure an upstream provider in OmniRoute before using a model from it.

## Current checkpoint

- The `codex/wiremap-working-release` branch includes the viewer redesign, 3D pin inspection, arm and rover motion previews, Companion diagnostics, and guided build navigation. The full suite passed 211 tests. The browser checks covered resuming a build, selecting a named step, tracing a wire, and routing to Issues when a checker error blocks the next step.
- The cloud `claude/focused-keller-cwv8nf` branch contains the first plugin and sync setup through `66802c2`. Review both branches before reconciling them. Neither contains the other's application changes merely because both clients are configured.
- When handing off work, update this section with the branch, last verified test, and open blocker. Keep credentials and private conversation logs out of the handoff.
