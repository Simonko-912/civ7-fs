# CivSwitch ↔ ns2jb Port — Shared Contract

Goal: run the ns2jb (kurumuz fork) PC engine against **Civ 7 via CivSwitch** instead of
SmileBASIC 4, so the fs-process exploit (stage 2+) runs from the Civ7 process.

- Workspace root: `C:\Users\mike\Documents\kimi\tasks\2026-11-01\18-11-15-7ce4f4b7`
- ns2jb reference source (DO NOT MODIFY, keep pristine): `ns2jb-main/`
- New port files go in `port/`
- Civ7 sdk module dump: `dump/` (files named by runtime base address, hex)

## 1. CivSwitch console-side primitives

Payloads are JS, eval'd inside the exploit loader's closure (TCP :9026), so every
function below is directly in scope. Console = Switch 2, fw 23.0.1.

| Primitive | Signature | Notes |
|---|---|---|
| `read64(addr)` / `write64(addr, v)` | BigInt addr/value | full-process arbitrary R/W |
| `read32/write32/read16/write16/read8/write8` | same | same |
| `call_rop(fn, a1..a6)` | fn = absolute BigInt address, args BigInt u64 | native call, returns x0 as BigInt. Args map to x0..x5 |
| `malloc(size)` / `free(addr)` | calloc-backed | |
| `read_buffer(addr, len)` → Uint8Array, `write_buffer(addr, bytes)` | slow (byte-wise) | |
| `write_string(addr, str)`, `read_null_terminated_string(addr)` | | |
| `log(msg)` | async; streams line to connected PC client + screen | |
| `sleep(ms)` | | |
| `socket/bind/listen/accept/connect/recv/send/close/setsockopt/getsockname` | thin wrappers, return signed-32 BigInt (-1n = error) | recv/send take (fd, bufAddr, len, flags) |
| `main_base`, `sdk_base` | BigInt anchors (NOT module bases) | |
| `get_backing_store(typedArray)` → addr | | |

### Anchor/module facts (verified on hardware)

- `sdk_base` is an anchor inside the sdk module, not its base. To get the sdk module
  text base at runtime:
  1. Scan `[sdk_base, sdk_base+0x5F0000)` 4-byte steps for word pair
     `0xF81F0FE1` then `0xD40000C1` → that's `svcQueryMemory` wrapper start (str x1,[sp,#-16]! ; svc #6).
  2. `call_rop(qmFunc, infoBuf, pageBuf, sdk_base)` → MemoryInfo at infoBuf:
     `+0x00 u64 base, +0x08 u64 size, +0x10 u32 type, +0x18 u32 perm`.
     `base` = sdk module text base.
- Socket function offsets relative to `sdk_base` (already wrapped in JS, listed for reference):
  Socket +0x14d4c0, Bind +0x14d3b0, Listen +0x14d440, Accept +0x14d390, Connect +0x14d3c0,
  GetSockName +0x14d410, SetSockOpt +0x14d460, Recv +0x14d310, Send +0x14d340, Close +0x14d510.
- `calloc` = main_base+0x515b50, `free` = main_base+0x515a60.
- `svcQueryMemory` wrapper was found at sdk-text-base +0x168B0C in the dumped session
  (same build → same module-relative offset every boot).
- **Module-relative offsets are stable across boots; all bases are ASLR'd per boot.**
- Offsets in CivSwitch `core.js` (e.g. socket funcs above) are valid for this exact
  Civ7 build; the sdk dump comes from the same console/build.

### sdk dump layout (dump/)

| File | Region | Size |
|---|---|---|
| `4e102a4000.bin` | sdk .text (R-X) | 0x602000 |
| `4e108a6000.bin` | sdk .rodata (R) | 0x4e7000 |
| `4e10d8d000.bin` | sdk .data R | 0x4b000 |
| `4e10dd8000.bin` | sdk .data RW — TRUNCATED, only first 0x10000 of 0x1e000 | 0x10000 |

Runtime base of .text in that session was 0x4e102a4000 → to convert file offset to
module-relative offset: `off = fileOffset` for .text; rodata file starts at module
offset 0x602000; .data R at 0xAE9000; RW at 0xB34000.

