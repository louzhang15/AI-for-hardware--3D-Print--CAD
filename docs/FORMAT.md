# Wiremap file formats (contract)

This file is the contract between the skill, the scripts, the checker and the
viewer. Everything reads the same project file and the same part library.

All code is plain ES modules (`.js` / `.mjs`), Node 20+ and modern browsers,
**no npm dependencies** (the viewer vendors three.js in `viewer/vendor/`).
Modules in `lib/` must not import Node built-ins so the browser can use them;
Node-only helpers live in `lib/node/` and `scripts/`.

## Units and coordinates

- Lengths in **mm**, voltages in **V**, currents in **A**, angles in **degrees**.
- World space (3D view and project `position`): **Y is up**, the desk is the
  plane `y = 0`. `position: [x, y, z]` is the centre of the part's bottom face.
  `rotation: [rx, ry, rz]` in degrees (normally only `ry`).
- A part's `size: [sx, sy, sz]` is its bounding box before rotation: `sx`
  along world X, `sy` height, `sz` along world Z.
- **Footprint coordinates** `pos: [u, v]` for pins: top view of the part,
  origin at the top-left corner of the footprint, `u` to the right (world +X),
  `v` down the drawing (world +Z). So a pin's local 3D point is
  `(u - sx/2, sy, v - sz/2)`, then rotated and translated by the part pose.
  Optional pin `z` overrides the height (default `sy`, the top face).

## Library part (`library/<id>.json`)

```jsonc
{
  "id": "pca9685-breakout",            // equals the file name
  "name": "PCA9685 16-channel PWM driver (Adafruit-style breakout)",
  "category": "driver",                // controller | driver | actuator | sensor | power | battery | protection | passive | module
  "description": "One line: what it does and why you'd use it.",
  "datasheet": "https://...",
  "sources": ["https://..."],          // where pinout and limits come from
  "confidence": "verified",            // verified | checked | confirm  (electrical data)
  "notes": ["Seller variants differ in ..."],
  "size": [62.2, 4, 25.4],             // see coordinates
  "color": "#1f4fa8",                  // board colour for drawings (optional)
  "params": { "vout": 5.0 },           // adjustable values, referenced as "$vout" in numbers
  "pins": [
    {
      "name": "VCC",                   // unique within the part; used in "part.pin"
      "label": "VCC",                  // exact silkscreen text
      "kind": "power_in",              // see pin kinds
      "dir": "in",                     // in | out | io  (signals)
      "voltage": 3.3,                  // output voltage, or the logic level of a signal pin
      "voltage_max": 8.4,              // worst-case source voltage (full battery)
      "voltage_min": 6.0,              // lowest source voltage (empty battery)
      "vmin": 2.3, "vmax": 5.5,        // range an input safely accepts
      "vih": 2.0,                      // minimum voltage read as HIGH (optional)
      "current": 0.01,                 // typical draw of a power_in pin (A)
      "current_peak": 0.02,            // peak draw (A)
      "current_max": 5,                // what a power_out pin can deliver (A)
      "required": true,                // must be connected
      "voltage_ref": "VCC",            // signal level follows the net voltage on this pin of the same part
      "vmax_ref": "VCC", "vmax_offset": 0.5, // input max follows another pin (e.g. VCC + 0.5 V)
      "pullup": 3.3, "pullup_weak": false, // I2C pull-up on the board, to this voltage
      "pullup_ref": "VCC",             // ...or pulled up to whatever voltage this pin of the same part gets
      "open_drain": true,              // I2C / open-collector outputs never fight
      "pos": [3.2, 22.9]               // footprint position
    }
  ],
  "internal": [["GND", "GND_2"], ["V+", "V+_T"]],  // pins joined inside the part (same net)
  "regulators": [                       // a power output derived from an input
    { "in": "VIN", "out": "3V3", "gnd": "GND", "type": "linear", "vout": 3.3,
      "dropout": 1.1, "current_max": 0.6, "iq": 0.005, "efficiency": 0.9, "vin_max": 12 }
  ],
  "battery": { "chemistry": "lipo", "cells": 2, "capacity_ah": 2.2, "bms": false, "c_rating": 25 },
  "protection": "fuse",                 // fuse | switch | bms | low-voltage-cutoff | diode
  "rating_a": 5,                        // for protection parts
  "flyback": true,                      // motor outputs have flyback diodes built in
  "mains": false,                       // true => checker refuses (out of scope)
  "breadboard": {
    "fit": "straddle",                  // straddle (DIP / dual-row module) | single (one row of header pins) | offboard
    "rows": [["1","2","3","4","5","6","7","8"], ["16","15","14","13","12","11","10","9"]],
    "row_spacing": 3,                   // distance between the two rows, in 0.1" (2.54 mm) steps
    "body_width_mm": 9.5,               // across the rows, for free-hole checks
    "row": "e",                         // single-row parts: preferred row (default e)
    "jumper": "male-female"             // off-board parts: jumper type to the breadboard
  },
  "geometry": {                          // for CAD (get_part_geometry)
    "board": [62.2, 25.4, 1.6],          // L x W x T of the PCB
    "holes": [{ "pos": [3.2, 3.2], "d": 2.5 }],
    "keepout": [{ "rect": [0, 0, 10, 25.4], "height": 12, "note": "screw terminal" }],
    "connectors": [{ "name": "USB", "pos": [0, 12.7], "side": "left" }],
    "confidence": "confirm"
  }
}
```

