# ns2jb on CivSwitch — Stage-2 filesystem port

the repository root turns the CivSwitch **Remote JS Loader** (the `core.js` payload in this
repo) into the transport for **ns2jb Stage 2**: the engine races the `fs`
sysmodule from inside the Civ 7 process, forges cache entries, and obtains
arbitrary read/write on the console filesystem. From there a retained payload
and an RO payload are installed, and installed system programs can be dumped
(CodeFS `main.npdm` + `main`).

```
Civ7 chat XSS -> Remote JS Loader :9026 -> bridge/payload.js
   -> port/engine (PC) -> fs reserved-gap race -> FS arbitrary R/W
   -> retained endpoint -> RO payload -> firmware dump
```

Stage 1 (the SmileBASIC interpreter bug that ns2jb originally used) is not part
of this chain: `bridge/payload.js` speaks the same ns2jb wire protocol straight over
the loader's TCP connection.

## Status

| Item | State |
|---|---|
| Port layer source | `slapah/CivSwitch` `7d422e52`, plus the 8 Civ7/Windows fixes and 2 upstream ns2jb commits from the `IZCIVSwitch` kit (`docs/CHANGES-kit.md`) |
| Upstream hardware proof (same game build, different loader checkout) | full chain verified, then a 90/90 (222 MB) system-code dump |
| This tree | statically re-verified against **this repo's** `core.js`: `python3 tools/check_loader.py` (31/31) and the full offline test suite pass |
| This tree, on hardware | **not yet run** — requires the console, a throwaway save and an explicit go-ahead |

The Civ7 offsets and instruction bytes are per game build (Switch 1 physical
cart, v1.0.0) and independent of `core.js`. `core.js` supplies only the
primitives and the anchor chain, which `check_loader.py` verifies before use.

## Requirements

* Switch 2, firmware **23.0.1** (do not update).
* Civilization VII, Switch 1 **physical** cart, **1.0.0**, no update.
* Remote JS Loader reachable on TCP `:9026` (Pico bootstrap once, then the
  boot-persistent `XSTRIG.Civ7Save` trigger via `../installer-creator/install.py`).
* PC on the same LAN, wired on both ends; Node.js >= 20; Python 3.10+.
* A **throwaway** Civ7 save: the console saves can be mutated, and an interrupted
  run can leave FS state corrupted.

## Run

```sh
# one command: resolves this computer's address on the route to the console,
# waits on :39380, pushes bridge/payload.js to the loader, runs the chain,
# and leaves the verified native RPC held for an MCP client.
node engine/run.cjs 192.168.2.118

# bring-up only: bootstrap checks, memory map, mount inspection, one worker.
# Stops before save cleanup / FS acquisition. Nothing on the FS is mutated.
node engine/run.cjs 192.168.2.118 --app-only

# hold nothing: exit as soon as the chain verifies.
node engine/run.cjs 192.168.2.118 --no-hold

# also capture installed system-program code (read-only, ~222 MB).
node engine/run.cjs 192.168.2.118 --dump-firmware

# do not push the bridge (push it yourself with send_js.py).
node engine/run.cjs 192.168.2.118 --no-send
```

The engine owns the whole cycle, so there is no second script to run: it injects
this computer's address into `bridge/payload.js`, streams the console log
(every console-side line is prefixed `ReiAyanami:` and walks through five numbered
steps), and prints the run folder. On a held run it prints the MCP attach file
(`<run>/connection.json`).

The loader must be up before the run. Per-boot success is roughly 30%: on a
failure keep `runs/switch2-*`, power-cycle the console, Load Game,
and try again. Do not re-enter a failed stage on the same boot.

Progress is written per run under `runs/switch2-*`:

* `result.json` — `verified`, error, artifact and source hashes;
* `switch2/pipeline.json` — stage list;
* `switch2/fs-execution-current.json` — FS execution, restoration, cleanup;
* `dumps/` — `--dump-firmware` output (inventory + per-title files).
  A previous dump is **archived** as `dumps-<timestamp>` next to the folder, never
  deleted, so a repeat run cannot destroy a completed capture.

