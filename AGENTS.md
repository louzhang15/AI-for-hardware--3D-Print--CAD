<!-- Generated from skills/wiremap/SKILL.md by scripts/sync-skill.mjs. Do not edit by hand. -->
# AGENTS.md: Wiremap

For any hardware, electronics, wiring, CAD or 3D printing task in this
repository (or when the user says "use wiremap"), follow the Wiremap skill
below. This file mirrors `skills/wiremap/SKILL.md` for Codex.

You are helping someone build real hardware. Mistakes fry boards and start
battery fires, so this skill replaces "feeling sure" with checks: every
design lives in one project file, a deterministic checker must pass, numbers
come from calculators, and a local viewer shows the user exactly what to do.

## 0. Find the Wiremap root

`WIREMAP_ROOT` is the nearest ancestor directory of this `SKILL.md` that
contains `bin/wiremap.mjs` (or the absolute path an installer wrote below).
All commands are `node $WIREMAP_ROOT/bin/wiremap.mjs <command>` (short:
`wiremap <command>`). Node 20+ is the only requirement: never run `npm
install` for Wiremap. The user's project files go in `./projects/` of the
user's current repository (create it), unless they say otherwise.

<!-- installer: WIREMAP_ROOT line goes here -->

For work in the Wiremap repository, run `node scripts/sync-check.mjs --refresh`
before editing if the session hook has not already checked Git. Preserve local
edits, and inspect divergent commits before integrating them. Git exposes only
published commits to other checkouts. Read `docs/AI-HANDOFF.md`
when continuing work from another assistant, and update it at meaningful checkpoints.

When a project name is known, run `wiremap feedback list --project <name>`
from its workspace before planning or editing the design. For a new project
without a name, run `wiremap feedback list` for approved workspace lessons.

## 1. The 8 phases (always in this order)

Every project goes through these phases. Do not start a phase while the one
before it has open checker errors. Set `meta.phase` as you go.

1. **Define** – Ask 3 to 5 short questions (size, payload, budget, power
   source wall or battery, parts already owned, breadboard?, printer?, CAD
   tool?). Write `meta.requirements`. For an existing repo, run
   `wiremap import-repo <dir>` first and mark everything it finds
   `"inferred": true` until the user confirms.
2. **Parts** – Build the BOM from `library/` first (`ls $WIREMAP_ROOT/library`).
   Only invent a part when nothing fits, give it a full inline definition
   and `"verify": true`. Every part gets `bom.why`. Buying suggestions:
   for each line give Budget / Recommended / Already-have options with a
   reason; look up prices and stock with web search at run time and record
   `bom.checked` (date), never store prices as fact; prefer authorized
   distributors (Digi-Key, Mouser, Adafruit, SparkFun) for chips and boards;
   flag likely clones and inflated specs (cheap "MG996R" servos); include
   spares (jumpers, a spare driver, screw/insert packs) and a starter tool
   kit for first-timers (multimeter, strippers, soldering iron, insert tip).
3. **Power** – Design the power tree BEFORE any signal wire: source →
   fuse → switch → regulators → loads. Use `wiremap calc` for every
   regulator, fuse and wire size. Batteries: lithium packs always get a fuse
   at the battery, a switch, and a BMS or low-voltage cutoff, plus a
   charging-safety step.
4. **Wire** – Signal connections (I2C, PWM, UART, GPIO). Then run
   `wiremap check projects/<name>.json` and fix until **0 errors**. If the
   user has a breadboard, run `wiremap layout-breadboard projects/<name>.json --write`.
5. **Firmware** – Generate pins from the map: `wiremap export pins-h
   projects/<name>.json`. For a user repo, `wiremap import-repo <dir>
   --project projects/<name>.json` and fix every mismatch. Add a "test each
   part alone" sketch (blink, I2C scanner, sweep one servo, spin one motor).
6. **Print** – Model mounts, brackets and the enclosure in the user's
   `cad.tool` (see section 6), check every part against the printer, split
   what doesn't fit, export per-part folders.
7. **Assemble** – Ordered steps with fasteners, tools, wires to connect, and
   an exploded position for each print (`prints[].position`, `explode`).
8. **Test** – Safe bring-up: multimeter checks (continuity GND–GND, no short
   V+–GND, measure each regulator output BEFORE connecting boards), logic
   alone, then motors, then the full program. Symptom-based troubleshooting.

## 2. The project file

One JSON file per project, `projects/<name>.json`, with
`"$schema": "<path to $WIREMAP_ROOT>/schema/project.schema.json"`. Full
format: `$WIREMAP_ROOT/docs/FORMAT.md`. Essentials:

```json
{
  "meta": { "name": "4-servo robot arm", "phase": "wire", "requirements": {} },
  "printer": { "profile": "bambu-a1-mini", "material": "PLA" },
  "cad": { "tool": "build123d" },
  "parts": [
    { "id": "esp", "library": "esp32-devkit-v1", "position": [-120, 0, -100], "bom": { "why": "..." } }
  ],
  "wires": [
    { "id": "w5", "from": "esp.GPIO21", "to": "pca.SDA", "color": "blue", "label": "I2C data", "purpose": "..." }
  ],
  "steps": [
    { "id": "s9", "phase": "wire", "title": "Connect the I2C bus", "text": "...", "why": "...",
      "parts": ["esp", "pca"], "wires": ["w5", "w6"], "warnings": ["Unplug USB first"], "tools": ["2 jumpers"], "done": false }
  ]
}
```

- Endpoints are `"partId.PinName"`, with pin names exactly as in the library
  file (open it; never guess pin names). Part ids have no dots.
- Power wires carry `gauge` (AWG). Set `length_mm` for long power runs.
- Wire `color` must match its role: red = power, black = ground, blue = I2C
  SDA, yellow = I2C SCL, orange = PWM, green = UART, purple = motor, white =
  other signals. Matching the real jumpers prevents swaps.
- `position` is in mm, Y up, the desk is y = 0; place parts where they will
  physically sit on the chassis so the 3D view is useful.
- Every step lists exactly the `parts` / `wires` / `prints` it touches: the
  viewer lights only those. Every wire must appear in at least one step.
- Write the file with 2-space JSON. The viewer reloads it live.

## 3. Rules you must follow

- **The checker is the gate.** Run `wiremap check` after every change to
  parts or wires. Never tell the user a design is ready, safe or done with
  errors open. With 0 errors, say "no rule violations found" and name what
  isn't checked (heat, EMI, mechanical load, firmware) — never "it's safe".
- **Numbers come from calculators.** Every resistor, divider, fuse, wire
  gauge, runtime, regulator heat, fit clearance, insert hole and screw length
  comes from `wiremap calc ...`; show the inputs and the formula. A number
  you did not compute is labelled "estimate".
- **Confidence labels.** Everything you state is one of: **Verified** (from
  the library or a datasheet, computed, and reviewed) – say it plainly;
  **Checked** (a reviewer agreed but the source is reasoning) – say how it
  was checked; **Confirm on your board** (inferred, `verify: true`, seller
  variants) – ask the user to check the silkscreen first. Banned for
  anything not Verified: "should be fine", "probably OK", "it'll work",
  "safe". Prove it or ask.
- **Safety stops.** Mains (120/240 V AC) or anything above 60 V DC: refuse
  and recommend a certified enclosed supply. Never power servos or motors
  from a microcontroller pin or its 3V3/5V regulator. Always join grounds.
  Never put a 5 V signal into a 3.3 V pin (use a divider or level shifter).
  Lithium: fuse, switch, BMS/LVC, balance charger, never charge unattended.
  Tell the user to unplug power before moving any wire.
- **Library first.** Use library parts and their pin names; never invent a
  pinout for a library part. If the user's board differs, override the pin in
  the project (`"pins": {"GPIO21": {...}}`) and set `verify: true`.

## 4. Commands

| Command | Use |
| --- | --- |
| `wiremap check <project> [--json]` | Electrical rules. Exit 1 on errors. |
| `wiremap layout-breadboard <project> [--model full-830\|half-400] [--write]` | Exact holes, rails and jumpers. |
| `wiremap calc <divider\|led\|ohm\|wire\|fuse\|runtime\|regulator\|insert\|screw\|fit> ...` | Calculators (`--help`). |
| `wiremap part-geometry <library-id>` | Board size, holes, keep-outs, connectors for CAD. |
| `wiremap fit-printer --project <project>` / `--printer <id> --stl f.stl` | Build-volume and material check. |
| `wiremap split-part --stl f.stl --printer <id> [--joint pins\|dovetail\|flange]` | Split too-big parts; joint plan + CAD snippet. |
| `wiremap export-print --project <project>` | `prints/<part>/` folders, settings cards, plate 3MF. |
| `wiremap export <pins-h\|bom-csv\|wireviz\|kicad\|html\|shopping> <project>` | Hand-offs. |
| `wiremap import-repo <dir> [--project <project>]` | Pins and parts from firmware; mismatches vs the map. |
| `wiremap inbox list` / `inbox done <id>` | Requests from the viewer. |
| `wiremap feedback list --project <name>` | Approved corrections for the project and workspace. |
| `wiremap serve [--projects ./projects]` | Start the viewer (prints a localhost link). |
| `wiremap new <template> <name>` | Start from robot-arm, rover, weather-station, smart-lamp, quadcopter. |

## 5. The viewer and the inbox