### Pin kinds

`power_in`, `power_out`, `power_rail` (pass-through power, e.g. a terminal),
`ground`, `digital`, `pwm`, `analog`, `i2c_sda`, `i2c_scl`, `uart_tx`,
`uart_rx`, `spi`, `motor` (motor coil / driver output), `passive`
(resistor, LED, switch leg), `nc` (not connected).

Signal pins of a microcontroller are usually `digital` with `dir: "io"`,
`voltage` = logic level and `vmax` = absolute max (ESP32: 3.3 / 3.6).
For two-terminal DC motors on a bridge, both `motor` output pins can point
their `voltage_ref` at the driver's motor supply `power_in` pin. The checker
adds the motor's declared typical and peak current to that rail once.

For series protection devices, the `internal` pin group defines the protected path. Use `low-voltage-cutoff` for a modeled cutoff device in the load path and `battery.bms` for verified protection built into the pack.

## Project file (`projects/<name>.json`)

Top-level keys: `meta`, `printer`, `cad`, `parts`, `wires`, `breadboard`,
`prints`, `fasteners`, `steps`, `assembly`, `bom`, `mechanics`.

```jsonc
{
  "$schema": "../schema/project.schema.json",
  "meta": { "name": "4-servo robot arm", "description": "...", "phase": "wire",
            "requirements": { "size": "...", "payload": "...", "runtime": "...", "budget": "...", "power": "wall", "on_hand": ["breadboard"] },
            "repo": null },
  "parts": [
    { "id": "esp", "library": "esp32-devkit-v1", "position": [-120, 0, -100], "rotation": [0, 0, 0],
      "qty": 1, "params": {}, "pins": { "GPIO21": { "label": "D21" } },   // overrides by pin name
      "verify": false, "inferred": false, "have": false,
      "bom": { "why": "...", "price": 8.5, "currency": "USD", "link": "...", "checked": "2026-11-20",
               "options": [{ "tier": "budget", "name": "...", "why": "..." }] } }
  ],
  "wires": [
    { "id": "w5", "from": "esp.GPIO21", "to": "pca.SDA", "color": "blue", "gauge": 26,
      "length_mm": 150, "label": "I2C data", "purpose": "ESP32 tells the PCA9685 ...",
      "insulation": "pvc" }
  ],
  "breadboard": { "model": "full-830", "rails": { "top+": "VMOT", "bottom+": "5V" }, "jumpers": "male-male", "layout": { /* generated */ } },
  "printer": { "profile": "bambu-a1-mini", "nozzle": "single", "material": "PLA" },
  "cad": { "tool": "build123d" },
  "prints": [ { "id": "base", "name": "Base plate", "source": "cad/base.py", "files": ["prints/base/base.stl"],
                "material": "PLA", "status": "designed", "size": [170, 6, 120],
                "settings": { "infill": 20, "supports": false, "orientation": "flat", "layer": 0.2 },
                "pieces": [], "position": [0, 0, 0], "explode": [0, -40, 0] } ],
  "fasteners": [ { "id": "m3x8", "name": "M3x8 socket head screw", "qty": 8 } ],
  "steps": [
    { "id": "s9", "phase": "wire", "title": "Connect the I2C bus", "text": "...", "why": "...",
      "parts": ["esp", "pca"], "wires": ["w5", "w6"], "prints": [], "fasteners": [],
      "warnings": ["Unplug USB before moving any wire"], "tools": ["2 jumpers"], "done": false }
  ]
}
```

