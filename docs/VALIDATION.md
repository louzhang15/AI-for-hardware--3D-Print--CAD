# Reference project validation

The reference arm includes a SolidWorks electronics deck and an ESP32 I²C bring-up sketch. The tests below cover the software handoff from the project file to the viewer, CAD model, and Bambu Studio plate.

| Check | Result |
| --- | --- |
| Robot arm and rover | Both reference projects reported zero checker errors and warnings. |
| Local viewer in Chrome | Opened the reference arm and loaded its actual STL in Assembly. Verified labelled sketch pins, keyboard wire selection, breadboard highlights, 3D wire filtering, rail budgets, and saved step progress. Created a new arm from a template and saved requirements across a reload. |
| Correction log in Chrome and the CLI | Recorded pending feedback with evidence, verified project approval and persistence, promoted it to workspace scope, and dismissed it. The CLI distinguished approved lessons from history. Twelve concurrent records were saved without losing entries. |
| SolidWorks Design 2026, revision 34.4.1 | The automation script generated `SLDPRT`, STEP, and STL files. The native file and imported STEP each reopened at 85 × 60 × 3.2 mm with a volume of 15,659.25 mm³. The STL matched the dimensions and had no open or mismatched edges. |
| ESP32 Arduino core 3.3.12 | The arm sketch compiled for `esp32:esp32:esp32`. Firmware import matched five pin uses to the project without a mismatch. |
| Export CLI | Generated the pin header, BOM CSV, WireViz YAML, KiCad netlist, HTML guide, and shopping checklist from the reference arm. |
| Claude Code 2.1.326 | The local plugin and marketplace manifests passed validation with optional catalog metadata warnings. |
| Claude Code and Codex skill installer | Installed and removed both skill mirrors in a temporary home, with the installed skills pointing to the correct checkout. |

## Bambu Studio

Bambu Studio 02.09.01.70 sliced the deck using the installed Bambu profiles, a 0.4 mm nozzle, 0.20 mm Standard, and Bambu PLA Basic. The slicer kept Wiremap's original plate arrangement. All six runs completed without warnings. [Bambu Studio command-line guide](https://github.com/bambulab/BambuStudio/wiki/Command-Line-Usage)

| Profile | Slicer estimate | Filament estimate |
| --- | ---: | ---: |
| A1 mini | 19m 10s | 12.44 g |
| A1 | 19m 13s | 12.43 g |
| P1S | 18m 16s | 12.42 g |
| P2S | 18m 09s | 12.42 g |
| X1 Carbon | 18m 16s | 12.42 g |
| H2D | 18m 23s | 12.42 g |

## Reproduce the handoff

```bash
npm test
node bin/wiremap.mjs check projects/robot-arm.json
node bin/wiremap.mjs check projects/rover.json
node bin/wiremap.mjs export-print --project projects/robot-arm.json --out exports/robot-arm
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/arm_bringup
```

In Bambu Studio, open `exports/robot-arm/plates/pla_plate_1.3mf`, select the printer, and slice the plate. Check the actual material and nozzle before printing.

To regenerate the deck with SolidWorks, pass an English-language part template and an existing empty output directory to `cscript //nologo cad\robot-arm\build-electronics-deck.vbs`. SolidWorks must be installed and licensed. The script restores the app's STL export settings after export. [SolidWorks STL export settings](https://help.solidworks.com/2013/English/Api/swconst/FileSaveAsSTLOptions.htm)

The tests used software and files. Physical printing, servo motion, electronics measurements, and assembly fit still require a bench build.
