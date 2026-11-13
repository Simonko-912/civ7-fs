// Push the console-side bridge to the Remote JS Loader, and tell the caller
// which local address the console can reach us on.
const fs = require('node:fs/promises');
const net = require('node:net');
const dgram = require('node:dgram');
const path = require('node:path');

const BRIDGE_FILE = path.join(__dirname, '../../bridge/payload.js');
const LOADER_PORT = 9026;

function injectAddress(source, pcIp) {
  if (!net.isIPv4(pcIp)) throw Error('Not an IPv4 address to inject: ' + pcIp);
  const match = /PC_IP:\s*'[^']*'/.exec(source);
  if (!match) throw Error('payload.js has no PC_IP entry to fill in');
  return source.slice(0, match.index) + `PC_IP: '${pcIp}'` + source.slice(match.index + match[0].length);
}

// The kernel picks the source address for this route; a connected UDP socket
// sends nothing.
function localAddressFor(consoleIp, port = LOADER_PORT) {
  return new Promise((resolve, reject) => {
    if (!net.isIPv4(consoleIp)) return reject(Error('Not an IPv4 console address: ' + consoleIp));
    const probe = dgram.createSocket('udp4');
    probe.once('error', error => {probe.close(); reject(error);});
    probe.connect(port, consoleIp, () => {
      const {address} = probe.address();
      probe.close();
      resolve(address);
    });
  });
}

// One outbound connection: send the payload, half-close, then stream the
// console log lines that fan out from it. The loader keeps the eval alive for
// the whole session, so this stays open until the bridge finishes.
async function sendBridge({console: consoleIp, consolePort = LOADER_PORT, pcIp, log = console.log}) {
  const source = injectAddress(await fs.readFile(BRIDGE_FILE, 'utf8'), pcIp);
  const socket = net.createConnection({host: consoleIp, port: consolePort});
  let pending = '';
  socket.setEncoding('utf8');
  socket.setTimeout(3600 * 1000, () => socket.destroy(Error('No console log for an hour')));
  socket.on('data', chunk => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      log(pending.slice(0, index));
      pending = pending.slice(index + 1);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', resolve);
  });
  await new Promise((resolve, reject) => {
    socket.write(source, error => error ? reject(error) : resolve());
  });
  socket.end(() => {if (pending.trim()) log(pending);});
  return {bytes: Buffer.byteLength(source), finished: new Promise(resolve => socket.once('close', resolve))};
}

module.exports = {BRIDGE_FILE, LOADER_PORT, injectAddress, localAddressFor, sendBridge};
