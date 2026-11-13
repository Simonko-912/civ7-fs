const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {injectAddress} = require('../engine/lib/loader.cjs');

// The payload ships with a PC_IP placeholder; the engine fills it in per run.
const PC_IP = '192.0.2.15';
const bridgeSource = () => injectAddress(
  fs.readFileSync(path.join(__dirname, 'payload.js'), 'utf8'), PC_IP);

const REQUEST_BYTES = 0x8080;
const RESPONSE_BYTES = 0x8010;
const INPUT_OFFSET = 0x40000n;
const OUTPUT_OFFSET = 0x4040n;

function record(fn, ...args) {
  const bytes = Buffer.alloc(40);
  [fn, ...args, 0n, 0n, 0n, 0n].slice(0, 5).forEach((value, index) => {
    bytes.writeBigUInt64LE(value, index * 8);
  });
  return bytes;
}

function request(a, b, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(REQUEST_BYTES);
  a.copy(bytes, 0);
  b.copy(bytes, 0x28);
  data.copy(bytes, 0x80);
  return bytes;
}

function environment() {
  const bytes = new Map();
  const allocations = [];
  const freed = [];
  const sent = [];
  let incoming = Buffer.alloc(0);
  let closed = false;
  const sdk = 0x10000000n;
  const main = 0x20000000n;
  const scratch = 0x30000000n;
  const aux = 0x30080000n;
  const queryMemory = sdk + 0x168b0cn;
  const memmove = sdk + 0x522830n;
  const memcpy = sdk + 0x5224e0n;
  const out = scratch + OUTPUT_OFFSET;

  function read(address, length) {
    const result = Buffer.alloc(length);
    for (let index = 0; index < length; index++) result[index] = bytes.get(address + BigInt(index)) || 0;
    return result;
  }

  function write(address, data) {
    for (let index = 0; index < data.length; index++) bytes.set(address + BigInt(index), data[index]);
  }

  function readInt(address, length) {
    let value = 0n;
    for (let index = length - 1; index >= 0; index--) value = value << 8n | BigInt(bytes.get(address + BigInt(index)) || 0);
    return value;
  }

  function writeInt(address, value, length) {
    value = BigInt.asUintN(length * 8, value);
    for (let index = 0; index < length; index++) {
      bytes.set(address + BigInt(index), Number(value & 0xffn));
      value >>= 8n;
    }
  }

  function call(fn, a0, a1, a2) {
    if (fn === queryMemory) {
      writeInt(a0, a2 === main ? main : sdk, 8);
      writeInt(a0 + 8n, a2 === main ? 0x800000n : 0x602000n, 8);
      writeInt(a0 + 0x10n, 3n, 4);
      writeInt(a0 + 0x18n, 5n, 4);
      return 0n;
    }
    if (fn === memcpy || fn === memmove) {
      write(a0, read(a1, Number(a2)));
      return a0;
    }
    throw new Error(`unexpected native call ${fn.toString(16)}`);
  }

  const context = {
    sdk_base: queryMemory - 4n,
    main_base: main,
    malloc(size) {
      const address = allocations.length ? aux : scratch;
      allocations.push({address, size});
      return address;
    },
    free(address) { freed.push(address); },
    read64: address => readInt(address, 8),
    read32: address => readInt(address, 4),
    read16: address => readInt(address, 2),
    read8: address => readInt(address, 1),
    write64: (address, value) => writeInt(address, value, 8),
    write32: (address, value) => writeInt(address, value, 4),
    write16: (address, value) => writeInt(address, value, 2),
    write8: (address, value) => writeInt(address, value, 1),
    call_rop: call,
    socket: () => 7n,
    connect: () => 0n,
    close: () => { closed = true; return 0n; },
    recv(fd, address, length) {
      if (!incoming.length) return 0n;
      const count = Math.min(Number(length), 4096, incoming.length);
      write(address, incoming.subarray(0, count));
      incoming = incoming.subarray(count);
      return BigInt(count);
    },
    send(fd, address, length) {
      const count = Math.min(Number(length), 4096);
      sent.push(read(address, count));
      return BigInt(count);
    },
    log: async message => { env.logs.push(message); },
    sleep: async () => {},
  };

  const env = {
    context, sdk, main, scratch, aux, queryMemory, memmove, memcpy, out,
    allocations, freed, sent, read, write, logs: [],
    queue(data) { incoming = Buffer.concat([incoming, data]); },
    closed: () => closed,
  };
  return env;
}

