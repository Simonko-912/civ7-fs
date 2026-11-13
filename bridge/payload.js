/*
 * payload.js — ns2jb wire-protocol console bridge for the CivSwitch (Civ 7) loader.
 *
 * Eval'd inside the CivSwitch loader closure (TCP :9026); all BRIDGE-CONTRACT.md §1
 * primitives (read64/write64/.../call_rop/malloc/free/socket family/log) are in scope.
 *
 * Implements BRIDGE-CONTRACT.md §2 exactly:
 *   - connect OUT to PC_IP:PC_PORT
 *   - send 128-byte HELLO (16 x u64 LE)
 *   - RPC loop: recv exactly 0x8080 bytes into scratch+0x40000,
 *     execute record A [+0x00] then record B [+0x28] via call_rop(fn, a0, a1, a2, a3),
 *     write resultB at scratch+0x4030 and resultA at scratch+0x4038,
 *     send exactly 0x8010 bytes from scratch+0x4030.
 *   - record A first 20 bytes all zero => clean shutdown.
 *
 * SAFETY: this payload only ever touches (a) memory it malloc'd, (b) addresses
 * derived from svcQueryMemory results, and (c) addresses supplied by the PC engine
 * inside RPC records. No blind pointer chasing: an unmapped read/write is a
 * hardware fault and is NOT catchable from JS — it would kill the game process.
 *
 * The bridge occupies the loader eval for its entire lifetime (long-running);
 * log() lines keep streaming back over the loader's :9026 client connection.
 */
