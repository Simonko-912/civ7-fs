const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { a } = require('../shared/rpc.cjs');
const { request } = require('./tools/endpoint.cjs');
const { failureSummary } = require('./memory/wave-history.cjs');
const { verifyProof } = require('./memory/verify-proof.cjs');
const { save, read } = require('./ro/runtime.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function hasProvenCleanup(report, session, exited) {
  const retained = report?.retained;
  return exited?.signal == null && Number.isInteger(exited?.code) &&
    report?.session === session && report.cleanedUp === true &&
    !report.placementUncertain && !report.cleanupError && !failureSummary(report).retainResources &&
    !report.memoryControl?.ready && !report.memoryControl?.pending &&
    !report.retainedMemory?.pending && !retained?.cacheNeedsRestore &&
    retained?.base === 0 && Array.isArray(retained.handles) && retained.handles.length === 0 &&
    Array.isArray(retained.threads) && retained.threads.length === 0;
}

function canRetry(report, session, exited) {
  return report?.retryable !== false && hasProvenCleanup(report, session, exited);
}

// The acquisition owns native allocations until retire() completes.
async function start() {
  // A new probe is permitted only after the previous owner proves cleanup.
  const MAX_ATTEMPTS = 3;
  let lastError;
  const attempts = [];
  const supervisorReport = path.join(__dirname, 'acquisition-supervisor.json');
  const launch = Date.now() + '-' + process.pid;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; ++attempt) {
    const logFile = path.join(__dirname, 'acquisition-' + launch + '-' + (attempt + 1) + '.log');
    const log = fs.createWriteStream(logFile, { flags: 'wx', mode: 0o600 });
    await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
    const record = {attempt: attempt + 1, log: logFile, started: new Date().toISOString()};
    attempts.push(record);
    await save(supervisorReport, {stage: 'acquiring', attempts});
    const child = spawn(process.execPath, [path.join(__dirname, 'memory/probe-reserved-gap.cjs')],
      { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    let reportFile, exited, spawnError;
    child.once('error', error => { spawnError = error; });
    let logError;
    log.on('error', error => { logError = error; child.kill('SIGKILL'); });
    const done = new Promise(resolve => child.once('close', (code, signal) => {
      exited = { code, signal };
      if (log.destroyed) resolve(exited);
      else log.end(() => resolve(exited));
    }));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      let row;
      try { row = JSON.parse(line); } catch { return; }
      if (row.stage === 'connected') reportFile = row.file;
    });
    const abandon = async () => {
      if (!exited) child.kill('SIGKILL');
      await done;
    };
    try {
      const deadline = Date.now() + 10 * 60 * 1000;
      let report, recorded = false;
      for (; ;) {
        if (reportFile) {
          report = await read(reportFile);
          if (!recorded) {
            // Keep the scratch owner discoverable even if acquisition later fails.
            await save(path.join(__dirname, 'current-acquisition.json'), { session: a.session, report: reportFile });
            recorded = true;
          }
        }
        if (report?.memoryControl?.ready) break;
        if (exited || spawnError || Date.now() >= deadline) {
          // The probe stores a stack string, so its first line already reads
          // 'Error: ...'. Strip that prefix or every caller prints 'Error: Error: ...'.
          const reported = report?.error?.split('\n')[0].replace(/^Error:\s*/, '');
          throw Error(spawnError?.message || logError?.message || reported ||
            'FS acquisition exited or timed out before memory was ready');
        }
        await delay(500);
      }
      if (report.session !== a.session || report.error || report.cleanupError)
        throw Error('FS acquisition has an error or belongs to another session');
      const proof = await verifyProof(reportFile, a.session);
      record.report = reportFile;
      record.state = 'memory-ready';
      await save(supervisorReport, { stage: 'memory-ready', attempts });
      const current = {
        session: a.session, report: reportFile, supervisorReport,
        socketPath: report.memoryControl.socketPath, proof, finished: new Date().toISOString()
      };
      await save(path.join(__dirname, 'current-acquisition.json'), current);
      return {
        ...current, abandon,
        async retire() {
          const latest = await read(reportFile);
          const retained = latest.retainedMemory;
          if (!latest.memoryControl?.ready || latest.placementUncertain || retained?.pending ||
            latest.memoryControl.pending || latest.retained.threads.length ||
            retained?.promoted && (!retained.ready || !retained.canonical || !retained.zeroCountVerified))
            throw Error('The retained endpoint cannot be retired from its current state');
          const state = latest.nativeRo;
          if (state?.worker && !state.worker.joined) throw Error('A native worker is still pending');
          const result = await request(current.socketPath, { command: 'retire' });
          if (!result.retired && !result.retiring) throw Error('The retained endpoint did not retire');
          const deadline = Date.now() + 60000;
          while (!exited && Date.now() < deadline) await delay(100);
          if (!exited) throw Error('FS cleanup timed out; inspect ' + reportFile);
          const final = await read(reportFile);
          if (exited.code !== 0 || !final.cleanedUp || final.cleanupError)
            throw Error('FS resources did not clean up completely; inspect ' + reportFile);
          return { cleanedUp: true, report: reportFile };
        },
      };
    } catch (error) {
      await abandon();
      const final = reportFile ? await read(reportFile).catch(() => null) : null;
      const retry = !logError && canRetry(final, a.session, exited);
      record.report = reportFile || null;
      record.exit = exited;
      record.error = final?.error || error.stack;
      record.cleanedUp = final?.cleanedUp === true;
      record.placementUncertain = final?.placementUncertain === true;
      record.finished = new Date().toISOString();
      record.retryAllowed = retry;
      record.acquisitionProfile = final?.acquisitionProfile;
      record.allocationMismatch = final?.allocationMismatch;
      record.failureSummary = final ? failureSummary(final) : null;
      await save(supervisorReport, {stage: retry && attempt < MAX_ATTEMPTS - 1 ? 'retrying' : 'failed', attempts});
      // Keep the conventional latest log path while preserving every attempt.
      await fs.promises.copyFile(logFile, path.join(__dirname, 'acquisition.log'));
      const reason = (final?.error || error.message).split('\n')[0];
      if (record.failureSummary) console.log('Acquisition: ' + record.failureSummary.message);
      const configurationStopped = final?.retryable === false && hasProvenCleanup(final, a.session, exited);
      lastError = Error(reason + '. Inspect ' + logFile +
        (retry ? '; acquisition attempts exhausted.' : configurationStopped
          ? '; cleanup completed; configuration requires a new selection and fresh console boot.'
          : '; cleanup is unproven or placement is uncertain; restart the console before another launch.'));
      if (!retry) throw lastError;
    }
    if (attempt < MAX_ATTEMPTS - 1) await delay(1000);
  }
  throw lastError;
}

module.exports = { start, canRetry };
