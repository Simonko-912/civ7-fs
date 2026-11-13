#!/usr/bin/env node
const fs = require('node:fs/promises');
const {createWriteStream} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {listen} = require('./lib/connection.cjs');
const {sendBridge, localAddressFor, LOADER_PORT} = require('./lib/loader.cjs');
const {NativeClient} = require('./lib/native.cjs');
const {qualify} = require('./lib/qualify.cjs');
const {serve} = require('./lib/bridge.cjs');
const {isUserFacing} = require('./lib/log.cjs');
const {loadTarget, selectedTarget, assertFullSupported, materializeTarget, validateArtifacts} = require('./shared/target.cjs');

const port = 39380;
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const DUMP_MARKER = '.ns2jb-firmware-dump.json';

// Run output belongs at the repository root: <repo>/runs and <repo>/dumps.
const OUTPUT_ROOT = path.join(__dirname, '..');

async function prepareDumpDirectory(root = path.join(OUTPUT_ROOT, 'dumps')) {
  const parent = path.dirname(root);
  const previous = await fs.lstat(root).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous) {
    if (!previous.isDirectory() || previous.isSymbolicLink() ||
        previous.dev !== (await fs.stat(parent)).dev)
      throw Error('Refusing to clean a symlink, mount, or non-directory at ' + root);
    const marker = await fs.readFile(path.join(root, DUMP_MARKER), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!marker || marker.kind !== 'ns2jb-system-code-dump' || marker.version !== 1) {
      if ((await fs.readdir(root)).length)
        throw Error('Refusing to clean an unrecognized nonempty dumps directory: ' + root);
    }
    // A failed or repeated run must never destroy a completed capture: an
    // existing dump is archived beside the workspace, not deleted.
    if ((await fs.readdir(root)).some(name => name !== DUMP_MARKER)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archived = root + '-' + stamp;
      await fs.rename(root, archived);
      console.log('Previous system-code dump kept at ' + archived);
      return {...await prepareDumpDirectory(root), archived};
    }
    await fs.rm(root, {recursive: true});
  }
  await fs.mkdir(root, {mode: 0o700});
  await fs.writeFile(path.join(root, DUMP_MARKER), JSON.stringify({
    kind: 'ns2jb-system-code-dump', version: 1, started: new Date().toISOString()
  }, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return {root, cleaned: !!previous};
}

function addresses(interfaces = os.networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter(a =>
    a.family === 'IPv4' && !a.internal && a.netmask !== '255.255.255.255' &&
    !a.address.startsWith('169.254.')).map(a => a.address))];
}

async function chooseHost(args) {
  if (args.length > 1 || args.length === 1 && !net.isIPv4(args[0]))
    throw Error('Usage: node engine/run.cjs [--target civ7|smilebasic] [--rpc] [--dump-firmware] [computer-IP]');
  if (args.length) return args[0];
  const choices = addresses();
  if (choices.length === 1) return choices[0];
  if (!choices.length) throw Error('Connect this computer to the console’s local network.');
  if (!process.stdin.isTTY)
    throw Error('Choose the address on the console’s network: node engine/run.cjs IP\nAvailable: ' + choices.join(', '));
  choices.forEach((address, i) => console.log(`  ${i + 1}. ${address}`));
  const input = require('node:readline/promises').createInterface({input: process.stdin, output: process.stdout});
  try {
    const choice = await input.question('Which computer address can the Switch 2 reach? ');
    if (!/^[1-9][0-9]*$/.test(choice) || !choices[Number(choice) - 1]) throw Error('Choose one of the listed addresses.');
    return choices[Number(choice) - 1];
  } finally {input.close();}
}

function connectCommand(host, basicArgs = 5) {
  if (![5, 9].includes(basicArgs)) throw Error('NS2_BASIC_ARITY must be 5 or 9');
  return `V=START(${[port, ...host.split('.'), ...(basicArgs === 9 ? [0, 0, 0, 0] : [])].join(',')})`;
}

function parseArguments(args) {
  let targetName = process.env.NS2_TARGET || 'civ7';
  const hostArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target') {
      if (++i === args.length) throw Error('--target requires civ7 or smilebasic');
      targetName = args[i];
    } else if (arg.startsWith('--target=')) targetName = arg.slice('--target='.length);
    else if (['--rpc', '--dump-firmware', '--app-only', '--no-send', '--no-hold'].includes(arg)) continue;
    else hostArgs.push(arg);
  }
  const appOnly = args.includes('--app-only');
  if (appOnly && (args.includes('--rpc') || args.includes('--dump-firmware') || process.env.NS2_RPC_MODE === '1'))
    throw Error('--app-only cannot be combined with --rpc or --dump-firmware');
  // Civ7 holds the verified chain by default: one command takes a cold loader to
  // an RPC that an MCP client can attach to.
  const hold = !appOnly && !args.includes('--no-hold') &&
    (targetName === 'civ7' || args.includes('--rpc') || process.env.NS2_RPC_MODE === '1');
  return {targetName: selectedTarget(targetName), hostArgs, appOnly, hold,
    send: targetName === 'civ7' && !args.includes('--no-send'),
    rpcMode: hold, dumpFirmware: args.includes('--dump-firmware')};
}

