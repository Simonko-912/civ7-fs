#!/usr/bin/env python3
"""PC-side standalone test harness for port/payload.js (stdlib only).

Listens on a TCP port, accepts the console's outbound connection, reads and
prints the 128-byte HELLO (relaxed validation: parse + display, warn only),
then exercises the bridge with the exact BRIDGE-CONTRACT.md §2 wire protocol:

  request  = 0x8080 bytes: record A @0x00 (5 x u64 LE: fn,a0,a1,a2,a3),
             record B @0x28 (same), data payload @0x80 (<=0x8000)
  response = 0x8010 bytes: resultB @0x00, resultA @0x08, output area @0x10
             (output area mirrors scratch+0x4040, 0x8000 bytes)

Test steps:
  (a) query   — call the svcQueryMemory wrapper on the console's sdk base and
                check the returned MemoryInfo base matches HELLO.sdk.
  (b) malloc/free roundtrip — only if --malloc-addr and --free-addr are given.
  (c) memset 64 bytes at scratch+0x1000, read them back with a memcpy call
      into the response output area (scratch+0x4040), verify content.
  (d) send the all-zero termination packet and expect a clean EOF.

Address mapping (see BRIDGE-CONTRACT.md §1):
  HELLO.sdk is the Civ7 sdk module *text base* (resolved at runtime by the
  bridge via svcQueryMemory). Module-relative offsets are stable across boots
  for a given build; only the base is ASLR'd. Known offsets for the build in
  dump/ (fw 23.0.1):
      svcQueryMemory wrapper = HELLO.sdk + 0x168B0C   (default for --querymem-addr)
      memcpy = HELLO.sdk + 0x5224E0                  (default for --memcpy-addr)
      memset = HELLO.sdk + 0x522AF0                  (default for --memset-addr)
  The CLI flags accept absolute addresses to override those build-specific defaults.
  SmileBASIC offsets from the stock engine (sdk+0x5872f0 memmove,
  sdk+0x586fb0 memcpy, sdk+0x158314 svcQueryMemory) do NOT apply to Civ7.

Example:
  python port/test_bridge.py --port 39380
"""

import argparse
import socket
import struct
import sys
import time

HELLO_BYTES = 128
REQUEST_BYTES = 0x8080
RESPONSE_BYTES = 0x8010
MAGIC = 0x31545344
SCRATCH_BYTES = 0x80000

INPUT_OFF = 0x40000          # request lands at scratch+0x40000 on the console
OUTPUT_OFF = 0x4040          # response output area mirrors scratch+0x4040
REC_A_OFF = 0x00
REC_B_OFF = 0x28             # 40 bytes per record

# sdk module-relative offset of the svcQueryMemory wrapper for the dump/ build
# (BRIDGE-CONTRACT.md §1; the bridge also re-derives it by pattern scan).
SVC_QUERY_MEMORY_OFF = 0x168B0C
MEMCPY_OFF = 0x5224E0
MEMSET_OFF = 0x522AF0

HELLO_NAMES = [
    "magic", "version", "platform", "scratch", "scratchBytes", "main", "sdk",
    "got", "memmove", "backing", "controller", "reserved11", "reserved12",
    "reserved13", "reserved14", "sdkCrc32",
]

failures = 0


def report(ok, label, detail=""):
    global failures
    if ok is None:
        print("[SKIP] %s%s" % (label, (" — " + detail) if detail else ""))
        return
    if not ok:
        failures += 1
    print("[%s] %s%s" % ("PASS" if ok else "FAIL", label,
                         (" — " + detail) if detail else ""))


def recv_exact(conn, n, what=""):
    buf = bytearray()
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("EOF while reading %s (%d/%d bytes)"
                                  % (what or "data", len(buf), n))
        buf += chunk
    return bytes(buf)


def parse_addr(s):
    return int(s, 0)


def make_record(fn, a0=0, a1=0, a2=0, a3=0):
    return struct.pack("<5Q", fn, a0, a1, a2, a3)


