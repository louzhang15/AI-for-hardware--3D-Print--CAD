# Wiremap project map

Baseline reviewed on November 20, 2026 at commit `6c8bd9f` on the default branch. Scope comes from the November 19 Wiremap PRD. The order below puts a working fresh-clone experience and checker coverage ahead of expanding the feature set.

This is the baseline audit. See the [validation results](VALIDATION.md) for the implementation and application checks that followed it.

## What works in the baseline

| Workstream | Evidence in the checkout | Remaining work |
| --- | --- | --- |
| Project model and electrical checks | [Project schema](../schema/project.schema.json), [checker](../lib/check.js), and [calculator tests](../tests/calc.test.js) cover the shared project model, electrical rules, rail budgets, runtime, and electrical and print calculations. | Restore the known-bad fixtures and example designs. Resolve gaps in protection rules and the fuse calculator. |
| Parts and breadboard | [Part library](../library/) contains 47 definitions. [Breadboard engine](../lib/breadboard.js) places parts, checks strips and split rails, and formats a jumper list. | Resolve the real 30-pin ESP32 fixture mismatch. Verify release-critical part dimensions and pinouts. Ship the interactive board view. |
| Local viewer and guided build | [Local server](../viewer/serve.mjs) serves files, watches project changes, and supports project state and AI inbox requests. [App shell](../viewer/app.js) wires up tabs, progress, and selections. | Restore the missing modules, then verify sketch, breadboard, 3D, power, assembly, and guided-step interactions against the same project file. |
| Intake, BOM, skill, and firmware | [Skill](../skills/wiremap/SKILL.md) covers the eight build phases. [Firmware import](../scripts/import-repo.mjs) reports proposed parts, pins, and mismatches. [BOM panel](../viewer/panels.js) has ownership toggles, buy links, and totals. | Ship working starter templates, add an editable requirements card and clearer inference confirmation, surface tiered buying options and price dates, and handle currency totals by currency. Add usable bring-up examples and firmware comparison. |
| CAD and printing | [Fit](../scripts/fit-printer.mjs), [mesh splitting](../scripts/split-part.mjs), [part geometry](../scripts/part-geometry.mjs), and [print export](../scripts/export-print.mjs) provide fit and material checks, STL cuts, joint plans, settings files, and 3MF plates. | Verify manufacturer profiles. Exercise one CAD-to-print build, including editable sources, actual joint geometry, assembly preview, and a consistent per-part handoff. |
| Sharing and troubleshooting | [Export CLI](../scripts/export.mjs) offers `pins.h`, BOM CSV, WireViz, KiCad, HTML, and a shopping checklist. [Skill](../skills/wiremap/SKILL.md) describes staged bring-up. | Add guided symptom-based troubleshooting linked to parts and wires. Schedule direct PDF and circuit-image exports after the core path works. |

## Release blockers and work order

### 1. Restore a reproducible baseline