(async function () {
  // ============================ CONFIG ============================
  // Edit before deployment, or keep defaults and let runtime resolution run.
  const CONFIG = {
    // --- PC endpoint (the PC listens; we connect out) ---
    // Left as the placeholder, the bridge derives the peer address from the
    // loader's accepted client socket — which is the machine that delivered
    // this payload (works for LDN-only SD delivery via ZL). Set an explicit
    // IPv4 here for static setups; the node engine always injects its own.
    PC_IP: '<PC_IP>',
    PC_PORT: 39380,           // ns2jb default

    // --- HELLO fields (u64). 0n = "auto-resolve at runtime" where supported ---
    SCRATCH: 0n,        // 0 => malloc(0x80000)
    MAIN: 0n,           // 0 => svcQueryMemory region base containing main_base anchor
    SDK: 0n,            // 0 => svcQueryMemory region base containing sdk_base anchor
    GOT: 0n,            // unused by the Civ7 engine target
    MEMMOVE: 0n,        // 0 => resolved sdk text base + 0x522830
    BACKING: 0n,        // unused by the Civ7 engine target
    CONTROLLER: 0n,     // keep-awake is disabled for Civ7
    SDK_CRC32: 157086863n, // zlib CRC-32 of the 0x602000-byte Civ7 sdk text

    // --- svcQueryMemory wrapper (absolute). 0n => pattern-scan for it ---
    // In the dumped session it sat at sdk_text_base + 0x168B0C (stable per build).
    QMFUNC: 0n,

    VERBOSE: false,     // log a line every 1000 RPCs
  };
  // ================================================================

  const SCRATCH_BYTES   = 0x80000n;
  const REQUEST_BYTES   = 0x8080;   // console <- PC
  const RESPONSE_BYTES  = 0x8010;   // console -> PC
  const INPUT_OFF       = 0x40000n; // request lands at scratch+0x40000
  const REC_B_OFF       = 0x28n;    // record B inside request
  const RESULT_B_OFF    = 0x4030n;  // response[0:8]  = second call result
  const RESULT_A_OFF    = 0x4038n;  // response[8:16] = first  call result
  // Reserved record A value: print a line from the request data area instead of
  // calling it. The engine uses this for chain progress on the console screen.
  const LOG_MAGIC       = 0x4c4f4731n; // 'LOG1'
  const LOG_MAX         = 200;
  const HELLO_MAGIC     = 0x31545344n;
  const HELLO_VERSION   = 1n;
  const HELLO_PLATFORM  = 2n;       // 2 = Switch 2

  const hex = v => '0x' + BigInt(v).toString(16);
  // The console screen shows 37 rows of 146 columns, so keep lines short.
  const perms = n => ['-', 'r', 'w', 'rw', 'x', 'rx', 'wx', 'rwx'][Number(n) & 7] || '?';
  const rule = '---------------------------------------------';
  // Console-side lines are the tool's own voice; the loader's status lines
  // ("Executing payload...") stay unprefixed.
  const say = message => log('ReiAyanami: ' + message);

  // ---- sock helpers (wrappers return signed-32 BigInt; <=0 means fail/EOF) ----
  async function sendAll(fd, addr, len) {
    let off = 0;
    while (off < len) {
      const r = send(fd, addr + BigInt(off), len - off, 0);
      if (r <= 0n) { await say('stream: send failed (' + r + ') at ' + off + '/' + len); return false; }
      off += Number(r);
    }
    return true;
  }
  async function recvFull(fd, addr, len) {
    let off = 0;
    while (off < len) {
      const r = recv(fd, addr + BigInt(off), len - off, 0);
      if (r <= 0n) { await say('stream: computer closed after ' + off + '/' + len + ' bytes'); return false; }
      off += Number(r);
    }
    return true;
  }

  let scratch = 0n;
  let scratchOwned = false;
  let aux = 0n;
  let fd = -1n;
  try {
    await say(rule);

    // ---- 1. scratch buffer (0x80000) ----
    scratch = CONFIG.SCRATCH;
    if (scratch === 0n) {
      scratch = malloc(Number(SCRATCH_BYTES));   // calloc-backed => zeroed
      scratchOwned = true;
    }
    if (!scratch) { await say('[1/5] FAILED: no ' + hex(SCRATCH_BYTES) + ' scratch buffer'); return; }
    await say('[1/5] scratch    ' + hex(scratch) + '  ' + hex(SCRATCH_BYTES) +
              (scratchOwned ? '  calloc, zeroed' : '  from CONFIG'));

    // Aux buffers live OUTSIDE scratch so the RPC areas stay pristine.
    aux = malloc(0x400);   // calloc-backed => zeroed
    if (!aux) { await say('[1/5] FAILED: no 0x400 auxiliary buffer'); return; }
    const saBuf    = aux;             // 16-byte sockaddr_in
    const helloBuf = aux + 0x40n;     // 128-byte HELLO
    const infoBuf  = aux + 0x100n;    // svcQueryMemory MemoryInfo out (0x20 used)
    const pageBuf  = aux + 0x140n;    // svcQueryMemory page-info out (8)

    // ---- 2. locate the svcQueryMemory wrapper inside the sdk module ----
    // Pattern (BRIDGE-CONTRACT.md §1): str x1,[sp,#-16]! (0xF81F0FE1) ; svc #6 (0xD40000C1)
    const STRX1 = 0xF81F0FE1n, SVC6 = 0xD40000C1n;
    let qmFunc = CONFIG.QMFUNC;
    if (qmFunc === 0n) {
      await say('[2/5] looking for svcQueryMemory in the sdk text');
      let prevHi = 0n;               // carry high word to catch 4-byte (non-8) alignment
      const scanEnd = sdk_base + 0x5F0000n;
      for (let a = sdk_base; a < scanEnd; a += 8n) {
        const pair = read64(a);
        const lo = pair & 0xffffffffn, hi = pair >> 32n;
        if (lo === STRX1 && hi === SVC6) { qmFunc = a; break; }       // start at a
        if (prevHi === STRX1 && lo === SVC6) { qmFunc = a - 4n; break; } // start at a-4
        prevHi = hi;
      }
      if (qmFunc === 0n) { await say('[2/5] FAILED: svcQueryMemory not found in sdk text'); return; }
    }
    await say('[2/5] svcQueryMemory ' + hex(qmFunc) + '  sdk+' + hex(qmFunc - sdk_base));

    // ---- 3. region query helper ----
    function query(addr) {
      const r = call_rop(qmFunc, infoBuf, pageBuf, addr);
      if (r !== 0n) return null;
      return {
        base: read64(infoBuf), size: read64(infoBuf + 8n),
        type: Number(read32(infoBuf + 0x10n)), perm: Number(read32(infoBuf + 0x18n)),
      };
    }

    // ---- 4. resolve true module bases for HELLO ----
    let sdk = CONFIG.SDK;
    if (sdk === 0n) {
      const t = query(sdk_base);
      if (!t) { await say('[3/5] FAILED: no memory info for the sdk anchor'); return; }
      sdk = t.base;
      await say('[3/5] sdk    ' + hex(t.base) + ' +' + hex(t.size) + '  ' + perms(t.perm) +
                (t.perm & 4 ? '' : '  WARNING: not executable'));
    }
    let main = CONFIG.MAIN;
    if (main === 0n) {
      const t = query(main_base);
      if (!t) { await say('[3/5] FAILED: no memory info for the main anchor'); return; }
      main = t.base;
      await say('[3/5] main   ' + hex(t.base) + ' +' + hex(t.size) + '  ' + perms(t.perm) +
                (t.perm & 4 ? '' : '  WARNING: not executable'));
    }

    // ---- 5. connect out to the PC ----
    let pcIp = CONFIG.PC_IP;
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(pcIp)) {
      // LDN/manual flow: the delivering host is also our RPC peer. The loader
      // kept the accepted client address in its closure sockaddr_in.
      try {
        if (typeof sockaddr_in !== 'undefined' && typeof read8 === 'function') {
          const a = Number(read8(sockaddr_in + 4n)), b = Number(read8(sockaddr_in + 5n));
          const c = Number(read8(sockaddr_in + 6n)), d = Number(read8(sockaddr_in + 7n));
          if (a || b || c || d) pcIp = a + '.' + b + '.' + c + '.' + d;
        }
      } catch (_) {/* fall through to the explicit-address error */}
    }
    const ipParts = String(pcIp).split('.').map(Number);
    if (ipParts.length !== 4 || ipParts.some(v => !Number.isInteger(v) || v < 0 || v > 255)) {
      await say('[4/5] FAILED: bad PC_IP "' + CONFIG.PC_IP + '"'); return;
    }
    // sockaddr_in (see core.js): len=16, family=AF_INET(2), port big-endian,
    // IPv4 octets in order at +4..+7 (write32 of the little-endian assembly).
    const port = CONFIG.PC_PORT;
    const ipLE = BigInt(ipParts[0] + ipParts[1] * 0x100 + ipParts[2] * 0x10000 + ipParts[3] * 0x1000000);
    write8 (saBuf + 0n, 16n);
    write8 (saBuf + 1n, 2n);
    write16(saBuf + 2n, BigInt(((port & 0xff) << 8) | (port >> 8)));
    write32(saBuf + 4n, ipLE);

    fd = socket(2n, 1n, 0n);   // AF_INET, SOCK_STREAM, IPPROTO_IP
    if (fd < 0n) { await say('[4/5] FAILED: socket() returned ' + fd); return; }
    await say('[4/5] dialling   ' + pcIp + ':' + port);
    const cr = connect(fd, saBuf, 16n);
    if (cr !== 0n) { await say('[4/5] FAILED: connect() returned ' + cr +
      ' - start the engine first: node port/engine/run.cjs <console-ip>'); return; }
    await say('[4/5] connected  fd ' + fd);

    // ---- 6. build + send the 128-byte HELLO (16 x u64 LE) ----
    const memmove = CONFIG.MEMMOVE === 0n ? sdk + 0x522830n : CONFIG.MEMMOVE;
    const helloFields = [
      HELLO_MAGIC, HELLO_VERSION, HELLO_PLATFORM,
      scratch, SCRATCH_BYTES, main, sdk,
      CONFIG.GOT, memmove, CONFIG.BACKING, CONFIG.CONTROLLER,
      0n, 0n, 0n, 0n, CONFIG.SDK_CRC32,
    ];
    for (let i = 0; i < 16; i++) write64(helloBuf + BigInt(i * 8), helloFields[i]);
    await say('[5/5] MOSHI MOSHI?~  sdk crc32 ' + hex(CONFIG.SDK_CRC32) +
              '  memmove sdk+' + hex(memmove - sdk));
    await say('      main ' + hex(main) + '  sdk ' + hex(sdk));
    if (CONFIG.GOT === 0n)
      await say('      got/backing/controller sent as zero');
    if (!(await sendAll(fd, helloBuf, 128))) return;
    await say(rule);
    await say('idle - waiting for the engine to drive');

    // ---- 7. RPC loop (BRIDGE-CONTRACT.md §2) ----
    const inBuf = scratch + INPUT_OFF;
    let rpcCount = 0;
    let skippedNull = false;
    for (;;) {
      if (!(await recvFull(fd, inBuf, REQUEST_BYTES))) break;

      // Termination: record A's first 20 bytes (fnAddr + a0 + low half of a1) all zero.
      if (read64(inBuf) === 0n && read64(inBuf + 8n) === 0n && read32(inBuf + 16n) === 0n) {
        await say('RPC: engine sent the termination record');
        break;
      }

      let resultA = 0n, resultB = 0n;

      const fnA = read64(inBuf);
      if (fnA === LOG_MAGIC) {
        const length = Math.min(Number(read32(inBuf + 8n)) || 0, LOG_MAX);
        let text = '';
        for (let i = 0; i < length; i++)
          text += String.fromCharCode(Number(read8(inBuf + 0x80n + BigInt(i))));
        await say(text);
        write64(scratch + RESULT_B_OFF, 0n);
        write64(scratch + RESULT_A_OFF, 1n);
        if (!(await sendAll(fd, scratch + RESULT_B_OFF, RESPONSE_BYTES))) break;
        rpcCount++;
        continue;
      }
      const b = inBuf + REC_B_OFF;
      const fnB = read64(b);
      if (fnB === 2n) {
        if (fnA !== 0n && fnA % 4n === 0n) {
          try {
            resultA = call_rop(fnA, read64(inBuf + 8n), read64(inBuf + 16n),
                                    read64(inBuf + 24n), read64(inBuf + 32n),
                                    read64(b + 8n), read64(b + 16n));
          } catch (e) { await say('warning: 6-argument call threw for ' + hex(fnA) + ': ' + e.message); }
        } else if (!skippedNull) { skippedNull = true; await say('warning: 6-argument continuation was not callable, skipped'); }
      } else {
        // Record A (request+0x00). Defensive: a zero fn with non-zero args is not
        // the termination packet but is still not callable — skip instead of
        // jumping to address 0 (which would fault the process).
        if (fnA !== 0n) {
          try {
            resultA = call_rop(fnA, read64(inBuf + 8n), read64(inBuf + 16n),
                                    read64(inBuf + 24n), read64(inBuf + 32n));
          } catch (e) { await say('warning: call threw for ' + hex(fnA) + ': ' + e.message); }
        } else if (!skippedNull) { skippedNull = true; await say('warning: record A had no function, skipped'); }

        // Record B (request+0x28). The engine always pads single-call exchanges
        // with a memmove(output,output,0,0) no-op; if a peer leaves fn=0, skip.
        if (fnB !== 0n) {
          try {
            resultB = call_rop(fnB, read64(b + 8n), read64(b + 16n),
                                    read64(b + 24n), read64(b + 32n));
          } catch (e) { await say('warning: call threw for ' + hex(fnB) + ': ' + e.message); }
        } else if (!skippedNull) { skippedNull = true; await say('warning: record B had no function, skipped'); }
      }

      // Response header: resultB first, then resultA (matches bootstrap.bas and
      // native.cjs, where response[0:8] = second call, response[8:16] = first).
      write64(scratch + RESULT_B_OFF, resultB);
      write64(scratch + RESULT_A_OFF, resultA);

      if (!(await sendAll(fd, scratch + RESULT_B_OFF, RESPONSE_BYTES))) break;

      rpcCount++;
      if (CONFIG.VERBOSE && rpcCount % 1000 === 0) await say('RPC: ' + rpcCount + ' exchanges');
    }

    await say(rule);
    await say('done: ' + rpcCount + ' RPC exchanges, socket closed');
  } catch (e) {
    // Never let a JS exception kill the eval silently — report and return.
    try { await say('FAILED: ' + ((e && e.stack) || e)); } catch (_) {}
  } finally {
    if (fd >= 0n) { try { close(fd); } catch (_) {} }
    if (aux) { try { free(aux); } catch (_) {} }
    if (scratchOwned && scratch) { try { free(scratch); } catch (_) {} }
  }
})();
