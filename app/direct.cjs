const https = require('node:https');
const dgram = require('node:dgram');
const { generateKeyPairSync, randomBytes, X509Certificate } = require('node:crypto');
const forge = require('node-forge');
const { WebSocket, WebSocketServer } = require('ws');
const upnp = require('./upnp.cjs');

function canForwardMedia(socket, packet, offset = 0) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  // RTP and RTCP share this tunnel. Keep room for clock reports when video fills the queue.
  const rtcp = packet.length >= offset + 8 && (packet[offset] >> 6) === 2 &&
    packet[offset + 1] >= 192 && packet[offset + 1] <= 223;
  return socket.bufferedAmount + packet.length < 128 * 1024 + (rtcp ? 8192 : 0);
}

function identity() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  cert.serialNumber = '01' + randomBytes(15).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 7 * 86400_000);
  cert.setSubject([{ name: 'commonName', value: 'SvoyaKomnata' }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true }]);
  cert.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
  return { key: keys.privateKey, cert: forge.pki.certificateToPem(cert) };
}
function parseInvite(code) {
  try {
    if (typeof code !== 'string' || code.length > 6000 || !code.startsWith('SK1.')) throw Error();
    const data = JSON.parse(Buffer.from(code.slice(4), 'base64url').toString());
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(data.address) || data.address.split('.').some(part => Number(part) > 255 || String(Number(part)) !== part) ||
        !Number.isInteger(data.port) || data.port < 1 || data.port > 65535 ||
        !/^[a-f0-9]{36}$/.test(data.key) || typeof data.cert !== 'string' || data.cert.length > 3000) throw Error();
    new X509Certificate(data.cert);
    return data;
  } catch { throw new Error('Приглашение повреждено. Скопируй весь код SK1. целиком.'); }
}
const encodeInvite = data => 'SK1.' + Buffer.from(JSON.stringify(data)).toString('base64url');
function tlsOptions(endpoint) {
  // The invitation pins a per-room self-signed certificate. Chain verification stays enabled.
  return { ca: endpoint.cert, checkServerIdentity: () => undefined, minVersion: 'TLSv1.2' };
}
function remoteCommand(endpoint, data) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: endpoint.address, port: endpoint.port, path: '/room', method: 'POST',
      ...tlsOptions(endpoint), signal:AbortSignal.timeout(data.op==='poll'?2000:7000), headers: { 'Content-Type': 'application/json' },
    }, response => {
      let text = '';
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 500_000) request.destroy(new Error('Слишком большой ответ хоста'));
      });
      response.on('end', () => {
        try {
          const result = JSON.parse(text);
          if (response.statusCode !== 200) reject(Object.assign(new Error(result.error), { status: response.statusCode }));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(7000, () => request.destroy(new Error('Хост недоступен. Проверь интернет, брандмауэр хоста и действительность приглашения.')));
    request.on('error', reject);
    request.end(JSON.stringify(data));
  });
}
async function startHost({ command, authorize, readBody, answer, onFailure }) {
  const cert = identity();
  const sockets = new Map();
  const server = https.createServer({ ...cert, minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      if (req.url !== '/room' || req.method !== 'POST') return answer(res, { error: 'Недоступно' }, 404);
      answer(res, command(await readBody(req),false,req.socket.remoteAddress));
    } catch (error) { answer(res, { error: error.message }, error.status || 400); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 66_000, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.url !== '/media') throw Error();
      const auth = JSON.parse(Buffer.from(req.headers['x-room-auth'] || '', 'base64url').toString());
      authorize(auth);
      wsServer.handleUpgrade(req, socket, head, ws => {
        sockets.get(auth.id)?.close();
        sockets.set(auth.id, ws);
        ws.on('error', () => {});
        ws.on('message', (packet, binary) => {
          try { authorize(auth); } catch { ws.close(); return; }
          if (!binary || packet.length <= 36) return;
          const peerId = packet.subarray(0, 36).toString();
          if (peerId === auth.id) return;
          const destination = sockets.get(peerId);
          if (canForwardMedia(destination, packet, 36)) {
            destination.send(Buffer.concat([Buffer.from(auth.id), packet.subarray(36)]));
          }
        });
        ws.on('close', () => { if (sockets.get(auth.id) === ws) sockets.delete(auth.id); });
      });
    } catch { socket.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  let mapping;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const ws of sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ closed: true }));
      ws.close();
      setTimeout(() => ws.terminate(), 500).unref();
    }
    wsServer.close();
    server.close();
    server.closeAllConnections();
    await mapping?.close();
  }
  try {
    mapping = await upnp.openMapping(server.address().port, message => { onFailure(message); });
  } catch (error) { await close(); throw error; }
  return {
    endpoint: { address: mapping.address, port: mapping.port, cert: cert.cert },
    localEndpoint: { address: '127.0.0.1', port: server.address().port, cert: cert.cert },
    close,
    drop: id => { sockets.get(id)?.terminate(); },
  };
}
class MediaBridge {
  constructor(endpoint, credentials) {
    this.endpoint = endpoint;
    this.credentials = credentials;
    this.peers = new Map();
    this.closed = false;
    this.touched = Date.now();
    this.connect();
  }
  connect() {
    if (this.closed) return;
    this.ws = new WebSocket('wss://' + this.endpoint.address + ':' + this.endpoint.port + '/media', {
      ...tlsOptions(this.endpoint), headers: { 'X-Room-Auth': Buffer.from(JSON.stringify(this.credentials)).toString('base64url') },
      handshakeTimeout: 2500, maxPayload: 66_000, perMessageDeflate: false,
    });
    const socket = this.ws;
    let alive = true;
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 1200);
    socket.on('pong', () => { alive = true; });
    socket.once('close', () => clearInterval(heartbeat));
    this.ws.on('error', () => {});
    this.ws.on('message', (packet, binary) => {
      if (!binary) {
        try {
          if (JSON.parse(packet.toString()).closed) { this.hostClosed = true; this.close(); }
        } catch {}
        return;
      }
      const peer = this.peers.get(packet.subarray(0, 36).toString());
      if (peer?.browserPort) peer.socket.send(packet.subarray(36), peer.browserPort, '127.0.0.1', () => {});
    });
    this.ws.on('close', () => { if (!this.closed && this.ws===socket) this.retry = setTimeout(() => this.connect(), 200); });
  }
  reconnect() {
    if(this.closed)return;
    clearTimeout(this.retry);
    const old=this.ws;
    this.connect();
    old.terminate();
  }
  async peer(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Некорректный участник');
    if (this.peers.has(id)) return this.peers.get(id).ready;
    if (this.peers.size >= 7) throw new Error('Превышено число участников');
    const socket = dgram.createSocket('udp4');
    const peer = { socket };
    this.peers.set(id, peer);
    socket.on('message', (packet, remote) => {
      if (remote.address !== '127.0.0.1') return;
      peer.browserPort = remote.port;
      if (canForwardMedia(this.ws, packet)) {
        this.ws.send(Buffer.concat([Buffer.from(id), packet]));
      }
    });
    peer.ready = new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.bind(0, '127.0.0.1', () => resolve(socket.address().port));
    });
    return peer.ready;
  }
  remove(id) {
    this.peers.get(id)?.socket.close();
    this.peers.delete(id);
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws.terminate();
    for (const id of this.peers.keys()) this.remove(id);
  }
}
module.exports = { startHost, MediaBridge, remoteCommand, parseInvite, encodeInvite };
