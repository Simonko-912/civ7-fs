# ns2jb → CivSwitch port: FS-acquisition research findings

This directory documents porting the **ns2jb** FS-process takeover (a reserved-gap
allocator race in the Switch 2 `fs` sysmodule) onto the **CivSwitch** Civilization VII
chat-XSS Remote JS Loader, so the whole chain runs from inside the Civ 7 cartridge
userland instead of from SmileBASIC.

All work here is on the author's own console and is published for research/documentation
purposes. Network addresses, hostnames and local paths have been replaced with
placeholders (`<PC_IP>`, `<CONSOLE_IP>`, etc.).

---

## 1. Architecture

```
CivSwitch loader (Civ 7, Cohtml/Coherent Gameface 1.59, TCP :9026)
      │  payload.js  (eval'd in the loader; 128-byte HELLO + RPC loop)
      │  connects OUT to the PC engine on TCP :39380
      ▼
PC engine (Node, port/engine/*)  — drives the exploit over RPC
      │  raw-svc worker threads (svcCreateThread bypass) on the console
      ▼
Switch 2 fs process — reserved-gap race → canary overwrite → cache leak → FS primitive
```

- **Loader / transport:** CivSwitch's Remote JS Loader on `:9026`. Payloads are pushed
  with `send_payload.py <CONSOLE_IP> 9026 <file.js>`.
- **Bridge:** `port/payload.js` is eval'd inside the loader, opens an outbound socket
  to the PC engine, and serves a small RPC protocol (see `BRIDGE-CONTRACT.md`).
- **Engine:** `port/engine/` is the PC-side driver. `node engine/run.cjs <PC_IP>` from
  `port/` listens on `:39380` and runs the staged pipeline against the console.
- **Exploit core:** `port/engine/switch2/memory/probe-reserved-gap.cjs` implements the
  reserved-gap race (commit / hole / canary / pin / trigger roles, the "wave" model).

The upstream primitives this builds on are credited to the CivSwitch and ns2jb projects;
this port is the glue + the Civ 7 BC-save-specific retune below.

---

## 2. The problem, and the changes we made

The ns2jb race was developed against SmileBASIC's native save. Civ 7 runs as a
**backward-compatible (BC) cartridge**, and its FS session has materially different
geometry and timing. Nearly every stage needed a Civ-7-specific adaptation. All
Civ-specific knobs are per-target constants in `engine/shared/target.civ7.json`; the
SmileBASIC defaults are preserved when a knob is absent.

### 2.1 Worker threads: raw `svcCreateThread` bypass
Every normal thread-creation route inside Civ failed (`nn::os::CreateThread` hangs,
`pthread_create` silently no-ops, JS `Worker` absent). The fix is to skip `nn::os`
and call the raw `svcCreateThread` kernel wrapper found in the nnSdk dump:

- Raw `svcCreateThread` returns synchronously — the hang was `nn::os` bookkeeping, not
  the kernel.
- **Priority is borrowed from a live game thread** via the `nn::os` manager list (the
  kernel value is authoritative; the in-struct priority field was not where the
  reference expected). Observed kernel priorities 43/44/59/28; core masks read via
  `svcGetThreadCoreMask` on the real handle.
- **Safety fix:** svc `#0x07` is `svcExitProcess` (kills the game), **not** ExitThread.
  The correct `svcExitThread` is svc `#0x0A`. The gadget table in
  `port/APP-OFFSETS-REPORT.md` is corrected.
- Raw-thread lifecycle validated with a 30-cycle create/join stress probe (30/30), and
  TPIDRRO_EL0 on raw threads is nonzero, so the IPC path is viable.

### 2.2 Raw-mode stack placement
A deterministic wave-2 crash was a layout overlap: a late worker's stack sat inside
worker 0's snapshot arena, and the launch-time stack memset corrupted the snapshot.
Raw stacks were moved clear of the snapshot/output/writeData arenas. (The reference
never hit this because pthread stacks come from the musl allocator.)

### 2.3 BC-save write-size cap
The Civ 7 BC mount has an outstanding-dirty limit of ~8–12 MiB. A single 16 MiB "dirty"
IFile Write fails and **poisons the FS session until reboot** (flush does not release;
deletes do). Bounded probing (`app/probe-write-size.cjs`): 8 MiB succeeds, 12 MiB fails.
The acquisition `writeSize` is halved to `0x800000` (8 MiB). A two-Write flush-split does
not help — the cap is per outstanding-dirty, not per Write.

### 2.4 Race retune for the BC save
Measured race model from wave timings: the canary IPC returns when the fs `Commit`
finishes; the pin (`OpenStorage`) returns when the hole `Read` finishes. The in-window
control needs `pin.end < canary.end`, i.e. `commit_duration > hole_read_duration + margin`.
Working configuration: `writeSize = 0x800000` (8 MiB commit), `probeReadSize = 0x10000`
(64 KiB hole read). This yields a ~20%-per-wave in-window hit rate on a healthy save.

### 2.5 Pinning allocation cost
Pinning storage costs **6960 bytes** on the Civ 7 BC fs (reference: 13616). Now a
per-target constant `pinningAllocationBytes`.

