const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function downloadInstaller(asset, directory, progress) {
  const folder = await fs.promises.mkdtemp(path.join(directory, 'SvoyaKomnata-update-'));
  const installer = path.join(folder, asset.name);
  try {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!response.ok) throw Error('GitHub: HTTP ' + response.status);
    const hash = createHash('sha256');
    let received = 0, previous = -1;
    const meter = new Transform({
      transform(chunk, encoding, done) {
        received += chunk.length;
        if (received > asset.size) return done(Error('Размер установщика отличается от указанного в релизе.'));
        hash.update(chunk);
        const percent = Math.floor(received * 100 / asset.size);
        if (percent !== previous) progress(percent);
        previous = percent;
        done(null, chunk);
      }
    });
    await pipeline(response.body, meter, fs.createWriteStream(installer, { flags: 'wx' }));
    if (received !== asset.size || 'sha256:' + hash.digest('hex') !== asset.digest)
      throw Error('Файл не прошёл проверку целостности.');
    return installer;
  } catch (error) {
    await fs.promises.rm(folder, { recursive: true, force: true });
    throw error;
  }
}
module.exports = { downloadInstaller };
