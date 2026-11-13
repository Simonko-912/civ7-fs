#!/usr/bin/env python3
"""check_loader.py - prove the engine still matches the loader in ../core.js.

The port is coupled to core.js through a small fixed contract. Everything else
(offsets, instruction bytes, layouts) comes from the Civ7 artifacts next to this
port, so a core.js update is safe exactly when this checker passes.

Contract checked here:
  1. the primitives `payload.js` uses exist in the loader's eval scope
     (they are closure locals of core.js, so `eval` sees them - BRIDGE-CONTRACT.md 1);
  2. `call_rop` still takes six arguments (record B continuation);
  3. the anchor chain still yields the SDK offsets the engine drives:
     `sdk_base = memcpy_addr - <memcpy text offset>` and the memmove entry;
  4. the libc entry points the bridge/engine reuse are unchanged
     (calloc at main_base+0x515b50, free at main_base+0x515a60);
  5. `bridge/payload.js` and `targets/civ7/target.json` agree with each other and
     with the artifact tables.

Usage:
  python3 tools/check_loader.py [path/to/core.js] [--sdk-functions F] [--target T]

Exit status 0 = the port may be used with this core.js. 1 = do not run.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PORT = Path(__file__).resolve().parents[1]

# Payload-visible primitives consumed by payload.js (a superset of what the
# bridge itself calls is fine; these are the ones whose absence breaks it).
PRIMITIVES = [
    "read8", "read16", "read32", "read64",
    "write8", "write16", "write32", "write64",
    "call_rop", "malloc", "free", "log", "sleep",
    "socket", "connect", "recv", "send", "close", "getsockname", "setsockopt",
    "main_base", "sdk_base",
]

EXPECTED = {
    "calloc": 0x515B50,
    "free": 0x515A60,
}


class Checker:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.checks = 0

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        self.checks += 1
        print(f"{'PASS' if ok else 'FAIL'}  {label}{'  (' + detail + ')' if detail else ''}")
        if not ok:
            self.failures.append(label)
        return ok


def hexint(value: str) -> int:
    return int(value, 16)


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("core", nargs="?", default=str(PORT / "core.js"))
    parser.add_argument("--sdk-functions", default=str(PORT / "targets" / "civ7" / "sdk-functions.json"))
    parser.add_argument("--target", default=str(PORT / "targets" / "civ7" / "target.json"))
    args = parser.parse_args()

    source = Path(args.core)
    if not source.exists():
        raise SystemExit(f"no loader found at {source}")
    text = source.read_text()
    sdk = json.loads(Path(args.sdk_functions).read_text())
    target = json.loads(Path(args.target).read_text())
    bridge = (PORT / "bridge" / "payload.js").read_text()
    c = Checker()

    print(f"loader: {source}")
    print(f"artifacts: {Path(args.sdk_functions).name}, {Path(args.target).name}\n")

    # 1. primitives in the eval scope
    for name in PRIMITIVES:
        declared = re.search(rf"(?:function|const|let|var)\s+{name}\b", text) is not None
        c.check(declared, f"loader declares {name}")

    # 2. call_rop arity
    arity = re.search(r"function\s+call_rop\s*\(([^)]*)\)", text)
    params = [p for p in (arity.group(1).split(",") if arity else []) if p.strip()]
    c.check(len(params) >= 6, "call_rop takes six arguments", f"{len(params)} parameters")

    # 3. anchor chain: sdk_base = memcpy_addr - <memcpy text offset>
    anchor = re.search(r"sdk_base\s*=\s*memcpy_addr\s*-\s*0x([0-9a-fA-F]+)n?", text)
    memcpy_offset = anchor and hexint(anchor.group(1))
    c.check(memcpy_offset == sdk.get("memcpy", {}).get("offset"),
            "sdk_base anchor matches the memcpy artifact offset",
            f"core.js 0x{(memcpy_offset or 0):x} vs artifact 0x{sdk.get('memcpy', {}).get('offset', 0):x}")
    c.check("memcpy_addr" in text and "main_base + 0x4DC6088n" in text,
            "memcpy pointer read from main_base+0x4DC6088")

    # 4. libc entry points reused by the bridge/engine
    for name, expected in EXPECTED.items():
        found = re.search(rf"F_{name}\s*=\s*main_base\s*\+\s*0x([0-9a-fA-F]+)n", text)
        value = found and hexint(found.group(1))
        c.check(value == expected, f"{name} entry point unchanged",
                f"core.js 0x{(value or 0):x} vs expected 0x{expected:x}")

    # 5. bridge <-> artifacts agreement
    memmove = re.search(r"MEMMOVE === 0n \? sdk \+ 0x([0-9a-fA-F]+)n", bridge)
    bridge_memmove = memmove and hexint(memmove.group(1))
    c.check(bridge_memmove == sdk.get("memmove", {}).get("offset"),
            "civ_bridge memmove offset matches the artifact",
            f"bridge 0x{(bridge_memmove or 0):x} vs artifact 0x{sdk.get('memmove', {}).get('offset', 0):x}")

    crc = re.search(r"SDK_CRC32:\s*(\d+)n", bridge)
    bridge_crc = crc and int(crc.group(1))
    c.check(bridge_crc == target.get("hello", {}).get("sdkCrc32"),
            "civ_bridge SDK CRC-32 matches the target profile",
            f"bridge {bridge_crc} vs target {target.get('hello', {}).get('sdkCrc32')}")

    scratch = re.search(r"SCRATCH_BYTES\s*=\s*0x([0-9a-fA-F]+)n", bridge)
    bridge_scratch = scratch and hexint(scratch.group(1))
    c.check(bridge_scratch == target.get("hello", {}).get("scratchBytes"),
            "civ_bridge scratch size matches the target profile",
            f"bridge 0x{(bridge_scratch or 0):x} vs target 0x{target.get('hello', {}).get('scratchBytes', 0):x}")

    platform = re.search(r"HELLO_PLATFORM\s*=\s*(\d+)n", bridge)
    c.check(platform is not None and int(platform.group(1)) == 2,
            "civ_bridge announces platform 2 (Switch 2)")

    print(f"\n{c.checks - len(c.failures)}/{c.checks} checks passed")
    if c.failures:
        print("do not run this port against this loader: " + ", ".join(c.failures))
        return 1
    print("port and loader agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