### 2.6 Trigger-path shape: the `fs 2-6006` rejection
The positive trigger path used a single unbroken ~9020-byte filler component. That is far
past the 255-char path-component maximum; SmileBASIC tolerated it, but the BC save rejects
it with **fs 2-6006** *before* the gap-alias can touch the canary (hence `changedPaths: []`
on every positive wave). Fix: `NS2_POSITIVE_FILL_SEGMENT=<n>` drops a `/` every `n+1`
filler bytes so each component is `<= n` chars, leaving the marker offset, aliased target,
`/..\` prefix, extent and 5-piece split unchanged. With `=63` the parser walks far enough
for the alias to land. (Note: a winning wave still *returns* fs 2-6006 on the GetEntry
trigger — the win is the gap-alias side effect flipping the canary, not the trigger's own
return code.)

### 2.7 Pin-window retry hardening
The first wave (`abort-control`) also creates the pinning storage, and its window/cost
check was a hard throw with no retry — so pure per-boot timing variance aborted the whole
run before any positive wave. The check is now row flags (`pinWindowOk`, `pinCostOk`) with
a `retryWave`-style loop that releases the just-created pin and re-rolls up to the attempt
budget. `report.pinRetries` records the count.

### 2.8 Leak-phase heap-jitter tolerance
The BC save shows ±192-byte benign heap jitter (same magnitude as the pin-cost jitter).
A strict `restored === baseline` equality check in the leak phase tripped on a −192 drift
and bailed. New per-target `heapJitterBytes` (= 192) makes the restoration check
`abs(after + pin − before) <= heapJitterBytes`; content-prefix integrity checks stay
strict. Absent → 0, so SmileBASIC stays strict.

### 2.9 Leak-sweep shortening (`fieldCopies`)
The combined-leak install is 7 `copyField` steps, each requiring `fieldCopies` confirmed
race-window hits — the dominant wave-count multiplier. `fieldCopies` is confidence
redundancy, not correctness (every retry writes the identical prefix; only an accepted
window commits; native readback is the proof), so it is a per-target constant
(`fieldCopies: 1`, ~halving the leak-phase wave count). Absent → 2.

---

## 3. Current status

The chain runs **end-to-end** through the hardest stages:

- raw-svc worker wave: hardware-qualified (create/start/affinity/join/close clean).
- pin gate: passes (with retry).
- **overwrite primitive lands** — canary flips (`changedPaths:['canary']`,
  `canaryType 0`, `markerSelected` + `markerReproduced` true) at ~20% per wave on a
  healthy save.
- combined-leak install completes (7 steps, `fieldCopies=1`, ~2 waves/step) and the run
  advances into the `cache-address-alias-offset-*` phase. Deepest run reached ~101 cases
  in a single probe.

All deterministic logic blockers (pin window, overwrite shape, leak heap-guard, wave
count) are cleared.

### Win-rate vs save health (evidence)
The overwrite win-rate is exquisitely sensitive to the **throwaway save's FS geometry**,
which a reboot does *not* reset:

| run condition            | positive waves | canary-flip wins |
|--------------------------|---------------:|-----------------:|
| fresh save               | 10             | 2 (20%)          |
| fresh save               |  9             | 2 (22%)          |
| save after prior runs    | 21             | 0                |
| save after prior runs    | 60             | 0                |
| **pristine recreated**   |  3 / 28        | **1 / 2 (wins return)** |

Confirmed: a single incomplete/wedged run degrades the save enough to zero the overwrite
rate. **Rule adopted: recreate the throwaway save after any run that does not complete
cleanly.** Save-health signal: a win within the first ~10 positive waves.

---

## 4. Open frontier

1. **Sporadic console wedge mid-sweep.** Deep in the full leak sweep (~130–160 waves in a
   single non-resuming probe) the console stops responding abruptly — flat per-wave time,
   flat heap counter, no in-probe error. It is not gradual exhaustion; it looks like a
   sporadic app fault under the extended sequence. Next lever: capture the exact
   wave/IPC at cutoff.
2. **Per-boot wave budget.** A full acquisition needs more waves than a typical boot
   survives. The extent-requalification gates are the largest avoidable cost
   (per-probe extent-selection rate varies 2–27% with pin placement). Trimming the
   address-header/range/fragmentation `copyField` steps is the main remaining shortening
   lever.
3. **Worker-join reliability.** Occasional `0xEA01` (kernel wait-sync timeout) on a
   raw-svc worker join on degraded boots — tracks with save/console health rather than
   logic.

---

## 5. Layout

- `BRIDGE-CONTRACT.md` — the loader↔engine bridge protocol.
- `PORT-HANDOFF.md` — runbook (addresses redacted).
- `port/APP-OFFSETS-REPORT.md`, `port/CORE-OFFSETS-REPORT.md`,
  `port/MOUNT-OFFSETS-REPORT.md`, `port/RESIDUAL-OFFSETS-REPORT.md` — offset tables + runtime results.
- `port/PORT-FS-REQUIREMENTS.md`, `port/PORT-APP-LAYER.md` — requirements/design.
- `port/payload.js` — the in-loader bridge.
- `port/engine/` — the PC-side driver (minus per-run logs).
- `port/engine/switch2/memory/probe-reserved-gap.cjs` — the reserved-gap race.
- `port/probes/`, `port/tools/` — hardware probes and offline validators.

Not included: per-run logs, raw console-memory dumps, and firmware-derived analysis
indexes.