async function sourceDigest(target = loadTarget(selectedTarget(process.env.NS2_TARGET || 'smilebasic'))) {
  const names = ['run.cjs', 'rpc.cjs', 'dump-firmware.cjs', 'bootstrap.bas'];
  async function walk(folder) {
    for (const entry of await fs.readdir(path.join(__dirname, folder), {withFileTypes: true})) {
      const name = folder + '/' + entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) names.push(name);
      else throw Error('Unexpected runtime file: ' + name);
    }
  }
  for (const folder of ['lib', 'shared', 'switch2']) await walk(folder);
  const entries = [];
  for (const name of names.sort()) entries.push([name,
    crypto.createHash('sha256').update(await fs.readFile(path.join(__dirname, name))).digest('hex')]);
  const artifacts = validateArtifacts(target);
  const files = [artifacts.sdkFunctions, artifacts.sdkLayout, ...Object.values(artifacts.app)].filter(Boolean);
  for (const artifact of files) entries.push(['artifact/' + path.relative(target.portRoot, artifact.file),
    crypto.createHash('sha256').update(await fs.readFile(artifact.file)).digest('hex')]);
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

async function startEngine(directory, dumpDirectory = null, held = false, target = loadTarget(), appOnly = false) {
  const log = await fs.open(path.join(directory, 'run.log'), 'wx', 0o600);
  const output = createWriteStream(null, {fd: log.fd, autoClose: false});
  const child = spawn(process.execPath, [path.join(directory, 'switch2/pipeline.cjs'),
    ...(dumpDirectory ? ['--dump-firmware'] : []), ...(held ? ['--hold-rpc'] : []), ...(appOnly ? ['--app-only'] : [])],
    {cwd: directory, stdio: ['ignore', 'pipe', 'pipe', ...(held ? ['ipc'] : [])], windowsHide: true,
      env: {...process.env, NS2_TARGET: target.name, NS2_TARGET_ROOT: directory,
        ...(dumpDirectory ? {NS2_FIRMWARE_DUMP_DIR: dumpDirectory} : {})}});
  child.stdout.pipe(output, {end: false});
  child.stderr.pipe(output, {end: false});
  const lines = readline.createInterface({input: child.stdout});
  lines.on('line', line => {
    // Everything human-readable, not just the four phase lines: the stage timings
    // and the closing summary used to be filtered out here and lost to run.log.
    if (isUserFacing(line)) console.log(line);
  });
  let childError;
  child.once('error', error => {childError = error;});
  output.once('error', error => {childError = error; child.kill('SIGTERM');});
  const finished = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})))
    .then(async outcome => {
    if (!output.destroyed)
      await new Promise((resolve, reject) => {output.once('error', reject); output.end(resolve);});
    await log.close();
    return {...outcome, error: childError};
  });
  const ready = held ? new Promise((resolve, reject) => {
    const message = value => {
      if (value?.type !== 'held-ready') return;
      child.removeListener('message', message);
      resolve(value);
    };
    child.on('message', message);
    finished.then(outcome => {
      child.removeListener('message', message);
      reject(outcome.error || Error('The FS endpoint exited before the held session was ready.'));
    }, reject);
  }) : null;
  let releaseSent = false;
  return {child, finished, ready,
    async release() {
      if (held && !releaseSent && child.connected) {
        releaseSent = true;
        child.send({type: 'release'});
      }
      return finished;
    }};
}

function checkEngine(outcome) {
  if (outcome.error) throw outcome.error;
  if (outcome.code !== 0)
    throw Error('The run stopped. Keep the runs folder and restart the console before trying again.');
}

