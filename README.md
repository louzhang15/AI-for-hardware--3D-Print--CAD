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

### Overlay next to Bambu Studio and CAD

```bash
node bin/wiremap.mjs overlay             # watch now (Ctrl+C to stop)
node bin/wiremap.mjs overlay --install   # start it at every login (asks first; --uninstall removes it)
```

When Bambu Studio, OrcaSlicer, PrusaSlicer, Cura, SOLIDWORKS, Fusion, FreeCAD,
Onshape, OpenSCAD, Blender, KiCad, Fritzing or the Arduino IDE opens, a small
Wiremap window opens beside it. On Windows it stays on top (Edge or Chrome app
window, pinned with the Win32 API); it closes when the app closes.

| App | What the overlay shows |
| --- | --- |
| Slicers | Selected printer and filament presets against the project, bed fit, material and settings for every print, the export command, printer notes |
| CAD | Live SOLIDWORKS document and rebuild errors, sizes to model, usable build volume, board outlines |
| KiCad, Arduino IDE | Wiring problems and every connection |
| All | Tolerances for this printer (screws, inserts, pins, bearings, servo pockets, plus a calculator), Mechanics, Ask |

`node bin/wiremap.mjs overlay --once` shows what it detects. Slicer presets
are read from `BambuStudio.conf`, `OrcaSlicer.conf` or `PrusaSlicer.ini`.

### Mechanics and robotics checks

Add a `mechanics` section to a project ([format](docs/FORMAT.md)) and
`wiremap check` also tests the mechanical side. The Mechanics tab draws the
arm at its hardest pose with each joint's load against its servo.

| Check | Example | Level |
| --- | --- | --- |
| Joint torque over the whole range (gravity + acceleration) | SG90 shoulder lifting 150 g on 150 mm links | Error / warning below 2× margin |
| Continuous-rotation servo on a positional joint | FS90R as a shoulder | Error |
| Reach and singular poses (inverse kinematics) | Target 500 mm from a 210 mm arm | Error / warning |
| Base servo carrying the arm's bending moment | No turntable bearing | Warning |
| Gripper force vs payload friction | | Error / warning |
| Printed fits vs the printer profile | 3 mm pin in a 3.0 mm printed hole | Error / warning |
| ISO 286 fits vs process and intent | H7/p6 where a sliding fit is wanted; IT7 on an FDM hole | Error / warning |
| Tolerance stack-ups, worst case and RSS | Three spacers longer than the slot | Error / warning |
| Bolts, including bearing on the printed plate | One M2 in a 1.2 mm tab at 200 N | Error / warning |
| Printed link stress and deflection | Thin PLA bracket at 40 N | Error / warning |
| Gear tooth stress (Lewis), undercut, printable module | Module 0.5 PLA gears at 1 N·m | Error / warning |
| Rover torque and traction | TT motors up a 20° ramp | Error / warning |
| Drone thrust-to-weight, prop overlap, battery C rating, ESC headroom | 7" props on a 220 mm frame | Error / warning |
| Walls thinner than the nozzle, low-temperature plastic near heat | | Error / warning |

One-off numbers: `wiremap calc iso-fit --nominal 22 --fit H7/p6`, `calc
stackup`, `calc bolt`, `calc beam`, `calc gear`, `calc lead`, `calc drone`,
`calc rover`, `calc kgcm`. All values are estimates from published formulas
and typical material data: print a test part and load it.

### Change pins in the viewer

Select a wire and choose **Change pin** on either end. Every pin on the part
is listed with what the checker would say if the wire moved there, best
first; pins that cause an error need a second click. **Connect to…** on a pin
adds a wire. Edits are written to the project file with an undo stack in
`.wiremap/history/`, and `wiremap export pins-h` regenerates the firmware pins.

### Why this part and not that one

```bash
node bin/wiremap.mjs compare projects/robot-arm.json --part servo-shoulder
```

Swaps every candidate into that spot, re-runs the torque, supply current and
heat checks (a heavier elbow servo lowers the shoulder's margin), and gives a
reason for each pick or rejection.

### Check CAD output before printing

```bash
node bin/wiremap.mjs cad-check --project projects/robot-arm.json
node bin/wiremap.mjs cad-check --stl part.stl --printer bambu-a1-mini
```

Size versus intent, watertight mesh, overhangs for the chosen orientation,
bed contact, assembly interference, screwdriver access and assembly order.

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
| Special pins | LED on ESP32 GPIO12 (boot strapping), servo signal from input-only GPIO34, a signal on EN or the USB serial TX/RX | Warning / error |
| Supply into a signal pin | USB 5 V wired to an ESP32 GPIO | Error |
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

- Mechanical checks are static and quasi-static estimates (no fatigue, creep, vibration or control tuning). Printed strengths are typical values; servo torque data is from datasheets marked "confirm".
- The overlay stays on top on Windows only; on macOS and Linux it opens as a normal app window.
- Rule-based checks, not circuit simulation. No PCB layout (export a KiCad netlist instead). No mains projects.
- Wiremap provides part geometry, fit checks, and mesh export for external CAD tools. `split-part` cuts STL meshes with closed caps. Add joint features in CAD using the generated plan.
- Part geometry (board outlines, hole positions) is approximate unless marked verified; electrical data cites its sources. Parts that vary between sellers are marked "Confirm on your board".
- Printer profiles list the maker's specifications. Check the loaded slicer preset for nozzle-specific exclusions and machine settings before sending a job.
- Sending prints to a Bambu printer over LAN needs Developer Mode and an optional printer MCP server (for example [synman/bambu-mcp](https://github.com/synman/bambu-mcp)); otherwise open the 3MF in your slicer.
- The PRD planned React + react-three-fiber; the viewer uses plain ES modules + three.js so it runs with no build step.
- The viewer→AI link is a file inbox (`.wiremap/inbox.jsonl`) the AI checks between steps; the viewer also shows a ready-to-paste prompt.

## License

MIT. three.js (vendored in `viewer/vendor/three/`) is MIT, © three.js authors.

## Ask Wiremap: assistant and chatbot

The orb at the bottom right of the viewer (press V to talk) answers plain
requests: "how do I connect the motor to the ESP32" zooms the 3D view to the
exact pins, "where does SDA go", "what is GND", "my servo jitters", "go to
step 3", "open the rover project". Other questions go to a chatbot that runs
your own Claude Code (`claude -p`) or Codex (`codex exec`) locally. No API
key; **AI: Auto** switches to the other one when one runs out of tokens.

| Access (panel menu) | Claude Code | Codex |
| --- | --- | --- |
| Read only (default) | Read, Grep, Glob, `wiremap` commands | `--sandbox read-only` |
| Can edit project | adds Edit and Write | `--sandbox workspace-write` |
| Full access (asks to confirm) | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |

The pop-out button floats the panel over other apps (Document
Picture-in-Picture, Chrome or Edge). For an overlay that opens by itself,
use `wiremap overlay` (above).

On Windows with SOLIDWORKS open, the panel shows the active document and a
**SOLIDWORKS** switch. When it is on, every chatbot question includes a live
snapshot: document, configuration, sketch status, material, size, mass, the
features or mates with rebuild errors, and the selection. Ask "why is my
model failing?" or "will this part fit my printer?". The same snapshot is
available as `wiremap solidworks-session --json`. Set
`WIREMAP_SOLIDWORKS_FIXTURE=<file.json>` to replay a saved snapshot on any OS.