The rodata contains nnSdk assert strings with full mangled C++ names, e.g.
`_ZN2nn2fs11MountSdCardEPKc`, `_ZN2nn2fs6detail10MountTable...`. NOTE: a previous
attempt found NO code xrefs to those strings from .text (likely dead strings or
referenced via pointer tables) — do not rely on string xref alone; verify with
byte-pattern/prologue analysis. capstone 5.0.9 is installed in the managed python.

## 2. ns2jb wire protocol (console side must implement)

Source of truth: `ns2jb-main/engine/lib/native.cjs`, `engine/lib/connection.cjs`,
`bootstrap.bas`.

- PC listens on TCP (default 39380); **console connects out** to PC.
- On connect, console sends 128-byte HELLO = 16 × u64 LE:
  `[0]=0x31545344, [1]=1, [2]=2 (Switch 2), [3]=scratch, [4]=scratchBytes(0x80000),
   [5]=main, [6]=sdk, [7]=got, [8]=memmove, [9]=backing, [10]=controller,
   [11..14]=0, [15]=sdkCrc32`
- PC-side validation in `parseHello` hardcodes SmileBASIC: `got==main+0x9c92f0`,
  `memmove==sdk+0x5872f0`, `sdkCrc32==3925528160` — MUST be patched/parameterized
  for Civ7 (part of the port).
- RPC loop, serialized:
  1. Console receives exactly `0x8080` bytes. Recv directly into `scratch+0x40000`.
     - `[0x00]` record A: `u64 fnAddr, u64 a0, a1, a2, a3` (40 bytes)
     - `[0x28]` record B: same layout
     - `[0x80]` data payload ≤0x8000 bytes → already at `scratch+0x40080` by virtue of the recv
     - If record A's first 20 bytes are all zero → exit loop cleanly (engine shutdown)
  2. Execute record A then record B via native call (fn, 4 args → x0..x3).
  3. Console sends exactly `0x8010` bytes = `scratch[0x4030 .. 0x8040)`:
     - write resultB (u64) at `scratch+0x4030`, resultA at `scratch+0x4038`
       (i.e. response[0:8]=second call result, response[8:16]=first call result)
     - bytes [0x10..] = output area `scratch+0x4040`, 0x8000 bytes
- How the engine uses it (native.cjs):
  - `call(offset, ...args)` → fnAddr = sdk + offset
  - `callAddress(absAddr)` only after `verifyFunction(absAddr, expectedBytes)` passes
  - `read(addr,len)`: per ≤0x8000 chunk, `call(memcpy, output=scratch+0x4040, addr, count)`
  - `write(addr,bytes)`: payload staged via packet data, then `call(memmove, addr, scratch+0x40080, len)`
  - `query(addr)`: `call(svcQueryMemory, output, output+0x40, addr)`
- Offsets above (0x5872f0 memmove, 0x586fb0 memcpy, 0x158314 svcQueryMemory, etc.)
  are SMILEBASIC sdk offsets — Civ7 equivalents must be substituted via a port config.

## 3. Port layers (workstreams)

- **A. Console bridge** (`port/payload.js` + `port/test_bridge.py`):
  implements §2 over §1 primitives. HELLO fields from a CONFIG block at top.
- **B. Constants**: Civ7 equivalents for every offset the engine uses
  (`ns2jb-main/engine/shared/sdk-functions.json`, `sdk-layout.json`, plus every
  numeric offset passed to `.call(`/`exchange(`/`callAddress(` anywhere in `engine/`).
  Find each in `dump/`, emit `port/sdk-functions.civ7.json` (same schema) +
  `port/OFFSETS-REPORT.md`.
- **C. App-layer audit**: `engine/switch2/app/*`, `engine/lib/*`, `engine/shared/*` →
  `port/PORT-APP-LAYER.md`: every SmileBASIC-specific assumption, severity, required change.
- **D. fs-stage requirements**: `engine/switch2/{memory,retained,ro,process}/*` →
  `port/PORT-FS-REQUIREMENTS.md`: what the host app process must provide
  (save-FS free space, mount types, thread creation/affinity, timing windows,
  IPC buffer sizes/counts), hard requirement vs tunable.
