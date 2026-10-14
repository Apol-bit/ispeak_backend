const { Readable } = require('node:stream');

const wav = () => {
  const b = Buffer.alloc(364);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(320, 40);
  return b;
};

function fakeR2() {
  const objects = new Map();
  const calls = [];
  const state = { fail: '', ambiguousPut: false, brokenRead: false };
  return { objects, calls, state, async send(command) {
    const operation = command.constructor.name;
    const { Key, Body, ContentType } = command.input;
    calls.push({ operation, input: command.input });
    if (operation === 'PutObjectCommand' && state.ambiguousPut) objects.set(Key, { body: Buffer.from(Body), contentType: ContentType });
    if (state.fail === operation || (operation === 'PutObjectCommand' && state.ambiguousPut)) {
      throw new Error('secret-access-key SignedRequest Authorization credential SHOULD_NOT_LEAK');
    }
    if (operation === 'PutObjectCommand') objects.set(Key, { body: Buffer.from(Body), contentType: ContentType });
    if (operation === 'DeleteObjectCommand') objects.delete(Key);
    if (operation === 'GetObjectCommand') {
      if (!objects.has(Key)) throw Object.assign(new Error('sensitive missing path'), { name: 'NoSuchKey' });
      const object = objects.get(Key);
      const Body = state.brokenRead ? Readable.from((async function* () { yield Buffer.from('RIFF'); throw new Error('SHOULD_NOT_LEAK'); })()) : Readable.from(object.body);
      return { Body, ContentLength: object.body.length, ContentType: object.contentType };
    }
    return {};
  } };
}

function fakeJobs() {
  const rows = new Map();
  const state = { failWrite: false };
  const id = filter => filter.namespace + '|' + filter.key;
  return { rows, state,
    async updateOne(filter, update, options = {}) {
      if (state.failWrite) throw new Error('database unavailable');
      let row = rows.get(id(filter));
      if (!row && options.upsert) { row = { ...update.$setOnInsert }; rows.set(id(filter), row); }
      if (row) {
        Object.assign(row, update.$set);
        if (update.$inc?.attempts) row.attempts += update.$inc.attempts;
      }
    },
    async deleteOne(filter) {
      if (state.failWrite) throw new Error('database unavailable');
      if (!filter.purpose || rows.get(id(filter))?.purpose === filter.purpose) rows.delete(id(filter));
    },
    find(filter) { return { sort() { return this; }, limit(count) { this.count = count; return this; },
      async lean() { return [...rows.values()].filter(row => row.namespace === filter.namespace && row.nextAttemptAt <= filter.nextAttemptAt.$lte).slice(0, this.count); } }; },
  };
}

const config = { endpoint: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com', bucket: 'test-audio', region: 'auto', credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' } };
const ownerId = '507f1f77bcf86cd799439011';
module.exports = { wav, fakeR2, fakeJobs, config, ownerId };
