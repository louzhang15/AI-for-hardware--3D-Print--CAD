@AGENTS.md

## Token budget (owner's standing rule, every session)
- Query the code graph before reading files: `graphify query "<question>"`. `.graphifyrc` caps it at depth 1 and about 1.5k tokens (about 11x smaller than the defaults). One symbol: `graphify explain "checkMechanics()"`. Who calls it: `graphify affected "applyWireEdit()"`. Then read only the lines the graph points to (Read with offset/limit).
- Refresh after code edits with `graphify update .` (AST only, a few seconds, no LLM credits). `graphify hook install` keeps it fresh on every commit. Never run `graphify extract` or the semantic `/graphify` pass here: they spend LLM credits and the code graph is enough.
- `.graphifyignore` leaves out data (library/, printers/, projects/, templates/), fixtures, CAD binaries and the generated AGENTS.md copy. Open those JSON files directly when needed: they are the source of truth.
- Run single test files while working (`node tests/run.mjs mech`) and the full suite once at the end.
- Reply in caveman / terse style: answer first, short sentences, no filler. Code stays normal.
- Prefer existing skills, plugins and GitHub repos over writing new code.