test('Civ bridge completes HELLO, native RPC reads/writes, and clean termination', async () => {
  const env = environment();
  const noop = record(env.memmove, env.out, env.out, 0n, 0n);
  const source = env.main + 0x5000n;
  const target = env.main + 0x6000n;
  env.write(source, Buffer.from('Civ7'));
  env.write(env.queryMemory, Buffer.from('e10f1ff8c10000d4', 'hex'));

  const query = request(record(env.queryMemory, env.out, env.out + 0x40n, env.sdk, 0n), noop);
  const readRequest = request(record(env.memcpy, env.out, source, 4n, 0n), noop);
  const writeRequest = request(
    record(env.memmove, target, env.scratch + INPUT_OFFSET + 0x80n, 4n, 0n),
    noop,
    Buffer.from('port'),
  );
  env.queue(Buffer.concat([query, readRequest, writeRequest, Buffer.alloc(REQUEST_BYTES)]));

  const sourceCode = bridgeSource();
  await vm.runInNewContext(sourceCode, env.context, {filename: 'payload.js'});

  const stream = Buffer.concat(env.sent);
  assert.equal(stream.length, 128 + 3 * RESPONSE_BYTES, env.logs.join('\n'));
  const hello = Array.from({length: 16}, (_, index) => stream.readBigUInt64LE(index * 8));
  assert.equal(hello[0], 0x31545344n);
  assert.equal(hello[1], 1n);
  assert.equal(hello[2], 2n);
  assert.equal(hello[3], env.scratch);
  assert.equal(hello[4], 0x80000n);
  assert.equal(hello[5], env.main);
  assert.equal(hello[6], env.sdk);
  assert.equal(hello[8], env.memmove);
  assert.equal(hello[15], 157086863n);

  const queryResponse = stream.subarray(128, 128 + RESPONSE_BYTES);
  assert.equal(queryResponse.readBigUInt64LE(8), 0n);
  assert.equal(queryResponse.readBigUInt64LE(16), env.sdk);
  assert.equal(queryResponse.readBigUInt64LE(24), 0x602000n);

  const readResponse = stream.subarray(128 + RESPONSE_BYTES, 128 + 2 * RESPONSE_BYTES);
  assert.equal(readResponse.readBigUInt64LE(8), env.out);
  assert.equal(readResponse.subarray(16, 20).toString(), 'Civ7');

  const writeResponse = stream.subarray(128 + 2 * RESPONSE_BYTES);
  assert.equal(writeResponse.readBigUInt64LE(8), target);
  assert.equal(env.read(target, 4).toString(), 'port');
  assert.equal(env.closed(), true);
  assert.deepEqual(env.freed, [env.aux, env.scratch]);
});

test('Civ bridge prints a LOG1 record on the console instead of calling it', async () => {
  const env = environment();
  env.write(env.queryMemory, Buffer.from('e10f1ff8c10000d4', 'hex'));
  const message = Buffer.from('> phase 2/4 FS acquisition', 'latin1');
  const logRequest = Buffer.alloc(REQUEST_BYTES);
  logRequest.writeBigUInt64LE(0x4c4f4731n, 0);          // 'LOG1'
  logRequest.writeBigUInt64LE(BigInt(message.length), 8);
  message.copy(logRequest, 0x80);                        // request data area
  env.queue(Buffer.concat([logRequest, Buffer.alloc(REQUEST_BYTES)]));

  await vm.runInNewContext(bridgeSource(), env.context, {filename: 'payload.js'});

  assert.equal(env.logs.filter(line => line === 'ReiAyanami: > phase 2/4 FS acquisition').length, 1,
    env.logs.join(' | '));
  const stream = Buffer.concat(env.sent);
  assert.equal(stream.length, 128 + 0x8010, 'one response for the log record');
  assert.equal(stream.readBigUInt64LE(128 + 8), 1n, 'log record is acknowledged');
});

test('Civ bridge releases allocations when SDK discovery fails', async () => {
  const env = environment();
  const sourceCode = bridgeSource();
  await vm.runInNewContext(sourceCode, env.context, {filename: 'payload.js'});
  assert.ok(env.logs.some(line => line.includes('svcQueryMemory not found')));
  assert.deepEqual(env.freed, [env.aux, env.scratch]);
  assert.equal(env.closed(), false);
});

test('Civ bridge passes all six arguments through a continuation record', async () => {
  const env = environment();
  env.write(env.queryMemory, Buffer.from('e10f1ff8c10000d4', 'hex'));
  const fn = env.sdk + 0x4000n, calls = [];
  const original = env.context.call_rop;
  env.context.call_rop = (address, ...args) => {
    if (address !== fn) return original(address, ...args);
    calls.push(args);
    return 0x99n;
  };
  const a = record(fn, 1n, 2n, 3n, 4n);
  const continuation = record(2n, 5n, 6n, 0n, 0n);
  env.queue(Buffer.concat([request(a, continuation), Buffer.alloc(REQUEST_BYTES)]));
  const sourceCode = bridgeSource();
  await vm.runInNewContext(sourceCode, env.context, {filename: 'payload.js'});
  assert.deepEqual(calls, [[1n, 2n, 3n, 4n, 5n, 6n]]);
  const stream = Buffer.concat(env.sent);
  assert.equal(stream.length, 128 + RESPONSE_BYTES);
  assert.equal(stream.readBigUInt64LE(128), 0n);
  assert.equal(stream.readBigUInt64LE(136), 0x99n);
});
