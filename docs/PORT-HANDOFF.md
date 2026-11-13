# CivSwitch → ns2jb Port — Handoff Notes
**Date:** 2026-11-02 · **Status:** Static port complete; hardware bridge/probes pass; **raw-svc worker mode qualified — app-only pipeline PASSES (2026-11-02 home session)**

> **2026-11-02 PM update:** the worker blocker is solved. Raw `svcCreateThread` threads
> carry full worker frames on this Civ7 build (borrow priority 43 + a mask-valid core from
> a live manager-list node via `svcGetThreadPriority`/`svcGetThreadCoreMask`). The engine
> gained a `raw-svc` thread mode; `node engine/run.cjs --app-only` passes end to end and
> cleans up. See `FORHOME-STATUS.md` for the hardware evidence and the five bring-up fixes.
> Remaining: Stage 4 (13-worker wave → FS acquisition → save install), which still requires
> a throwaway save, fresh boot, and explicit operator go-ahead.

---

## 0. TL;DR

Goal: get real filesystem access on the Switch 2 by porting **ns2jb's stage-2 exploit**
(fs-process takeover) off its SmileBASIC transport onto **CivSwitch** (Civ 7 chat-XSS
exploit, already installed and boot-persistent on the console).

The console bridge and config-driven PC engine are implemented. All 60 emitted SDK
signatures validate against the dump, 41/41 offline tests pass, and the hardware bridge
passed HELLO/query/memcpy/memset/shutdown. Runtime probes confirmed `save` and `rom`,
sufficient save space, a 36 MiB allocation, RomFS vtables, and the session-manager layout.
See `port/OFFSETS-REPORT.md` for the consolidated result.

Current blocker: no safe native-worker path works on this Civ7 build. Direct
`nn::os::CreateThread` hangs before `StartThread`; `pthread_create` returns success but
does not insert a worker (the frame sentinel stays unchanged and no manager-list match exists).
Six-argument `call_rop` is hardware-verified. JavaScript `Worker` is undefined, so direct
CivSwitch acquisition cannot run the required 13 concurrent IPCs either. Further create attempts
are blocked at preflight; no save cleanup or FS acquisition has been attempted.

**Fallback that works TODAY:** ns2jb as-is in SmileBASIC 4.4.9 (owned by user).
Runbook in §8.2.

---

## 1. Environment

| Item | Value |
|---|---|
| Console | Switch 2, firmware **23.0.1** (do NOT update) |
| Console IP | <CONSOLE_IP> (CivSwitch loader listens on TCP **9026**) |
| PC IP (LAN) | <PC_IP> — use this for ns2jb (`node engine/run.cjs <PC_IP>` from `port/`) |
| PC also has | <TAILSCALE_IP> (Tailscale CGNAT) — always pass the LAN IP explicitly |
| PC Node | v24.21.0 ✓ (available through VSCodium with `ELECTRON_RUN_AS_NODE=1`) |
| Workspace | `C:\Users\mcortez\Desktop\civswitch-ns2jb-port` |
| Python | 3.15.2; standard-library offset/probe validators, local AArch64 decoder |
| Game | Civ 7 Switch-1 edition, physical cart v1.0.0, running in BC mode |

Network notes: ns2jb README demands **ethernet on both ends** (fs exploit is
timing-sensitive, ~20% success per fresh boot). PC runs Windows; the port uses the
OS temporary directory and Windows-compatible tests. Allow the Node runtime through
Windows Firewall (TCP 39380) on first run.

---

## 2. CivSwitch — what we have (verified on hardware)

Exploit: chat-XSS in Civ 7's embedded browser (**Cohtml/Coherent Gameface 1.59**,
V8 with pointer compression), URL `fs://game/core/ui/shell/root-shell.html`.
Boot-persistent via XSTRIG.Civ7Save trigger (Load Game → runs at boot, survives
sleep/wake). Loader: `send_js.py`-style TCP push on :9026; our copy is
`send_payload.py` (same wire behavior: send file, half-close, read logs till close).

**Primitives available to eval'd payloads (in closure scope):**
`read64/write64/read32/…/read8/write8` (full-process R/W, BigInt addrs),
`call_rop(fn, a1..a6)` (native AArch64 call via JOP chain, returns x0),
`malloc/free` (calloc-backed), `read_buffer/write_buffer/write_string`,
`socket/bind/listen/accept/connect/recv/send/close/setsockopt` (blocking, −1n on error),
`log()` (async, streams to PC client + screen), `sleep`, anchors `main_base`, `sdk_base`.

**Hard-won facts:**
- `sdk_base`/`main_base` are anchors, NOT module bases. Get the sdk module text base
  at runtime: scan `[sdk_base, +0x5F0000)` for word pair `F81F0FE1 D40000C1`
  (svcQueryMemory wrapper; nnSdk form uses `ldr x2,[sp]` + `add sp,sp,#0x10`,
  NOT libnx post-indexed form), then call it. MemoryInfo: +0 base, +8 size,
  +0x10 type, +0x18 perm.