Part `bb: { "pin1": "e8", "rot": 0 }` pins a breadboard placement (the layout
engine honours and validates it); `bb: { "offboard": true }` keeps a part off
the board. `breadboard.layout` is generated by `wiremap layout-breadboard --write`.

Part `id`s must not contain dots. A part either references `library` or gives
the full definition inline (same fields as a library part).

### Mechanics (`mechanics`, optional)

Checked by `lib/mech.js` as part of `wiremap check`. Every section is
optional; lengths in mm, masses in g, torque in N·m (servo kg·cm in data is
converted). Actuator data comes from the library part's `mechanical` block
(`kind`: positional | continuous | gearmotor | stepper, `mass_g`,
`torque: [{ v, stall_nm }]`, `deadband_deg`, `no_load_rpm`); a project part can
override it with its own `mechanical`.

```jsonc
"mechanics": {
  "material": "PLA", "safety_factor": 2,
  "arm": {
    "payload_g": 10, "accel_rad_s2": 3, "supply_v": 5,
    "joints": [                                  // base to tip
      { "id": "base", "part": "servo-base", "type": "yaw", "link_mm": 45, "bearing": false },
      { "id": "shoulder", "part": "servo-shoulder", "type": "pitch", "link_mm": 80, "link_mass_g": 12, "range": [-55, 65] },
      { "id": "elbow", "part": "servo-elbow", "type": "pitch", "link_mm": 80, "link_mass_g": 10 },
      { "id": "gripper", "part": "servo-gripper", "type": "gripper", "link_mm": 45, "link_mass_g": 15 }
    ],                                           // range defaults to preview.joints for the same part
    "gripper": { "jaw_mm": 30, "friction": 0.4 },
    "targets": [{ "name": "pick spot", "x": 170, "y": 0, "z": 20 }]
  },
  "fits": [
    { "id": "pivot hole", "nominal": 3, "fit": "sliding", "feature": "hole", "designed": 3.4 },   // printed, uses printer.clearance_mm
    { "id": "bearing bore", "nominal": 22, "iso": "J7/h6", "process": "reamed", "want": "transition" }
  ],
  "stackups": [{ "id": "lid gap", "dims": [{ "name": "box", "nominal": 40, "tol": 0.15 }, { "name": "board", "nominal": 38, "tol": 0.1, "sign": -1 }], "min_gap": 0.5 }],
  "bolts": [{ "id": "motor mount", "size": "M3", "class": "8.8", "count": 2, "load_n": 40, "mode": "shear", "plate_mm": 3 }],
  "beams": [{ "id": "upper arm", "from_joint": "shoulder", "length_mm": 80, "section": { "type": "rect", "w": 18, "h": 6 }, "layer": "xy", "fill": 0.6, "max_deflection_mm": 1 }],
  "gears": [{ "id": "base gear", "module": 1, "z1": 15, "z2": 45, "torque_nm": 0.2, "face_mm": 6 }],
  "rover": { "mass_g": 600, "wheel_d_mm": 65, "driven_wheels": 2, "wheels": 3, "slope_deg": 10, "motor": "motor-left", "supply_v": 5, "gear_ratio": 1 },
  "drone": { "auw_g": 650, "motors": 4, "thrust_g": 600, "current_a": 18, "frame_mm": 220, "prop_in": 5, "battery": { "mah": 1500, "c": 75 }, "esc_a": 30 }
}
```

