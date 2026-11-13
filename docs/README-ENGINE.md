# Config-driven ns2jb engine

This directory is a copy of the pristine `ns2jb-main` engine with target-specific application behavior moved into `shared/target.*.json`. The reference tree is not modified. Both the Civ7 target and the original SmileBASIC mechanics use the same IPC, framing, session, acquisition, and cleanup code.

## Running

From `port/`:

```sh
node engine/run.cjs [--target civ7|smilebasic] [--app-only] [--rpc] [--dump-firmware] [computer-IP]
node engine/rpc.cjs RUN_FOLDER status
node engine/dump-firmware.cjs [--target civ7|smilebasic] [computer-IP]
```

Civ7 is the default. `NS2_TARGET=civ7` or `NS2_TARGET=smilebasic` can also select the target. Civ7 UX asks the operator to set `PC_IP`/`PC_PORT` in `payload.js` and launch the completed CivSwitch bridge (`bridge/payload.js`); the SmileBASIC target retains the original BASIC command flow.

Use `node engine/run.cjs --app-only <PC_IP>` for staged Civ7 bring-up. This runs the bootstrap checks, memory map, mount inspection, and one-worker app qualification, then exits. It stops **before** save-file cleanup, FS acquisition, RO, PM, and all FS mutation. `--app-only` cannot be combined with `--rpc` or `--dump-firmware`.

The runner preflights all required artifacts and safety gates **before listening on TCP**. It copies validated Civ7 artifacts into the per-run directory as `shared/sdk-functions.json`, `shared/sdk-layout.json`, and the seven `switch2/app/*.json` files. Child stages receive `NS2_TARGET` and `NS2_TARGET_ROOT`, so they use those immutable per-run copies rather than resolving files back into the source tree. Source and artifact hashes are recorded in `result.json`.

## Civ7 inputs

The following files are inputs supplied by the offsets workstreams; they are not generated or edited by the engine:

- `port/targets/civ7/target.json` — the profile itself
- `port/targets/civ7/sdk-functions.json`
- `port/targets/civ7/sdk-layout.json`
- `port/targets/civ7/app/thread-code.json`
- `port/targets/civ7/app/event-code.json`
- `port/targets/civ7/app/timing-code.json`
- `port/targets/civ7/app/hash-code.json`
- `port/targets/civ7/app/sdk-proxy-code.json`
- `port/targets/civ7/app/thread-scheduling-reference.json`
- `port/targets/civ7/app/compat-affinity-reference.json`

A run copies these nine files into its folder (`materializeTarget`); the profile
and tables above are the single source. `port/targets/smilebasic/` holds the
same set for the SmileBASIC target.

Loading fails with the missing path for absent or malformed JSON. Validation also rejects missing required function names, out-of-range text offsets, and absent/invalid instruction bytes. SDK data pointers such as the mount table and proxy global are validated as data offsets, not incorrectly limited to the executable mapping size.

`targets/civ7/target.json` names the transport entries `memcpy`, `memmove`, and `svcQueryMemory` in the SDK function table. The configured text size is `0x602000`. Native reads, writes, padding calls, heartbeats, memory queries, app RPC range checks, worker dynamic loads, worker snapshots/restarts, and the acquisition guard all use these entries.

## Civ7 runtime configuration

The profile is populated from static analysis and guarded hardware probes: session-manager layout `0x800`/`0x5C`/`3`, RomFS vtables `0xAEDB68`/`0xAEAC28`/`0xAEB9E8`, and host title `0100C3601518C000`. Save/mount/allocation probes passed. Re-run those probes after a game restart or build change rather than assuming live objects are unchanged. Multi-hour allocation stability and FS quiescence still require operational verification.

The whole-SDK CRC function/value, residual SVC wrappers, FS capture geometry, FS-process SM offset, and native RO donor identity are statically configured. `got`, `backing`, and `controller` are zero because Civ7 does not use those SmileBASIC HELLO fields. The console HELLO supplies the resolved memmove address and CRC `157086863`; the engine verifies the CRC over live SDK memory during qualification. Any future `null` required value remains an unsupported-configuration error, not permission to skip a check.

Changing the RO donor ID requires a matching rebuilt `ro/payload/manifest.json`, payload/policy hashes, and captured donor NPDM; configuration alone does not make a different payload valid.

## Behavior retained or replaced

- HELLO framing, address/precision/alignment checks, scratch size, platform version, memmove identity, SDK mapping, CRC, memory challenge, and scratch restoration remain enforced. GOT restoration is checked only for targets with a configured GOT relationship.
- Civ7 verifies the legacy 19.2 MHz SDK frequency, then measures the hardware counter over a one-second console sleep with a 10% tolerance. Race calculations use the exact 31.25 MHz hardware constant. No `nnCompatThin` module-size heuristic is used.
- Civ7 uses direct `nn::os::GetThreadCoreMask`/`SetThreadCoreMask` calls for owned workers, avoiding the external compatibility mask applied by pthread affinity. Available masks, instruction bytes, and readback after pinning remain enforced.
- Civ7 memory-map scans retry up to five times with a 250 ms delay and never publish a partial map. SmileBASIC retains one attempt.
- Civ7 worker join timeout is 30 seconds; SmileBASIC retains 15 seconds. Poll intervals and bridge heartbeat/idle timing are target settings.
- Civ7 keep-awake is explicitly disabled because no activity-report interface is configured. The verified memmove heartbeat remains active. SmileBASIC retains its instruction/controller/vtable-verified activity report.
- Civ7's `call4` metadata stores worker call targets at `table+0x80`; the original default remains `table+0x78`.
- RO launch, worker, PM identity, policy capture, and final app identity checks all use the configured program IDs.

## Civ7 direct worker lifecycle — experimental, no-go

The experimental `direct-nnos` profile allocates a zeroed page-aligned 0x1000-byte `ThreadType` and separate page-aligned 0x14000-byte stack outside each frame/snapshot. It calls default-core `CreateThread` at `0x136D50` with priority 20, then `StartThread` at `0x136DA0`. Completion polls `TryWaitThread`, verifies frame results, and calls `DestroyThread` at `0x136D80`; direct frames use exit continuation `0x13E094`. These static semantics are documented, but **direct `CreateThread` hung on two clean processes and is a confirmed no-go**. Do not use this lifecycle for FS stages.

`CreateThread` needs six arguments. The CivSwitch continuation record uses record A for the verified function and first four arguments, and record B with function value `0x2` for arguments five and six. `NativeClient.callAddress6`, the localhost bridge, and child-stage RPC preserve argument order and one-call accounting; other packets are unchanged. `probes/probe_call6_memcpy.js` verifies this transport on hardware. A bounded manager-list recovery was also tested: pthread returned zero with an unchanged result sentinel, but no matching worker was inserted. That route is a no-go as well, and `thread.mode = "no-go-worker-creation"` now blocks preflight.

## Offline tests

```sh
node --test engine/target.test.cjs
node --test engine/test.cjs
node --test engine/switch2/retained/*.test.cjs engine/switch2/ro/layout.test.cjs engine/switch2/memory/wave-overlap.test.cjs
```

The tests use host bytes, temporary files, and local TCP only. Do not use bare `node --test` from `engine/`: Node's discovery pattern also matches hardware entry scripts such as `switch2/ro/test-sm.cjs` and `test-gate.cjs`.

No engine test establishes hardware safety. Complete every gate, run the CivSwitch bridge wire test, and perform staged hardware bring-up only after the offset report and runtime save/mount probes are complete.
