# Wiremap

**A local AI hardware build companion for Claude Code and Codex.** Describe a
robot, drone or smart gadget (or point it at your firmware repo) and your AI
plans the parts, a deterministic checker verifies the wiring, and a local 3D
viewer walks you through every step: what to buy, how each wire connects,
what voltage each part needs, what to 3D print, and how to put it together.

- Runs on your own Claude Code or Codex subscription. **No API key, no hosted website, no `npm install`.**
- Node 20+ is the only requirement.

> Working name. Status: v0.1 — the electrical checker, part library, breadboard
> layout, calculators, printer fit/split tools, exports and viewer work; see
> [Limits](#limits) for what is not done yet.

## Quick start

```bash
git clone https://github.com/Louiszhang2005-1/AI-for-hardware--3D-Print--CAD.git wiremap
cd wiremap
node bin/wiremap.mjs check projects/robot-arm.json
node viewer/serve.mjs
```

Open the printed localhost link and select the reference robot arm or rover.
Use `node bin/wiremap.mjs new robot-arm my-arm` to start an editable copy.
Then open Claude Code or Codex in the folder and say:

> Use wiremap: 4-servo robot arm with an ESP32. I have a breadboard and a Bambu A1 mini, and I use build123d.

### SolidWorks and Bambu Studio example

For standalone SolidWorks help, ask Codex or Claude Code a question like “Why
is this sketch over defined in SolidWorks?” or “Help me export this SLDPRT at
the right scale for my A1 mini.” The skill can work from a description, a
FeatureManager screenshot, or a model.

While SolidWorks is open on the same Windows PC as Codex or Claude Code,
select the feature, sketch, face, or mate you want to ask about. Then ask
“Use Wiremap to see what I selected in SolidWorks and help me with it.”
Wiremap reads the active document and selection on request. To see the
same read-only snapshot in a terminal, run:

```bash
node bin/wiremap.mjs solidworks-session --json
```

The reference arm includes a printable electronics tie-down deck. The [CAD folder](cad/robot-arm/) has an editable SolidWorks part, a STEP file, a watertight STL, and the Windows script that generated them. The arm links and gripper depend on the builder's measured servos and mechanical design.

```bash
node bin/wiremap.mjs fit-printer --project projects/robot-arm.json
node bin/wiremap.mjs export-print --project projects/robot-arm.json --out exports/robot-arm
```

Open `exports/robot-arm/plates/pla_plate_1.3mf` in Bambu Studio. Select your printer, nozzle, and filament, then slice the plate. The default project profile is the A1 mini. The [bring-up sketch](firmware/arm_bringup/) is for I²C detection and keeps the servo outputs disabled. See the [validation results](docs/VALIDATION.md) for the six tested printer profiles.

For your own project, list split STLs under `prints[].pieces[].file` or individual print STLs under `prints[].files`. A lone STL can go under `prints[].source`. Both print commands check every selected STL against the printer's build volume and reserved bed areas. If a piece fails, fix the reported file and rerun before slicing the full set. The export can still contain plates for the pieces that passed.

Use `wiremap split-part --stl part.stl --printer bambu-a1-mini --out exports/split` for an oversized mesh. The command keeps the original CAD coordinates in the split STLs and places the validated 3MFs on the bed. Use the 3MF paths listed in the current joint plan. Apply the joint features in CAD and re-export the final parts if your assembly needs pins, bolts, or a dovetail.

### Use it in every project

| Tool | How |
| --- | --- |
| Claude Code (plugin) | `/plugin marketplace add <owner>/<repo>` then `/plugin install wiremap@wiremap` |
| Claude Code (no plugin) | `node bin/wiremap.mjs install --claude-skill` |
| Codex | `node bin/wiremap.mjs install --codex-skill` (copies the skill to `~/.codex/skills/wiremap/`) |
| Auto-start for every hardware prompt | `node bin/wiremap.mjs install --global-line --hook` (asks before writing anything; `--uninstall` reverts) |

Opening this repo directly also works: Claude Code reads `.claude/skills/wiremap/`,
Codex reads `AGENTS.md`. All three are generated from `skills/wiremap/SKILL.md`
(`node scripts/sync-skill.mjs`).

## What's inside

| Piece | What it does |
| --- | --- |
| `skills/wiremap/SKILL.md` | The skill: 8-phase build process, project format, safety and accuracy rules, CAD and print rules, review agents |
| `lib/check.js` | Electrical checker, plain deterministic rules (runs in Node and in the viewer) |
| `lib/calc.js` | Calculators: Ohm, LED resistor, divider (real E12/E24 values), power budget, regulator heat, wire drop and gauge, runtime, fuse, print fits, inserts, screws |
| `lib/breadboard.js` | Exact hole-by-hole breadboard layout and breadboard rule checks |
| `lib/printer.js`, `printers/` | Printer build volumes, materials, fit and split planning |
| `lib/export.js`, `lib/firmware.js` | `pins.h`, BOM CSV, WireViz, KiCad netlist, HTML guide; firmware pin scan and mismatch check |
| `library/` | Part definitions with pinouts, limits, breadboard and geometry data, with sources |
| `viewer/` | Local viewer: circuit sketch, breadboard, 3D, power tree, guided steps, assembly |
| `schema/` | JSON Schema for project and part files |
| `projects/` | Reference projects (the AI writes yours here) |

### What the checker catches

| Check | Example | Level |
| --- | --- | --- |
| Short circuit | Battery + wired straight to GND | Error |
| Over-voltage | 2S LiPo (8.4 V full) on a 7.2 V servo | Error |
| Logic level | HC-SR04 5 V echo into an ESP32 GPIO; a divider that's too weak; a series resistor alone | Error |
| Supplies fighting | USB 5 V and a 5.2 V buck on one rail | Error |
| No common ground | Servo supply GND not joined to the ESP32 GND | Error |
| Overloaded supply | 4 × MG996R (10 A stall) on a 5 A supply | Error (typical) / warning (peak, >80%) |
| Signal used as power, outputs fighting, output into GND, motor on a GPIO | | Error |
| I2C SDA/SCL mixed, missing pull-ups, 5 V pull-ups on a 3.3 V bus; UART TX→TX | | Error / warning |
| Wire too thin, voltage drop, fuse bigger than the wire | 26 AWG carrying 4 A | Warning |
| Under-voltage, regulator dropout, linear regulator heat | | Warning |
| Required pin floating, no ground, unpowered part | TB6612 STBY floating | Warning |
| Missing protection | Lithium pack with no fuse or no BMS/cutoff on a load path, no switch, motor with no flyback path | Error / warning |
| Mains or > 60 V DC | | Error (out of scope) |

"0 errors" means **no rule violations found**, not "safe": heat, EMI,
mechanical load and firmware behaviour are not checked, and the report says so.

## Commands

```bash
node bin/wiremap.mjs --help
```

`check`, `layout-breadboard`, `calc`, `fit-printer`, `split-part`,
`export-print`, `part-geometry`, `export`, `import-repo`, `inbox`, `serve`,
`feedback`, `new`, `install`. Each also runs as `node scripts/<name>.mjs`.

## Keep AI corrections for future builds

Use **Corrections** in a project to save what the AI said, what should replace it, and any evidence. Approve a correction for the current project or for other projects in the same workspace. The Wiremap skill reads approved corrections at the start of later work, then checks them against the current project and parts. Pending and dismissed entries stay out of the approved list.

```bash
node bin/wiremap.mjs feedback list --project robot-arm
node bin/wiremap.mjs feedback list --project robot-arm --all
```

The history stays in `.wiremap/feedback.jsonl` in the project workspace. Keep a copy of that file when moving the workspace if you want to carry the history with it. The correction log provides local memory for the skill. Model weights stay unchanged.

## Tests

```bash
npm test
```

Includes the known-bad design suite (every seeded wiring mistake must be
caught), checker unit tests, library validation, breadboard, calculators,
printer, STL/3MF, exports, firmware scan, viewer server and the
auto-activation prompt set (≥ 95 % of 40 hardware prompts trigger the skill,
< 5 % of 40 coding prompts do).

## Limits

- Rule-based checks, not circuit simulation. No PCB layout (export a KiCad netlist instead). No mains projects.
- Wiremap provides part geometry, fit checks, and mesh export for external CAD tools. `split-part` cuts STL meshes with closed caps. Add joint features in CAD using the generated plan.
- Part geometry (board outlines, hole positions) is approximate unless marked verified; electrical data cites its sources. Parts that vary between sellers are marked "Confirm on your board".
- Printer profiles list the maker's specifications. Check the loaded slicer preset for nozzle-specific exclusions and machine settings before sending a job.
- Sending prints to a Bambu printer over LAN needs Developer Mode and an optional printer MCP server (for example [synman/bambu-mcp](https://github.com/synman/bambu-mcp)); otherwise open the 3MF in your slicer.
- The PRD planned React + react-three-fiber; the viewer uses plain ES modules + three.js so it runs with no build step.
- The viewer→AI link is a file inbox (`.wiremap/inbox.jsonl`) the AI checks between steps; the viewer also shows a ready-to-paste prompt.

## License

MIT. three.js (vendored in `viewer/vendor/three/`) is MIT, © three.js authors.
