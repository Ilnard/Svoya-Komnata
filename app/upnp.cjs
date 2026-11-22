const dgram = require('node:dgram');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomInt, randomBytes } = require('node:crypto');
const { join } = require('node:path');

const journalPath = join(__dirname, 'port-mapping.state.json');
const tag = (xml, name) => {
  const match = xml.match(new RegExp('<(?:[\\w-]+:)?' + name + '(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?' + name + '>'));
  return match?.[1]?.trim().replaceAll('&amp;', '&') || '';
};
function publicIPv4(ip) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const [a, b, c, d] = ip.split('.').map(Number);
  return [a,b,c,d].every(n => n <= 255) && a !== 0 && a !== 10 && a !== 127 && a < 224
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(3500) });
  let text = '';
  for await (const chunk of response.body) {
    text += Buffer.from(chunk).toString();
    if (text.length > 256_000) throw new Error('Слишком большой ответ роутера');
  }
  if (!response.ok || tag(text, 'errorCode')) {
    throw Object.assign(new Error('UPnP ' + (tag(text, 'errorCode') || response.status)), { code: tag(text, 'errorCode') });
  }
  return text;
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
class Gateway {
  constructor(info) { Object.assign(this, info); }
  async soap(action, args = {}) {
    return request(this.control, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"' + this.service + '#' + action + '"' },
      body: '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:' + action + ' xmlns:u="' + this.service + '">' +
        Object.entries(args).map(([key, value]) => '<' + key + '>' + escape(value) + '</' + key + '>').join('') +
        '</u:' + action + '></s:Body></s:Envelope>',
    });
  }
  mappingArgs() { return { NewRemoteHost: '', NewExternalPort: this.externalPort, NewProtocol: 'TCP' }; }
  async inspect() { return this.soap('GetSpecificPortMappingEntry', this.mappingArgs()); }
  async add() {
    return this.soap('AddPortMapping', {
      ...this.mappingArgs(), NewInternalPort: this.internalPort, NewInternalClient: this.localAddress,
      NewEnabled: 1, NewPortMappingDescription: this.description, NewLeaseDuration: this.lease,
    });
  }
  async remove() {
    const entry = await this.inspect();
    if (tag(entry, 'NewPortMappingDescription') === this.description &&
        tag(entry, 'NewInternalClient') === this.localAddress &&
        Number(tag(entry, 'NewInternalPort')) === this.internalPort) {
      await this.soap('DeletePortMapping', this.mappingArgs());
    }
  }
}
async function discover() {
  const interfaces = Object.values(os.networkInterfaces()).flat().filter(item => item.family === 'IPv4' && !item.internal);
  const devices = new Map();
  await Promise.all(interfaces.map(iface => new Promise(resolve => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => { socket.close(); resolve(); }, 3000);
    socket.on('error', () => { clearTimeout(timer); socket.close(); resolve(); });
    socket.on('message', (buffer, remote) => {
      const location = buffer.toString().match(/^location:\s*(.+)$/im)?.[1]?.trim();
      if (!location) return;
      try {
        const url = new URL(location);
        // Only contact the local device that sent this discovery response.
        if (url.protocol === 'http:' && url.hostname === remote.address) devices.set(location, iface.address);
      } catch {}
    });
    socket.bind(0, iface.address, () => {
      socket.setMulticastTTL(2);
      socket.setMulticastInterface(iface.address);
      for (const type of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1']) {
        const message = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ' + type + '\r\n\r\n';
        socket.send(message, 1900, '239.255.255.250');
      }
    });
  })));
  const gateways = [];
  for (const [location, localAddress] of devices) {
    try {
      const xml = await request(location);
      for (const serviceXml of xml.match(/<(?:[\w-]+:)?service>[\s\S]*?<\/(?:[\w-]+:)?service>/g) || []) {
        const service = tag(serviceXml, 'serviceType');
        if (!/^urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:[12]$/.test(service)) continue;
        const control = new URL(tag(serviceXml, 'controlURL'), tag(xml, 'URLBase') || location);
        if (control.protocol !== 'http:' || control.hostname !== new URL(location).hostname) continue;
        gateways.push(new Gateway({ control: control.href, service, localAddress }));
      }
    } catch {}
  }
  return gateways;
}
async function recover() {
  try {
    const previous = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    await new Gateway(previous).remove();
    await fs.unlink(journalPath);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== '714') return false;
  }
  return true;
}
async function openMapping(internalPort, onFailure, gateways) {
  if (!await recover()) throw new Error('Не удалось удалить прежнее правило UPnP. Проверь роутер и повтори запуск.');
  gateways ??= await discover();
  if (!gateways.length) throw new Error('Роутер с UPnP не найден. Включи UPnP в настройках роутера. Интернет-комната не создана.');
  let lastError;
  for (const gateway of gateways) {
    try {
      gateway.externalAddress = tag(await gateway.soap('GetExternalIPAddress'), 'NewExternalIPAddress');
      if (!publicIPv4(gateway.externalAddress)) throw new Error('Роутер получил непубличный IPv4. Возможен CGNAT или второй роутер. Нужен публичный IPv4 у хоста.');
      gateway.internalPort = internalPort;
      gateway.description = 'SvoyaKomnata-' + randomBytes(8).toString('hex');
      gateway.lease = 120;
      let available = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        gateway.externalPort = randomInt(49152, 65535);
        try { await gateway.inspect(); } catch (error) {
          if (error.code !== '714') throw error;
          available = true;
          break;
        }
      }
      if (!available) throw new Error('Не найден свободный внешний TCP-порт.');
      // Journal first, so a crash during AddPortMapping can be recovered next time.
      await fs.writeFile(journalPath, JSON.stringify(gateway), { mode: 0o600 });
      try { await gateway.add(); } catch (error) {
        if (error.code !== '725') throw error;
        gateway.lease = 0;
        await fs.writeFile(journalPath, JSON.stringify(gateway), { mode: 0o600 });
        await gateway.add();
      }
      const entry = await gateway.inspect();
      if (tag(entry, 'NewInternalClient') !== gateway.localAddress || Number(tag(entry, 'NewInternalPort')) !== internalPort ||
          tag(entry, 'NewPortMappingDescription') !== gateway.description || tag(entry, 'NewEnabled') !== '1') {
        throw new Error('Роутер не подтвердил открытие порта.');
      }
      let closed = false;
      let renewal;
      let renewalWork = Promise.resolve();
      const close = async () => {
        closed = true;
        clearTimeout(renewal);
        await renewalWork;
        try { await gateway.remove(); await fs.unlink(journalPath); }
        catch (error) { if (error.code === '714') await fs.unlink(journalPath).catch(() => {}); }
      };
      const renew = async () => {
        try {
          if (tag(await gateway.soap('GetExternalIPAddress'), 'NewExternalIPAddress') !== gateway.externalAddress) throw new Error('Внешний IP роутера изменился. Создай комнату заново.');
          let current;
          try { current = await gateway.inspect(); }
          catch (error) {
            if (error.code !== '714' || closed) throw error;
            await gateway.add();
            current = await gateway.inspect();
          }
          if (tag(current, 'NewPortMappingDescription') !== gateway.description) throw new Error('Правило UPnP исчезло или было заменено.');
          if (closed) return;
          if (gateway.lease) await gateway.add();
          onFailure('');
        } catch (error) {
          onFailure('Порт комнаты стал недоступен. ' + error.message);
        }
        if (!closed) renewal = setTimeout(() => { renewalWork = renew(); }, 40_000);
      };
      renewal = setTimeout(() => { renewalWork = renew(); }, 40_000);
      return { address: gateway.externalAddress, port: gateway.externalPort, close };
    } catch (error) {
      lastError = error;
      if (gateway.description) {
        try {
          await gateway.remove();
          await fs.unlink(journalPath).catch(() => {});
        } catch (cleanupError) {
          if (cleanupError.code === '714') await fs.unlink(journalPath).catch(() => {});
          else throw new Error('Не удалось подтвердить удаление правила UPnP. Перезапусти приложение для повторной очистки. ' + error.message);
        }
      }
    }
  }
  throw new Error('Не удалось открыть внешний порт. ' + (lastError?.message || 'Проверь UPnP и настройки роутера.'));
}
module.exports = { openMapping, recover, Gateway, publicIPv4, tag };