Manual alternative (any OS), if you prefer to drive the engine yourself:

```sh
node engine/run.cjs 192.168.2.118 --no-send   # listens on :39380
# in another terminal, after "Run folder:" appears, set PC_IP in
# bridge/payload.js to this computer's address and push it:
python3 send_js.py 192.168.2.118 9026 bridge/payload.js
```

## Held run and the device MCP

`--rpc` keeps the verified chain and the bridge alive instead of retiring them:

Holding is the default, so the one command above is all of it. The run prints its
folder; `engine/runs/switch2-*/connection.json` holds the loopback port and the
bearer token. Stop it with Ctrl-C — the runner then
restores FS state and closes the bridge.

That file is the handoff to the device MCP (`../mcp/`, a separate Node package):
start the server and call its `device_attach` tool with the absolute path of
`connection.json`. The MCP validates the token, checks `status.ready`, and then
uses `read`/`write`/`query`/`call`/`call-address`/`exchange`/`guard`/
`verify-function` on the same serialized bridge. `exchange` accepts at most
32 KiB of inline data and `guard` takes a permission bitmask (`r|w|x`); both are
served by the engine, so nothing is exposed beyond what `engine/rpc.cjs` already
offers. A timed-out native request must not be replayed.

## Safety

* The port never writes into a mounted NSO file and never writes the console
  filesystem except through the FS stages it explicitly reports. Each FS
  instruction change is restored and verified before cleanup.
* `--app-only` performs no FS mutation; use it first on any new console state.
* Interrupting acquisition can corrupt FS state: power-cycle afterwards.
* The bridge binds **loopback TCP** only, and every request must carry the
  32-byte bearer token from that run's `connection.json`; without it the request
  is refused with 403. Keep the run folder private anyway (it holds the token) and
  stop the run when done.

## Layout

| Path | What |
|---|---|
| `bridge/payload.js` | Console payload: ns2jb wire protocol over the loader (HELLO, RPC loop, 6-argument continuation) |
| `bridge/test_bridge.py`, `bridge/test_civ_bridge.cjs` | PC-side bridge harness and bridge unit tests |
| `engine/` | The runner and the chain: `run.cjs` is the one command (address, bridge push, hold); `rpc.cjs`, `dump-firmware.cjs`, `lib/` (bridge, connection, native, loader), `shared/`, and one process per stage under `switch2/` |
| `targets/civ7/` | Civ7 profile (`target.json`) plus every offset table it uses (`sdk-functions.json`, `sdk-layout.json`, `app/*.json`) |
| `targets/smilebasic/` | The same set for the original SmileBASIC transport |
| `probes/` | Read-only (one thread-creating) bring-up probes |
| `tools/` | Operational: `check_loader.py`, artifact validation/regeneration |
| `tools/analysis/` | Archived research that derived the offsets |
| `docs/` | Contract, engine/bridge references, findings, offset evidence — indexed in [`docs/README.md`](docs/README.md) |

## Before any run

```sh
python3 tools/check_loader.py                     # 31 checks, must pass
node --test engine/test.cjs engine/target.test.cjs bridge/test_civ_bridge.cjs \
     engine/switch2/retained/ engine/switch2/ro/layout.test.cjs \
     engine/switch2/memory/wave-overlap.test.cjs       # offline suite, must pass
```

## Provenance and licensing

the repository root is GPL-2.0 (see `LICENSE`, `NOTICE.md`): the engine derives from
`kurumuz/ns2jb` and the port layer from `slapah/CivSwitch`; the bridge contract
and artifacts come from the `IZCIVSwitch` kit. The rest of this repository
(`core.js`, `PicoSwitch/`, `installer-creator/`) stays under its original MIT
license. The two parts are aggregated, not merged: nothing in the repository root is
required to build or flash the loader, and the loader is not modified by it.