- Recover or recreate tracked `projects/robot-arm.json`, the starter template consumed by [the new-project command](../scripts/new-project.mjs), and the fixtures consumed by the [known-bad harness](../tests/known-bad.test.js). Keep the real arm and rover as separate milestones so the first example can drive the UI work. Done when the README checker command and `wiremap new` succeed in a fresh clone and the fixture harness runs every seeded case.
- Resolve the [real DOIT ESP32 breadboard regression](../tests/breadboard.test.js#L311). The library-backed 30-pin board produces a clearance warning in a test expecting zero warnings. Check the actual variant and body overhang, then align the geometry, layout behavior, and expected available row. Keep both synthetic and library-backed cases.
- Make [PlatformIO parsing](../lib/firmware.js#L442) and [skill mirror validation](../scripts/sync-skill.mjs) handle LF and CRLF consistently. Imported firmware can have either ending regardless of Wiremap's own Git settings. Add clean-checkout CI on Windows and Linux. Done when `npm test` passes on both and covers both input endings.
- Close two checker decisions before publishing battery examples. Define how the project represents external lithium low-voltage cutoff and when the [missing-protection rule](../lib/check.js#L817) blocks release. Require the [fuse calculator](../lib/calc.js#L500) to exclude fuse families whose DC rating is below the requested voltage. Cover accepted and rejected cases with fixtures.
- Verify installation and activation in real Claude Code and Codex sessions. The [existing tests](../tests/skill.test.js) cover trigger phrases and installation in temporary homes. Check that the installed skill still resolves the checkout and can open the same reference project in both clients.

### 2. Make the reference arm usable in the viewer

- Restore `steps.js`, `sketch.js`, `bbview.js`, and `power.js`, which [the entry point imports](../viewer/app.js#L6), and `scene3d.js`, which it loads for 3D and assembly. Add a browser smoke test against the default project directory. Done when the app boots and opens the arm from a fresh clone and all primary tabs render without module errors.
- Connect selection and checker findings across the sketch, breadboard, 3D, power, and step views. Exercise labelled pin selection, wire endpoints and tooltips, hole-by-hole jumper placement, rail typical and peak currents, and highlighting the exact wires for each guided step. Verify that completion and positions persist after reload and that file changes refresh the views.
- Finish the arm walkthrough from requirements and BOM through power, wiring, and first bring-up. Surface the inference confirmation, verification flags, pricing dates and options, and the AI inbox handoff at the relevant steps. Add the two-motor rover after the arm path works. Done when the reference designs have zero checker errors, all wiring steps highlight their intended wires, and a first-time builder can follow the arm guide. Record the first-build time and usability result separately from automated checks.
- Decide how to store reviewer findings and accepted risks in the project file. Align saved phase transitions with the viewer's checker gate and carry confidence labels through to individual pins and values where the sources differ.

### 3. Complete CAD, print, and assembly on the arm

- Verify the six built-in Bambu profiles against manufacturer specifications. All six currently carry `spec_checked: false`. Exercise one supported CAD workflow end to end and deliver editable source alongside print meshes, a settings card, and a slicer-readable plate. Add printer transfer through optional integrations after the slicer handoff works.
- Make [print export](../scripts/export-print.mjs#L121) and [3MF packing](../lib/node/threemf.js#L181) share the same orientation and XYZ fit check for every mesh, including split pieces. Reproduced both a part approved only after rotation that produced no plate and an over-height part emitted on a plate. Done when exported meshes use the verified orientation and fit wholly within the selected printer volume.
- Create a master assembly with a viewer-compatible preview, then validate part clearances, connector access, exploded assembly steps, fasteners, cable routes, and cut lengths. The split command currently makes closed pieces and a joint plan. Add the actual joint features in CAD and verify the fitted parts before calling the split workflow complete.
- Add a repeatable bring-up flow with generated `pins.h`, per-part test sketches, and symptom links to the relevant circuit. Use the assembled arm to verify the full v1.0 gate. Track the PRD's first-time success target of 8 out of 10 builders and first-3D-view target of under 10 minutes; both require user trials.

## Baseline verification

- `npm test` on Windows with Node 22.14.0 and the default CRLF checkout returned 140 passed and 4 failed. The same commit checked out with LF on the same machine returned 142 passed and 2 failed. The DOIT breadboard test and missing known-bad fixtures failed in both; PlatformIO parsing and skill mirror validation failed with CRLF.
- The README's robot-arm check returned `ENOENT`, and the new-project help listed no templates. The tracked [viewer demo fixture](../tests/fixtures/viewer/demo.json) returned zero checker errors, one peak-current warning, and one confirmation note.
- The loopback viewer server returned HTTP 200 for the app shell and an empty default project list. The four static modules and the 3D module returned HTTP 404. This reproduces the boot blocker before manual UI checks can begin.
- Physical builds, live client onboarding, and manufacturer specification checks remain release acceptance work.
