# `port/` layout and documents

Start at [`../README.md`](../README.md) for what the port is and how to run it.

## Operational documents (paths are current)

| File | What |
|---|---|
| [`../README.md`](../README.md) | What this repository is, quick start for both halves |
| [`PORT.md`](PORT.md) | The FS engine in detail: status, run steps, layout, safety, MCP |
| [`README-ENGINE.md`](README-ENGINE.md) | Engine behaviour, target profile fields, stage semantics |
| [`README-BRIDGE.md`](README-BRIDGE.md) | Wire protocol and bridge deployment/testing |
| [`BRIDGE-CONTRACT.md`](BRIDGE-CONTRACT.md) | Authoritative primitive + wire-protocol contract |
| [`../probes/README.md`](../probes/README.md) | Read-only bring-up probes and their boundaries |
| [`../tools/analysis/README.md`](../tools/analysis/README.md) | How the offset tables were derived (archival scripts) |

## Archival records

These were written against the kit's original flat layout and are kept as
evidence, not as instructions. They use the old paths; the table below maps
them onto this tree.

| File | What |
|---|---|
| [`FINDINGS.md`](FINDINGS.md) | Hardware findings while porting (sockets, dumps, crash lessons) |
| [`PORT-HANDOFF.md`](PORT-HANDOFF.md) | Original port handoff: what was done, what was blocked |
| [`CHANGES-kit.md`](CHANGES-kit.md) | The eight Civ7/Windows patches + two upstream merges |
| [`UPSTREAM-SYNC-2026-11-10.md`](UPSTREAM-SYNC-2026-11-10.md) | What was taken from upstream ns2jb |
| [`RUNBOOK-P4.md`](RUNBOOK-P4.md) | The kit's Windows one-shot cycle (superseded by `node ../engine/run.cjs CONSOLE-IP`) |
| [`SAVE-BACKUP.md`](SAVE-BACKUP.md) | Save backup/restore with the kit's `save-tools/` (not shipped here) |
| [`flowchart.mmd`](flowchart.mmd), [`flowchart.png`](flowchart.png) | Chain diagram |
| [`reports/`](reports/) | Offset evidence: `OFFSETS-REPORT.md` (index), `CORE-`, `APP-`, `MOUNT-`, `RESIDUAL-OFFSETS-REPORT.md`, `PORT-APP-LAYER.md`, `PORT-FS-REQUIREMENTS.md` |

## Old path → current path

| Referenced in archival docs as | Actually here |
|---|---|
| `port/payload.js` | [`../bridge/payload.js`](../bridge/payload.js) |
| `port/test_bridge.py`, `port/test_civ_bridge.cjs` | [`../bridge/`](../bridge/) |
| `port/sdk-functions.civ7.json` | [`../targets/civ7/sdk-functions.json`](../targets/civ7/sdk-functions.json) |
| `port/sdk-layout.civ7.json` | [`../targets/civ7/sdk-layout.json`](../targets/civ7/sdk-layout.json) |
| `port/civ7-app/*.json` | [`../targets/civ7/app/`](../targets/civ7/app/) |
| `port/engine/shared/target.civ7.json` | [`../targets/civ7/target.json`](../targets/civ7/target.json) |
| `port/engine/shared/target.smilebasic.json` | [`../targets/smilebasic/target.json`](../targets/smilebasic/target.json) |
| `port/engine/shared/sdk-*.json`, `port/engine/switch2/app/*.json` | [`../targets/smilebasic/`](../targets/smilebasic/) |
| `port/OFFSETS-REPORT.md`, `port/APP-OFFSETS-REPORT.md`, … | [`reports/`](reports/) |
| `port/validate_offsets.py` | [`../tools/validate_offsets.py`](../tools/validate_offsets.py) |
| `send_payload.py`, `save-tools/send_js.py` | [`../../../send_js.py`](../../../send_js.py) |
| `set-pc-ip.ps1`, `run-p4-once.ps1` | the engine itself: `node ../../port/engine/run.cjs CONSOLE-IP` |
| `save-tools/`, `switch1/*.nro` | not shipped — the loader and its trigger come from `../../../installer-creator/` and `../../../PicoSwitch/` |

## Why the tree looks like this

* **`bridge/`** is the only console-side code: it runs inside the game and is
  pushed over the loader. Nothing else in `port/` is evaluated on the console.
* **`engine/`** is the PC side. One file per stage is deliberate: every stage is
  a separate process (`shared/stages.cjs` spawns `switch2/.../<name>.cjs`) that
  owns its own native handles and writes a report the next stage reads. Merging
  stages into one file would share a process across ownership boundaries that the
  cleanup and restore paths rely on being separate.
* **`targets/<name>/`** holds one profile plus all offset tables for that
  console target. A run copies them into its folder (`materializeTarget`), so a
  run is immutable and hashable while the sources stay the single copy.
* **`tools/`** is operational (loader compatibility, artifact validation,
  artifact regeneration); **`tools/analysis/`** is the archival research that
  produced the offsets.