- svcQueryMemory wrapper @ sdk-text **+0x168B0C** (stable across boots; ASLR moves only bases).
- Socket fn offsets (anchor-relative): Socket +0x14d4c0, Bind +0x14d3b0,
  Listen +0x14d440, Accept +0x14d390, Connect +0x14d3c0, GetSockName +0x14d410,
  SetSockOpt +0x14d460, Recv +0x14d310, Send +0x14d340, Close +0x14d510.
- calloc = main_base+0x515b50, free = main_base+0x515a60.
- Full address-space map was successfully dumped via svcQueryMemory walk
  (payload `recon4c.js`; modules have NO MOD0 magic at base on this build —
  identify modules from the map itself).
- Game JS bindings inventoried (`recon.js`/`recon2.js` output in transcript):
  Network.saveGame/loadGame/deleteGame, GameStateStorage.querySaveGameList,
  Database.query, WorldBuilderContext.save, Automation.loadJSON, etc.
  No direct FS API. **No fetch; sync XHR on fs:// hung the JS thread (crash) — dead end, do not retry.**
- **CRASH LESSONS:** (1) blind memory reads past mapped regions = instant process
  death (V8 can't catch a data abort) — always svcQueryMemory first;
  (2) empty TCP connects to :9026 count as "bad connections" (3 → listener rebuild);
  (3) when the game dies, relaunch → Load Game re-arms :9026.

**sdk dump (`dump/`)** — from a live session, module-relative offsets stable:
- `4e102a4000.bin` .text 0x602000 (file offset == module offset)
- `4e108a6000.bin` .rodata 0x4e7000 (module +0x602000)
- `4e10d8d000.bin` .data R 0x4b000 (module +0xAE9000)
- `4e10dd8000.bin` .data RW — **TRUNCATED** (0x10000 of 0x1e000; dump died at region end)
- .bss never dumped. rodata has full mangled nnSdk assert strings
  (`_ZN2nn2fs11MountSdCardEPKc` etc.) but **no code xrefs to them found** (dead strings
  or pointer-table referenced) — use byte-pattern/prologue analysis instead.

---

## 3. ns2jb — what it actually is (kurumuz fork, `ns2jb-main/`)

Two stages. Stage 1 (SmileBASIC 4.4.9 interp bug) is just a transport: memory R/W +
native calls in the app process, spoken over TCP to the PC engine. Stage 2 is the prize:
escalation into the **fs sysmodule process** (poisoned IStorage → arbitrary R/W over fs
address space via IStorage::Read/Write cmd 0/1 → owned fsp-srv root re-Initialized with a
chosen PID → BIS storage access → ro/pm native payload → firmware dump via NCM).
The fs bug lives in the firmware's fs process — app-agnostic in principle.

Wire protocol (details in `BRIDGE-CONTRACT.md` §2): console connects out to PC:39380,
128-byte HELLO (16×u64), then RPC loop: recv 0x8080 (two 5×u64 call records + ≤0x8000
data staged at scratch+0x40080), exec record A then B, send 0x8010 from scratch+0x4030
(resultB @+0x4030, resultA @+0x4038, output area @+0x4040). Terminate on 20 zero bytes
in record A. `native.cjs` hardcodes SmileBASIC sdk offsets: memcpy 0x586fb0,
memmove 0x5872f0, svcQueryMemory 0x158314, SDK_BYTES 0x5e1000.

---

## 4. Port status by workstream

### A. Console bridge — DONE, hardware-verified
`port/payload.js`, `port/test_bridge.py`, and `port/test_civ_bridge.cjs` implement and
verify HELLO, RPC calls, memory read/write, and clean shutdown. The hardware harness passed.
The bridge auto-resolves the SDK base, memmove `0x522830`, and text CRC `157086863`.

### B. Civ7 offsets/layout — DONE, static and runtime-probed
`port/sdk-functions.civ7.json`, `port/sdk-layout.civ7.json`, `port/civ7-app/*.json`, and
`port/OFFSETS-REPORT.md` are emitted. All 60 signatures match the dump and satisfy the
256-byte verification limit. Runtime probes populated RomFS vtables `0xAEDB68`,
`0xAEAC28`, `0xAEB9E8` and the `0x800`/`0x5C`/`3` session-manager layout.

### C. PC engine — IMPLEMENTED
`port/engine/` preserves `ns2jb-main/` and adds target profiles, artifact preflight,
Civ7 HELLO/CRC, transport offsets, direct affinity, measured timing, variant worker frames,
Windows support, and an `--app-only` stop before save cleanup/acquisition. See
`port/README-ENGINE.md`. Offline result: 41/41 tests and 94 JavaScript syntax checks pass.

### D. fs-stage requirements — DOCUMENTED; initial gates passed
- R11: save free space `0x3EA8000`, above the required `0x1410000`.
- R10/R12: `save` and `rom` are mounted; the RomFS storage chain has a valid borrowed session.
- R2: one 36 MiB type-5 RW allocation succeeded and was freed. Long-duration stability is untested.
- 13 crafted-stack threads, FS quiescence, and race timing remain unverified.
  Acquisition can corrupt FS state on interruption; use a throwaway save and fresh boot.

---

## 5. Next steps (in order)

1. Obtain runtime evidence of the direct create blocking PC/lock/SVC, or a working alternative
   worker implementation. Static analysis alone has not identified a safe correction.
2. Only after one worker passes create/start, frame results, direct affinity, destroy, and cleanup,
   rerun `node engine/run.cjs --app-only <PC_IP>` from `port/`. Do not bypass the no-go gate.
3. Recheck mount/save/allocation probes after any game restart and measure FS quiescence.
4. Only with a throwaway save, fresh boot, and explicit acquisition go-ahead, proceed through
   acquisition → fs-memory-control → retained/RO/process stages. Expect timing-sensitive retries.
5. Long-term: consider a negotiated fast RPC mode if fixed 64 KiB packets limit throughput.

## 6. Open questions / risks

- No worker qualification has passed: direct create hangs and pthread creates no list-visible worker.
- call_rop throughput is adequate for mapping and setup, but fs race windows may need retuning.
- Civ7's busy thread pool and FS activity may prevent quiescence (run from a static menu).
- The 36 MiB allocation passed once; multi-hour stability is not established.
- Truncated RW-data dump + missing bss were supplemented by guarded runtime reads, not assumed values.

## 7. File inventory

| Path | What |
|---|---|
| `BRIDGE-CONTRACT.md` | Authoritative spec: primitives + wire protocol + workstreams |
| `send_payload.py` | Push JS payload to console :9026, stream logs |
| `recv_dump.py` + `dump_sdk.js` | Memory-region dump over the loader (text+rodata pattern) |
| `recon*.js` | Hardware probes (4c = full memory map; 5 crashed on XHR — do not resend 5) |
| `dump/` | Civ7 sdk module dump (see §2) |
| `ns2jb-main/` | Supplied kurumuz/ns2jb source (DO NOT EDIT) |
| `port/payload.js` `test_bridge.py` `test_civ_bridge.cjs` | Bridge and offline/hardware tests |
| `port/engine/` | Config-driven PC engine and staged `--app-only` runner |
| `port/probes/` | Bounded mount/save-space/allocation probes |
| `port/OFFSETS-REPORT.md` | Consolidated offsets, validation, and hardware status |
| `port/PORT-APP-LAYER.md` `PORT-FS-REQUIREMENTS.md` | Original audits |
| `port/tools/` | Reproducible offset and probe validators |
| `PORT-HANDOFF.md` | This file |

## 8. Appendix — operational playbooks

### 8.1 Send a payload to CivSwitch
```
cd <workspace>
python send_payload.py <CONSOLE_IP> 9026 <file.js>
```
If connection refused → game crashed/closed → relaunch Civ 7 → Load Game → trigger save.

### 8.2 Run ns2jb as-is (works today, independent of the port)
Prereq: SmileBASIC 4.4.9 (owned), fw 23.0.1, ethernet both ends, game on internal
storage, 20 MiB free in SmileBASIC save.
1. Fresh-reboot console (mandatory).
2. In SmileBASIC "Make a Program": type `ns2jb-main/bootstrap.bas` (228 lines) into
   slot 0, save as `NS2`. (Demo variant: save via the PRGEDIT/SAVEV direct-mode line
   in ns2jb README.)
3. PC: `cd ns2jb-main && node run.cjs <PC_IP>`
4. SmileBASIC Direct mode, one line at a time:
   `LOAD "TXT:NS2"` → `RUN` → `REMOVE NSR,&H60000000,&H3FFFFFFF`
   ("Out of memory" is expected) → then the `V=START(...)` line the PC prints.
5. Wait for "FS execution verified". ~20% per fresh boot; on failure keep `runs/`,
   reboot, retry (up to 3 acquisition attempts built in).
6. Firmware dump variant: `node dump-firmware.cjs <PC_IP>`.
   Held RPC: `node run.cjs --rpc <PC_IP>`, then
   `node rpc.cjs runs/switch2-<RUNID> status`.
Warnings: don't keep personal files named `NS2_GAP*` in the SmileBASIC save (auto-
deleted); fully tethered — everything vanishes on reboot (also restores RO cleanly).

### 8.3 Civ7 bridge and app-only bring-up
1. From the workspace, run `python -u port/test_bridge.py --host <PC_IP>`.
2. In another terminal, run `python -u send_payload.py <CONSOLE_IP> 9026 port/payload.js`.
3. For the bounded probes, send `port/probes/probe_mount_list.js`,
   `probe_save_free_space.js`, and `probe_allocation_36m.js` one at a time.
4. App-only engine: `cd port && node engine/run.cjs --app-only <PC_IP>`, then send
   `port/payload.js` as above. On this PC, Node 24 is available through VSCodium with
   `ELECTRON_RUN_AS_NODE=1` in the environment.
5. App-only stops before save cleanup and FS acquisition. Keep the generated run folder on failure.

### 8.4 If the port stalls
The port only needs to reach parity with SmileBASIC's transport; every fs/ro stage
after acquisition is console-agnostic IPC. If Civ7 proves hostile (thread noise,
save FS too small), an alternative host is any other exploited app — the contract
(BRIDGE-CONTRACT.md §2) is the whole interface.