function waitForRpcStop(connection, signals = process, engineFinished = null) {
  return new Promise(resolve => {
    const socket = connection.socket;
    let settled = false;
    const finish = reason => {
      if (settled) return;
      settled = true;
      signals.removeListener('SIGINT', interrupt);
      signals.removeListener('SIGTERM', terminate);
      socket.removeListener('close', disconnected);
      resolve(reason);
    };
    const interrupt = () => finish('SIGINT');
    const terminate = () => finish('SIGTERM');
    const disconnected = () => finish('disconnected');
    signals.once('SIGINT', interrupt);
    signals.once('SIGTERM', terminate);
    socket.once('close', disconnected);
    if (engineFinished) engineFinished.then(() => finish('engine-exited'), () => finish('engine-exited'));
    if (connection.error || socket.destroyed) finish('disconnected');
  });
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node engine/run.cjs CONSOLE-IP [--app-only] [--dump-firmware] [--no-hold] [--no-send]\n' +
      '  CONSOLE-IP       the Switch 2 address; the Remote JS Loader listens there on :9026\n' +
      '  --app-only       stop after app qualification; no FS mutation\n' +
      '  --dump-firmware  also capture installed system-program CodeFS\n' +
      '  --no-hold        exit after the chain instead of holding the native RPC\n' +
      '  --no-send        do not push bridge/payload.js; push it yourself\n' +
      'Civ7 is the default target; --target smilebasic keeps the SmileBASIC flow.');
    return;
  }
  const options = parseArguments(args), {rpcMode, dumpFirmware, appOnly} = options;
  const target = assertFullSupported(loadTarget(options.targetName));
  process.env.NS2_TARGET = target.name;
  const basicArgs = Number(process.env.NS2_BASIC_ARITY || 5);
  // Civ7: the argument is the console, and this computer's address on that route
  // is derived by the kernel. SmileBASIC keeps the interactive choice.
  let host, consoleHost = null;
  if (target.name === 'civ7') {
    if (options.hostArgs.length !== 1 || !net.isIPv4(options.hostArgs[0]))
      throw Error('Give the console address: node engine/run.cjs 192.168.2.118');
    consoleHost = options.hostArgs[0];
    host = await localAddressFor(consoleHost);
  } else host = await chooseHost(options.hostArgs);
  const command = target.name === 'smilebasic' ? connectCommand(host, basicArgs) :
    `bridge/payload.js -> this computer at ${host}:${port}`;
  const workspace = path.join(OUTPUT_ROOT, 'runs');
  await fs.mkdir(workspace, {recursive: true, mode: 0o700});
  let dumpDirectory;
  if (dumpFirmware) {
    const space = await fs.statfs(workspace);
    if (BigInt(space.bavail) * BigInt(space.bsize) < 512n * 1024n * 1024n)
      throw Error('The optional system-code dump needs at least 512 MiB free on the computer before starting.');
    const prepared = await prepareDumpDirectory();
    dumpDirectory = prepared.root;
    if (prepared.archived) console.log('New dump folder: ' + dumpDirectory);
    else if (prepared.cleaned) console.log('Empty dump folder recreated at ' + dumpDirectory);
    console.log('System-code dump folder: ' + dumpDirectory);
  }
  const directory = await fs.mkdtemp(path.join(workspace, 'switch2-'));
  await fs.writeFile(path.join(directory, 'connect.txt'), command + '\n', {mode: 0o600});
  const result = {platform: 2, target: target.name, sourceSha256: await sourceDigest(target),
    started: new Date().toISOString(), verified: false};
  let native, bridge, engine, failure;
  try {
    const connected = await listen({host, port, target, onWaiting() {
      console.log(`Waiting for ${target.displayName} at ${host}:${port}.`);
      if (target.name === 'smilebasic') {
        console.log('In a freshly opened SmileBASIC, load the saved bootstrap and enter:');
        console.log('  RUN\n  REMOVE NSR,&H60000000,&H3FFFFFFF');
        console.log('After the expected Out of memory message, enter:');
        console.log('  ' + command);
        if (basicArgs === 5) {
          console.log('If BASIC says Wrong number of arguments, use the older nine-argument form instead:');
          console.log('  ' + connectCommand(host, 9));
        }
      } else {
        console.log('ReiAyanami: bridge -> this computer at ' + host + ':' + port);
        if (options.send) {
          console.log('ReiAyanami: pushing bridge/payload.js to the loader on ' +
            consoleHost + ':' + LOADER_PORT);
          sendBridge({console: consoleHost, pcIp: host, log: line => console.log(line)})
            .then(() => console.log('ReiAyanami: bridge closed'))
            .catch(error => console.error('ReiAyanami: bridge push failed: ' + error.message));
        } else console.log('ReiAyanami: push bridge/payload.js yourself, or drop --no-send.');
      }
      console.log('Run folder: ' + directory);
    }});
    native = new NativeClient(connected.connection, connected.addresses, target);
    console.log('Connected. Checking the application...');
    result.bootstrap = await qualify(native);
    bridge = await serve(native);
    bridge.keepAwake(result.bootstrap.activity);
    await save(path.join(directory, 'connection.json'), {port: bridge.port, token: bridge.token,
      addresses: {...connected.addresses, session: path.basename(directory), target: target.name}});
    // 'lib' is hashed above, so it must also travel into the run directory: the
    // pipeline and probe require ../lib/log.cjs from inside the copy.
    for (const name of ['lib', 'shared', 'switch2'])
      await fs.cp(path.join(__dirname, name), path.join(directory, name), {recursive: true});
    await materializeTarget(target, directory);
    engine = await startEngine(directory, dumpDirectory, rpcMode, target, appOnly);
    if (rpcMode) await engine.ready;
    else checkEngine(await engine.finished);
    if (appOnly) {
      result.app = JSON.parse(await fs.readFile(path.join(directory, 'switch2/app-qualification-current.json')));
      if (!result.app.verified || !result.app.cleanup?.cleanedUp)
        throw Error('Application-only qualification or cleanup did not verify.');
    } else {
      result.fs = JSON.parse(await fs.readFile(path.join(directory, 'switch2/fs-execution-current.json')));
      if (!result.fs.verified || !result.fs.restored ||
          (rpcMode ? !result.fs.retainedEndpoint?.ready || !result.fs.cleanup?.deferred :
            !result.fs.cleanup?.cleanedUp))
        throw Error('FS execution, restoration, or endpoint state did not verify.');
    }
    if (dumpFirmware) {
      result.firmwareDump = JSON.parse(await fs.readFile(path.join(dumpDirectory, 'firmware-dump.json')));
      if (!result.firmwareDump.complete || result.firmwareDump.entries.length !== result.firmwareDump.inventory.total)
        throw Error('The system-code dump did not finish.');
    }
    result.verified = true;
    if (rpcMode) {
      result.rpc = {mode: 'held', state: 'listening', opened: new Date().toISOString()};
      await save(path.join(directory, 'result.json'), result);
      console.log(`4/4 verified. ${target.displayName} RPC and FS memory endpoint remain live while this process and the app stay open.`);
      console.log('ReiAyanami: held - MCP attach file ' + path.join(directory, 'connection.json'));
      console.log('ReiAyanami: local check   node engine/rpc.cjs ' + directory + ' status');
      console.log('ReiAyanami: run folder    ' + directory);
      console.log(`ReiAyanami: stop with Ctrl-C; do not close ${target.displayName} until finished.`);
      const reason = await waitForRpcStop(native.connection, process, engine.finished);
      result.rpc = {...result.rpc, state: 'closed', reason, closed: new Date().toISOString()};
      if (reason === 'engine-exited') throw Error('The held FS endpoint exited unexpectedly.');
      checkEngine(await engine.release());
      result.fs = JSON.parse(await fs.readFile(path.join(directory, 'switch2/fs-execution-current.json')));
      if (!result.fs.cleanup?.cleanedUp) throw Error('Held FS resources did not clean up.');
      if (reason === 'disconnected') throw Error('Held RPC disconnected; do not replay an uncertain native request.');
    }
  } catch (error) {
    if (error.message === 'The FS endpoint exited before the held session was ready.') {
      try {
        const pipeline = JSON.parse(await fs.readFile(path.join(directory, 'switch2/pipeline.json')));
        if (pipeline.error) error = Error(pipeline.error.split('\n')[0]);
      } catch { /* The run log remains available if no pipeline report exists. */ }
    }
    result.error = error.message; failure = error;
  }
  finally {
    if (engine && rpcMode) {
      try {checkEngine(await engine.release());}
      catch (error) {(result.cleanupErrors ||= []).push({name: 'FS endpoint', error: error.message}); failure ||= error;}
    }
    for (const [name, close] of [['bridge', () => bridge?.close()], ['connection', () => native?.stop()]]) {
      try {await close();}
      catch (error) {(result.cleanupErrors ||= []).push({name, error: error.message}); failure ||= error;}
    }
    result.completed = new Date().toISOString();
    await save(path.join(directory, 'result.json'), result);
  }
  if (failure) throw Error(failure.message + '\nDetails: ' + directory);
  console.log('FS execution verified. Original instructions restored and scratch cleaned up.');
  if (dumpFirmware) console.log('System-program CodeFS dump: ' +
    path.join(dumpDirectory, 'firmware-dump.json'));
  console.log('Restart the console when finished.');
  return result;
}

module.exports = {main, addresses, chooseHost, connectCommand, parseArguments, sourceDigest, prepareDumpDirectory,
  startEngine, checkEngine, waitForRpcStop};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
