# CivSwitch ↔ ns2jb bridge — deployment & testing (Workstream A)

`payload.js` implements the ns2jb wire protocol (BRIDGE-CONTRACT.md §2) on top of
the CivSwitch loader's JS primitives (§1). It replaces the SmileBASIC console-side
loop (`ns2jb-main/bootstrap.bas`, `RPC()`) with a JavaScript equivalent running
inside the Civ 7 process.

## Files

| File | Role |
|---|---|
| `bridge/payload.js` | Console-side payload. Eval'd by the CivSwitch loader; connects out to the PC, sends HELLO, runs the RPC loop. |
| `bridge/test_bridge.py` | PC-side standalone test harness (stdlib only). Listens, parses HELLO, runs query / malloc-free / memset+memcpy / terminate checks. |

## Prerequisites

- Switch 2, fw 23.0.1, running **Civ 7** with the **CivSwitch loader listening on TCP :9026**.
- PC and console on the same LAN.
- Console knows the PC's IPv4 — set it in the `CONFIG` block at the top of
  `bridge/payload.js` (`PC_IP`, default `PC_PORT` 39380).

## Deploy & run

1. On the PC, start the test harness first (it listens):

   ```
   python bridge/test_bridge.py --port 39380
   ```

2. Send the bridge payload to the loader (send_payload.py is in the workspace root):

   ```
   python send_js.py <CONSOLE_IP> 9026 bridge/payload.js
   ```

   Progress lines (`scratch = ...`, `svcQueryMemory wrapper = ...`, `connected to PC`,
   `HELLO sent; entering RPC loop`) stream back over the loader connection and are
   printed by `send_payload.py`.

3. The harness prints the 16 HELLO fields and PASS/FAIL per test step, then sends
   the zero termination packet. The bridge logs `termination record received` and
   exits cleanly.

### Order matters

The harness must be listening **before** the payload is sent — the bridge makes a
single outbound connect attempt and aborts (logging `FATAL: connect() failed`)
if the PC is not listening. If that happens, just start the harness and re-send
the payload; the failed eval leaves nothing resident.

## Behavioural notes

- **The bridge occupies the loader for its entire lifetime.** It is one long-running
  eval; while it runs, that loader session is busy. `log()` output during the run
  still streams to the loader's client connection (the `send_payload.py` socket).
- **RPC areas**: requests are recv'd straight into `scratch+0x40000` (0x8080 bytes),
  responses are sent from `scratch+0x4030` (0x8010 bytes). HELLO/sockaddr/query
  buffers live in a separate small malloc so scratch stays pristine.
- **Termination**: a request whose record A has its first 20 bytes all zero ends
  the loop; the bridge closes the socket and frees its allocations.
- **Safety**: the bridge only touches memory it allocated, regions returned by
  `svcQueryMemory`, and addresses supplied by the PC engine in RPC records. There
  are no blind reads — an unmapped access on this target is a hardware fault and
  would crash the game process. A *JS-level* error inside a `call_rop` invocation
  is logged and the loop continues; a dead socket ends the loop cleanly.
- **Defensive no-op handling**: the stock engine always pads single-call exchanges
  with a `memmove(out,out,0,0)` record B. If a peer ever sends a record with
  `fn == 0` that is *not* the termination packet, the bridge skips it (with a
  one-time warning) instead of jumping to address 0.

## HELLO field status (Civ7 values)

| Field | Source in payload.js |
|---|---|
| `scratch`, `scratchBytes` | `malloc(0x80000)` at runtime (or `CONFIG.SCRATCH`) |
| `main`, `sdk` | Resolved at runtime via `svcQueryMemory` on the `main_base` / `sdk_base` anchors. |
| `memmove` | `sdk + 0x522830` by default; `CONFIG.MEMMOVE` can override the absolute address. |
| `sdkCrc32` | `157086863` (`0x095CF48F`), the zlib CRC-32 of the 0x602000-byte SDK text dump. |
| `got`, `backing`, `controller` | Zero. These SmileBASIC fields are unused by the Civ7 engine target. |

The Civ7 engine configuration accepts these values; the stock SmileBASIC engine in
`ns2jb-main/` intentionally still rejects them.

## Test harness CLI

```
python bridge/test_bridge.py [--host 0.0.0.0] [--port 39380] [--timeout 120]
    [--querymem-addr 0x...]   # default: HELLO.sdk + 0x168B0C
    [--memcpy-addr 0x...]     # default: HELLO.sdk + 0x5224E0
    [--memset-addr 0x...]     # default: HELLO.sdk + 0x522AF0
    [--malloc-addr 0x...]     # optional, enables the alloc/free step
    [--free-addr 0x...]       # optional, enables the alloc/free step
```

Only the optional malloc/free step prints `[SKIP]` when its flags are absent.
Exit code is 0 only when no check failed. The offline bridge emulator can be run
without a console:

```
node --test port/test_civ_bridge.cjs
```