More sections:

```jsonc
"arm": { "base": { "mass_g": 200, "footprint_mm": 60, "clamped": false } },       // tip-over check
"rover": { "cg_height_mm": 35, "track_mm": 130 },                                  // static stability
"rc": { "mass_g": 1500, "wheelbase_mm": 260, "track_mm": 190, "wheel_d_mm": 70, "cg_height_mm": 45,
        "front_fraction": 0.45, "top_speed_m_s": 8,
        "steering": { "servo": "steer", "horn_mm": 15, "arm_mm": 15, "tire_width_mm": 30, "scrub_mm": 8, "friction": 0.8, "max_steer_deg": 30 },
        "drive": { "kv": 3300, "cells": 2, "gear_ratio": 9 } },
"drone": { "motor_parts": ["m1", "m2", "m3", "m4"] },                                // CG from part positions and mass_g
"assembly": { "allow_overlap": [["deck", "esp"]], "rests_on": { "esp": "deck" }, "tolerance_mm": 0.2 }
```

Parts may set `mass_g`. `fasteners[]` may set `position`, `axis` and `through`
for the screwdriver-access check. Print files are checked by `wiremap
cad-check` (lib/dfm.js): size against `prints[].size`, watertight mesh,
overhangs past 45° in the print orientation, bed contact, tall thin parts and
mass from volume. More rules: `mech-tipping`, `mech-cg`, `mech-steering`,
`mech-rc-drive`, `mech-interference`, `mech-access`, `mech-assembly-order`,
`dfm-size`, `dfm-mesh`, `dfm-overhang`, `dfm-bed`, `dfm-tall`.

`prints[].min_wall_mm` is checked against the nozzle; `prints[].near_heat: true`
warns for low-temperature plastics. Rules: `mech-joint-torque`,
`mech-continuous-servo`, `mech-yaw-bearing`, `mech-reach`, `mech-singularity`,
`mech-accuracy`, `mech-grip`, `mech-printed-fit`, `mech-fit-process`,
`mech-fit-type`, `mech-stackup`, `mech-bolt`, `mech-beam`, `mech-deflection`,
`mech-gear`, `mech-rover`, `mech-drone`, `mech-wall`, `mech-heat`.

## Library API (`lib/`)

- `lib/model.js`: `resolveProject(project, library)` → `{ parts: Map, partList, wires, problems }`.
- `lib/nets.js`: `buildNets(model)` → `{ nets, netOfPin, edges, adj, pinOf }`; `netRole`, `ROLE_COLORS`.
- `lib/check.js`: `checkProject(project, library)` →
  `{ ok, errors, warnings, infos, issues: [{ id, rule, level: 'error'|'warning'|'info', message, fix?, parts[], wires[], pins[], nets[] }],
     model, nets, power: { rails: [...] }, wireInfo: { [wireId]: { role, color, net, current, voltage } }, notChecked: [...] }`.
- `lib/calc.js`: deterministic calculators (see SKILL.md).
- `lib/mech.js`: `checkMechanics(project, library, { printers })`, `isoFit`, `stackup`, `bolt`, `beam`, `gear`, `armAnalysis`, `forwardKinematics`, `inverseKinematics`, `manipulability`, `drone`, `rover`.
- `lib/apps.js`: apps the overlay follows, window-title parsing, slicer preset parsing.
- `lib/breadboard.js`: `layoutBreadboard(project, library, options)`.
- `lib/printer.js`: `fitPart(size, printerProfile, opts)`.
- Node helpers: `lib/node/library.js` (`loadLibrary(dir)`), `lib/node/stl.js`.