def exchange(conn, rec_a, rec_b, data=b""):
    """One full RPC round trip. Returns (resultA, resultB, output_bytes)."""
    if len(data) > 0x8000:
        raise ValueError("data payload too large")
    pkt = bytearray(REQUEST_BYTES)
    pkt[REC_A_OFF:REC_A_OFF + 40] = rec_a
    pkt[REC_B_OFF:REC_B_OFF + 40] = rec_b
    pkt[0x80:0x80 + len(data)] = data
    conn.sendall(pkt)
    resp = recv_exact(conn, RESPONSE_BYTES, "RPC response")
    result_b, result_a = struct.unpack_from("<QQ", resp, 0)
    return result_a, result_b, resp[16:]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="0.0.0.0", help="listen address (default 0.0.0.0)")
    ap.add_argument("--port", type=int, default=39380, help="listen port (default 39380)")
    ap.add_argument("--timeout", type=float, default=120.0,
                    help="per-operation socket timeout in seconds (default 120)")
    ap.add_argument("--querymem-addr", type=parse_addr, default=None,
                    help="absolute svcQueryMemory wrapper address "
                         "(default: HELLO.sdk + 0x%x)" % SVC_QUERY_MEMORY_OFF)
    ap.add_argument("--memcpy-addr", type=parse_addr, default=None,
                    help="absolute memcpy address (default: HELLO.sdk + 0x%x)" % MEMCPY_OFF)
    ap.add_argument("--memset-addr", type=parse_addr, default=None,
                    help="absolute memset address (default: HELLO.sdk + 0x%x)" % MEMSET_OFF)
    ap.add_argument("--malloc-addr", type=parse_addr, default=None,
                    help="absolute malloc/calloc address (optional, enables step b)")
    ap.add_argument("--free-addr", type=parse_addr, default=None,
                    help="absolute free address (optional, enables step b)")
    args = ap.parse_args()

    # ---- listen + accept -------------------------------------------------
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(1)
    print("[*] listening on %s:%d — start the bridge on the console now"
          % (args.host, args.port))
    conn, peer = srv.accept()
    srv.close()
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    conn.settimeout(args.timeout)
    print("[*] console connected from %s:%d" % peer)

    try:
        # ---- HELLO (relaxed validation: parse + print, warn only) --------
        raw = recv_exact(conn, HELLO_BYTES, "HELLO")
        words = list(struct.unpack("<16Q", raw))
        print("[*] HELLO (16 x u64 LE):")
        for name, w in zip(HELLO_NAMES, words):
            print("      %-12s = %#018x (%d)" % (name, w, w))
        hello = dict(zip(HELLO_NAMES, words))
        report(hello["magic"] == MAGIC, "HELLO magic",
               "expected %#x, got %#x" % (MAGIC, hello["magic"]))
        report(hello["version"] == 1 and hello["platform"] == 2,
               "HELLO version/platform",
               "version=%d platform=%d" % (hello["version"], hello["platform"]))
        report(hello["scratchBytes"] == SCRATCH_BYTES, "HELLO scratchBytes",
               "expected %#x, got %#x" % (SCRATCH_BYTES, hello["scratchBytes"]))
        if failures:
            print("[!] HELLO is not recognizable; aborting.")
            return 1
        scratch = hello["scratch"]
        sdk = hello["sdk"]
        out = scratch + OUTPUT_OFF

        qm = args.querymem_addr or (sdk + SVC_QUERY_MEMORY_OFF)
        args.memcpy_addr = args.memcpy_addr or (sdk + MEMCPY_OFF)
        args.memset_addr = args.memset_addr or (sdk + MEMSET_OFF)
        noop = make_record(args.memcpy_addr, out, out, 0, 0)

        # ---- (a) query the console's sdk base ---------------------------
        print("[*] (a) svcQueryMemory @ %#x on HELLO.sdk=%#x" % (qm, sdk))
        res_a, _res_b, output = exchange(
            conn, make_record(qm, out, out + 0x40, sdk, 0), noop)
        base, size, mtype, attr, perm = struct.unpack_from("<QQIII", output, 0)
        print("      result=%#x  MemoryInfo: base=%#x size=%#x type=%d attr=%#x perm=%#x"
              % (res_a, base, size, mtype, attr, perm))
        report(res_a == 0, "query: svcQueryMemory returned 0")
        report(base == sdk, "query: region base == HELLO.sdk",
               "base=%#x sdk=%#x" % (base, sdk))
        report(bool(perm & 4), "query: region is executable", "perm=%#x" % perm)

        # ---- (b) malloc/free roundtrip (optional) ------------------------
        if args.malloc_addr and args.free_addr:
            print("[*] (b) malloc/free roundtrip")
            ptr, _b, _o = exchange(conn, make_record(args.malloc_addr, 0x1000, 0, 0, 0), noop)
            report(ptr > 0x1000, "malloc(0x1000) returned a pointer", "ptr=%#x" % ptr)
            if ptr > 0x1000:
                r, _b, _o = exchange(conn, make_record(args.free_addr, ptr, 0, 0, 0), noop)
                report(True, "free(%#x) called without bridge error" % ptr,
                       "result=%#x" % r)
        else:
            report(None, "malloc/free roundtrip",
                   "pass --malloc-addr and --free-addr to enable")

        # ---- (c) memset + memcpy read-back --------------------------------
        if args.memset_addr and args.memcpy_addr:
            print("[*] (c) memset 64 bytes @ scratch+0x1000, read back via memcpy")
            target = scratch + 0x1000   # scratch area unused by the protocol
            pattern = 0xAB
            res_a, _b, _o = exchange(
                conn, make_record(args.memset_addr, target, pattern, 64, 0), noop)
            report(res_a == target, "memset returned dest",
                   "result=%#x expected %#x" % (res_a, target))
            res_a, _b, output = exchange(
                conn, make_record(args.memcpy_addr, out, target, 64, 0), noop)
            report(res_a == out, "memcpy returned dest",
                   "result=%#x expected %#x" % (res_a, out))
            got = output[:64]
            want = bytes([pattern]) * 64
            report(got == want, "read-back content matches",
                   "got %s" % (got.hex() if got != want else "64 x 0x%02x" % pattern))
        else:
            report(None, "memset/memcpy round-trip",
                   "pass --memset-addr and --memcpy-addr to enable")

        # ---- (d) zero-terminate ------------------------------------------
        print("[*] (d) sending all-zero termination packet")
        conn.sendall(bytes(REQUEST_BYTES))
        conn.settimeout(15)
        try:
            tail = conn.recv(1)
            report(tail == b"", "clean shutdown",
                   "console closed the connection" if tail == b""
                   else "unexpected byte after termination: %r" % tail)
        except socket.timeout:
            report(False, "clean shutdown", "console did not close within 15s")
    except (ConnectionError, socket.timeout, struct.error) as e:
        report(False, "harness run", "aborted: %s" % e)
    finally:
        conn.close()

    print()
    if failures:
        print("[RESULT] FAIL (%d failing checks)" % failures)
        return 1
    print("[RESULT] PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
