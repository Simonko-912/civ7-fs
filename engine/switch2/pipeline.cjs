const fs = require('node:fs/promises');
const path = require('node:path');
const {a, log: consoleLog} = require('../shared/rpc.cjs');
const {run} = require('../shared/stages.cjs');
const {connect} = require('./tools/fs-memory.cjs');
const runtime = require('./ro/runtime.cjs');
const {read, save, local, hash} = runtime;
const {loadTarget, programId, required} = require('../shared/target.cjs');
const target = loadTarget();
const check = (ok, message) => {if (!ok) throw Error(message);};
const {createLogger} = require('../lib/log.cjs');

async function main() {
  const flags = process.argv.slice(2);
  check(flags.length <= 3 && flags.every(flag => ['--dump-firmware', '--hold-rpc', '--app-only'].includes(flag)) &&
    new Set(flags).size === flags.length, 'Usage: pipeline.cjs [--app-only] [--dump-firmware] [--hold-rpc]');
  const dumpFirmware = flags.includes('--dump-firmware');
  const holdRpc = flags.includes('--hold-rpc');
  const appOnly = flags.includes('--app-only');
  check(!holdRpc || typeof process.send === 'function', 'Held FS mode requires runner IPC');
  check(!appOnly || !dumpFirmware && !holdRpc, 'App-only mode cannot run FS stages');
  const file = path.join(__dirname, 'pipeline.json');
  const record = {session: a.session, started: new Date().toISOString(), stages: []};
  await fs.writeFile(file, JSON.stringify(record) + '\n', {flag: 'wx', mode: 0o600});
  // Progress goes to the console screen as well as this log; a failed or slow
  // notification must never disturb the chain.
  const note = message => {
    try {consoleLog(message).catch(() => {});} catch (error) {/* bridge gone */}
  };
  // The terminal view of a run: one aligned line per stage, with its duration, and
  // the full stage record still written to pipeline.json.
  const log = createLogger();

  async function stage(name, action) {
    // The console screen only gets the four phase lines and failures: one note per
    // stage start and per stage completion redrew the DOM dozens of times a run
    // without adding anything the engine log does not already record.
    const began = Date.now();
    const row = {name, started: new Date().toISOString(), status: 'running'};
    record.stages.push(row); await save(file, record);
    if (process.stdout.isTTY) log.step(name);
    try {
      row.result = await action(); row.status = 'complete';
      log.done(name, Date.now() - began);
      return row.result;
    } catch (error) {
      row.status = 'failed'; row.error = error.stack;
      log.done(name, Date.now() - began, 'FAILED');
      note('FAILED: ' + (error.message || name));
      throw error;
    }
    finally {row.finished = new Date().toISOString(); await save(file, record);}
  }
  const script = (folder, name, args = [], timeout) =>
    stage(folder + '/' + name, () => run(path.join(__dirname, folder), name, args, timeout));
  let acquisition;
  try {
    log.step('1/4 Checking the console'); note('phase 1/4 console');
    await script('app', 'map');
    await script('app', 'inspect-mounts');
    if (appOnly) {
      const app = await script('app', 'qualify');
      check(app.verified && app.cleanedUp, 'Application worker qualification failed');
      let writeSizeProbe = null;
      if (process.env.NS2_WRITE_SIZE_PROBE === '1') {
        writeSizeProbe = await script('app', 'probe-write-size');
        check(writeSizeProbe.verified, 'Save write-size probe failed');
      }
      const result = {verified: true, cleanup: {cleanedUp: app.cleanedUp &&
        (writeSizeProbe ? writeSizeProbe.cleanedUp : true)}, qualification: app,
        writeSizeProbe, completed: new Date().toISOString()};
      await save(path.join(__dirname, 'app-qualification-current.json'), result);
      record.verified = true; record.result = result;
      return;
    }
    await stage('Remove exploit scratch from prior launches', () => require('./cleanup-scratch.cjs').main());
    const app = await script('app', 'qualify');
    check(app.verified && app.cleanedUp, 'Application worker qualification failed');
    log.step('2/4 Acquiring FS memory'); note('phase 2/4 FS acquisition');
    const startAcquisition = require('./acquire.cjs').start;
    const captureBytes = required(target.retainedCaptureBytes, `${target.name} retained capture size`);
    const holdsCapture = report =>
      Boolean(report.retainedMemory?.captures?.some(c => c.length === captureBytes));
    // The race can complete with a proved marker and still leave the retained
    // capture uninstalled. find-metadata's bootstrap rebuilds that link in ~17 s,
    // so try it before the alternative: retiring the healthy endpoint and racing
    // again, which costs ~175 s. Only if the cheap repair also misses do we spend
    // a second acquisition.
    await stage('FS read, write and restoration', async () => {
      acquisition = await startAcquisition();
      return {report: acquisition.report, proof: acquisition.proof};
    });
    log.step('3/4 Starting the native helper'); note('phase 3/4 native helper');
    // The probe does not install the retained capture; find-metadata's bootstrap
    // does. Run it after every acquisition, including a retried one - the retry
    // used to jump straight to install-retained and fail on a missing capture.
    const repairAttempts = 3;
    const ensureCapture = async () => {
      let captured = await read(acquisition.report);
      if (holdsCapture(captured)) return captured;
      // The pool capture is a fresh native read every attempt, so a link-less pool
      // is often a per-read miss: retry the ~6 s repair before spending a ~150 s
      // re-acquisition. A repair failure must never abort - the fallback is below.
      for (let attempt = 1; attempt <= repairAttempts; ++attempt) {
        note('acquisition landed without the retained capture; running the metadata repair'
          + (attempt > 1 ? ' (attempt ' + attempt + ')' : ''));
        try {
          await script('retained', 'find-metadata', [acquisition.supervisorReport]);
        } catch (error) {
          const message = error.message || String(error);
          note('metadata repair failed: ' + message);
          // Only a transient endpoint fault is worth re-reading: a pool capture
          // without native links is deterministic (37SJhs failed the same way
          // three times in a row), so the re-acquisition is the next step.
          if (!/timed out|was not replayed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/i.test(message))
            break;
          continue;
        }
        captured = await read(acquisition.report);
        if (holdsCapture(captured)) return captured;
      }
      return read(acquisition.report);
    };
    let captured = await ensureCapture();
    if (!holdsCapture(captured)) {
      note('metadata repair did not install the capture; retiring and re-acquiring');
      // The retire failure and the re-acquisition failure mean different things: the
      // first leaves the endpoint to the RO stages, the second ends the run. Only the
      // first is swallowed - BVz90B reported a failed acquisition as 'install-retained
      // failed' because this catch swallowed it.
      let retired = true;
      try {
        await stage('Retire the uncaptured endpoint', () => acquisition.retire());
      } catch (error) {
        retired = false;
        note('cannot retire this endpoint: ' + (error.message || error));
      }
      if (retired) {
        await stage('FS read, write and restoration (capture retry)', async () => {
          acquisition = await startAcquisition();
          return {report: acquisition.report, proof: acquisition.proof};
        });
        captured = await ensureCapture();
      }
    }
    await script('ro', 'install-retained');
    await stage('FS layout', () => require('./ro/layout.cjs').main());
    await stage('Owned FS root', () => require('./ro/objects.cjs').main('root'));
    await stage('Owned FS notifier', () => require('./ro/objects.cjs').main('notifier'));
    const layout = await read(local(a.session, '-layout.json'));
    const smOffset = required(target.smServiceOffset, `${target.name} SM service offset`);
    await script('ro', 'test-sm', [String(layout.sdk + smOffset)]);
    await script('ro', 'copy-loader-root', [String(layout.target.entry)]);
    await script('ro', 'prepare-workers');
    const donor = await stage('RO payload and current console policy', async () => {
      const memory = await connect(), sm = await read(local(a.session, '-sm-proof.json'));
      const monitor = await memory.request({command: 'root-native-sm-service', handle: sm.export.handle, name: 'pm:dmnt'});
      check(!monitor.result && !monitor.transport, 'PM monitor did not open');
      const loader = await read(local(a.session, '-loader-root-copy.json'));
      const code = await memory.request({command: 'root-native-code-open', handle: loader.copy.handle, title: programId(target)});
      check(!code.result, 'Native RO CodeFS did not open');
      for (const name of ['main.npdm', 'main'])
        await memory.request({command: 'root-native-file-capture', handle: code.handle, name});
      const result = await memory.request({command: 'root-native-donor-prepare'});
      check(result.ready && result.files.every(item => item.verified), 'The payload files did not verify');
      return result;
    });
    await script('ro', 'bind-sessions');
    await script('ro', 'prepare-event');
    const gate = await script('ro', 'test-gate');
    check(gate.verified && gate.restored, 'The native request gate did not qualify');
    const launch = await script('ro', 'launch', [], 300000);
    check(launch.imageAccepted && launch.restored && launch.pid, 'PM did not accept the payload');
    const activation = await stage('Start RO payload', () => runtime.activate(launch.file));
    const proof = await stage('RO instruction challenges', () => runtime.probe(activation.pid));
    const handoff = await stage('Restore Loader session', () => runtime.handoff());
    const payload = donor.files.find(item => item.name === 'main');
    check(payload.sha256 === hash(await fs.readFile(path.join(__dirname, 'ro/payload/main'))), 'Payload changed during launch');
    await save(runtime.executionFile, {verified: true, session: a.session, report: acquisition.report,
      pid: proof.pid, programId: programId(target).slice(2), payloadSha256: payload.sha256,
      proof: proof.file, launch: launch.file, identity: activation.file, handoff: handoff.file});
    log.step('4/4 Running the FS demo'); note('phase 4/4 FS demo');
    await script('process', 'bind-notifier');
    const mapping = await script('process', 'qualify');
    check(mapping.verified && mapping.cleanup?.finished, 'Native process mapping did not qualify and clean up');
    const execution = await stage('FS instruction challenges', () => require('./process/fs-execute.cjs').main());
    check(execution.verified && execution.restored, 'FS execution or restoration did not verify');
    if (dumpFirmware) {
      console.log('Firmware: beginning read-only system-program CodeFS capture');
      note('firmware dump');
      record.firmwareDump = await stage('Enumerate and capture installed system code',
        () => require('./firmware-dump.cjs').main(execution.file));
    }
    const donorCleanup = await stage('Remove RO donor files', async () => {
      const memory = await connect();
      const donor = await memory.request({command: 'root-native-donor-cleanup'});
      check(donor.cleanedUp, 'Donor files did not clean up');
      return donor;
    });
    if (holdRpc) {
      const held = {...execution, cleanup: {deferred: true, donor: donorCleanup},
        retainedEndpoint: {ready: true, session: a.session, socketPath: acquisition.socketPath},
        started: record.started};
      await save(path.join(__dirname, 'fs-execution-current.json'), held);
      record.hold = {state: 'ready', started: new Date().toISOString()};
      await save(file, record);
      const release = require('./hold.cjs').waitForRelease();
      process.send({type: 'held-ready', session: a.session});
      const reason = await release;
      record.hold = {...record.hold, state: 'releasing', reason, released: new Date().toISOString()};
      await save(file, record);
    }
    const cleanup = await stage('Release FS resources', async () =>
      ({...await acquisition.retire(), donor: donorCleanup}));
    const result = {...execution, cleanup, started: record.started, completed: new Date().toISOString()};
    await save(path.join(__dirname, 'fs-execution-current.json'), result);
    record.verified = true; record.result = result;
  } catch (error) {
    record.error = error.stack;
    if (acquisition) {
      try {
        const latest = await read(acquisition.report);
        // Before promotion, the acquisition still owns its original restoration
        // path. Later failures may have native state that needs a console reboot.
        if (!latest.nativeRo && !latest.retainedMemory?.promoted)
          record.failureCleanup = await acquisition.retire();
        else await acquisition.abandon();
      } catch (cleanupError) {
        record.cleanupError = cleanupError.stack;
        await acquisition.abandon();
      }
    }
    throw error;
  } finally {
    record.finished = new Date().toISOString();
    await save(file, record);
    // One closing block instead of a scattered line per stage: what ran, how long
    // it took, and whether the run is verified.
    const stages = record.stages.map(row => row.name + ' ' + (row.status === 'complete' ? 'ok' : 'FAILED'));
    log.summary({
      session: a.session,
      verified: record.verified ? 'yes' : 'NO' + (record.error ? ' - ' + record.error.split('\n')[0] : ''),
      stages: stages.filter((name, index) => stages.indexOf(name) === index).length + ' (' +
        stages.filter(name => name.endsWith('FAILED')).length + ' failed)',
      elapsed: ((log.elapsed() / 1000).toFixed(1)) + 's',
      report: file,
    });
  }
}

module.exports = {main};
if (require.main === module) main().catch(error => {console.error(error.stack); process.exitCode = 1;});
