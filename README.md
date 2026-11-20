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
git clone <this repo> wiremap
```

```bash
cd wiremap && node bin/wiremap.mjs check projects/robot-arm.json
```

```bash
node viewer/serve.mjs
```

Open the printed `http://127.0.0.1:...` link to see the reference robot arm.
Then open Claude Code or Codex in the folder and say:

> Use wiremap: 4-servo robot arm with an ESP32. I have a breadboard and a Bambu A1 mini, and I use build123d.

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
| Missing protection | Lithium pack with no fuse (error), no switch, no BMS, motor with no flyback path | Error / warning |
| Mains or > 60 V DC | | Error (out of scope) |

"0 errors" means **no rule violations found**, not "safe": heat, EMI,
mechanical load and firmware behaviour are not checked, and the report says so.

## Commands

```bash
node bin/wiremap.mjs --help
```

`check`, `layout-breadboard`, `calc`, `fit-printer`, `split-part`,
`export-print`, `part-geometry`, `export`, `import-repo`, `inbox`, `serve`,
`new`, `install`. Each also runs as `node scripts/<name>.mjs`.

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
- Wiremap has no CAD engine: your AI writes build123d / CadQuery / OpenSCAD / FreeCAD / Fusion code using the part geometry and fit calculators. `split-part` cuts STL meshes with closed caps, but joint features (pins, dovetails, flanges) are added in CAD from the generated snippet.
- Part geometry (board outlines, hole positions) is approximate unless marked verified; electrical data cites its sources. Parts that vary between sellers are marked "Confirm on your board".
- Printer profiles must be checked against the maker's spec page (`spec_checked` in each file).
- Sending prints to a Bambu printer over LAN needs Developer Mode and an optional printer MCP server (for example [synman/bambu-mcp](https://github.com/synman/bambu-mcp)); otherwise open the 3MF in your slicer.
- The PRD planned React + react-three-fiber; the viewer uses plain ES modules + three.js so it runs with no build step.
- The viewer→AI link is a file inbox (`.wiremap/inbox.jsonl`) the AI checks between steps; the viewer also shows a ready-to-paste prompt.

## License

MIT. three.js (vendored in `viewer/vendor/three/`) is MIT, © three.js authors.