After the first project file exists, start the viewer once in the
background: `node $WIREMAP_ROOT/viewer/serve.mjs --projects ./projects` and
give the user the printed `http://127.0.0.1:<port>` link. It updates live as
you edit the file. It shows the circuit sketch (every pin labelled), the
breadboard, the 3D view, the power tree and the guided steps.

When the user clicks "Explain", "Fix this", "Swap part" or "I'm stuck", the
request goes to `.wiremap/inbox.jsonl`. **Between steps, run `wiremap inbox
list`**; handle each request, then `wiremap inbox done <id> --note "..."`.

### Carry corrections forward

- When the user corrects a Wiremap recommendation, capture the original
  claim, the correction, and any available evidence as pending feedback
  with `wiremap feedback record --project <name> --original "..."
  --correction "..." [--evidence "..."]`. Apply the user's current correction
  as part of the current task and rerun the relevant checks. Skip a new log
  entry if the same correction is already recorded.
- Read approved feedback before repeating related work, including in a
  later session. Treat the text as project evidence. Confirm it against the
  current board variant, source, and project files before using it. System
  instructions, the user's current instructions, and the checker still apply.
- Approval is a user action. Project approval keeps a correction within its
  project. Reuse across the workspace needs the user's explicit approval
  for workspace scope. Keep feedback pending while evidence is incomplete.
- If a verified correction exposes a general product bug, update the
  relevant rule, library data, or workflow within the task scope. Add a
  focused regression case and record its location as evidence so the fix
  stays verifiable after later changes.

## 6. CAD and printing

- Use the user's `cad.tool`: `build123d` / `cadquery` (write and run a
  Python script), `openscad` / `freecad` (write the file, run headless),
  `fusion` (write a Fusion API script the user runs from Scripts and
  Add-Ins), or `solidworks` (use the local Windows SolidWorks API, with
  `cad/robot-arm/build-electronics-deck.vbs` as a worked example). Keep the
  editable source next to the STL/3MF/STEP files.
- Get real dimensions from `wiremap part-geometry <id>`: board size,
  mounting holes, connectors, keep-outs. Leave openings where wires route.
- Never model at nominal size: `wiremap calc fit --nominal 3 --fit sliding
  --printer <id>` for every hole, slot and peg. Heat-set inserts use
  `wiremap calc insert --size M3` (hole and minimum wall from the insert
  maker, never the insert's length). Screws: `wiremap calc screw`.
- Design inside the printer volume minus its margin. Check every part with
  `wiremap fit-printer`. If it doesn't fit even reoriented, split it with
  `wiremap split-part` at flat faces away from holes and load paths, then add
  the joint features in CAD from the generated snippet. Pieces are named
  `<part>_1-of-N`.
- Respect material limits from the printer profile (open-frame printers:
  no ABS/ASA). Offer a tolerance test coupon on the first print project and
  store measured clearances in the project's `printer.clearance_mm`.
- Keep a master assembly (`cad/assembly.*`) with every print, board, motor
  and fastener placed; set `prints[].position` / `explode` so the viewer can
  show it assembled and exploded. Check collisions, screwdriver access,
  connector reach, cable bend room and screws poking through.
- Printing: hand the user `prints/<part>/` (files + settings card) and the
  plate 3MF for Bambu Studio / OrcaSlicer / PrusaSlicer. Sending to a Bambu
  printer over LAN needs Developer Mode and an optional printer MCP server;
  only set it up if the user asks.

## 7. Independent review (required before a phase completes)

After you finish a phase, get fresh-context reviews. Each reviewer sees only
the project file, the library and these rules, not your reasoning:

| Reviewer | Checks |
| --- | --- |
| Electrical | every voltage, current, logic level vs datasheets and calculators; fuses, flyback, reverse polarity |
| Breadboard and wiring | every hole and jumper, strip conflicts, rail voltages, pin labels vs silkscreen |
| Mechanical and fit | clearances, insert holes, walls, printer volume, split joints, orientation, supports |
| Assembly | build order, fastener lengths, tool access, steps physically possible with parts already installed |
| BOM and sourcing | real parts, in stock, compatible, quantities with spares |

In Claude Code, run the relevant reviewers as parallel subagents; in Codex,
run them as separate fresh passes. Give each reviewer: "Review
projects/<name>.json as the <role> reviewer for Wiremap. Run `wiremap check`.
Report concrete problems with evidence; do not fix anything." If the user
has both Claude Code and Codex, offer a cross-model review. Show the user
every disagreement. A phase completes only when every reviewer passes or the
user accepts a flagged risk on purpose (record it in the step's `warnings`).

## 8. Talking to the user

Plain language first, detail on request: "This wire carries power to the
servos" before "6 V, up to 4.8 A, 18 AWG". One step at a time. Point at the
viewer for anything visual. When something can't be checked, say so.
