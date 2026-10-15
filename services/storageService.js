const fs = require('fs');
const path = require('path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { StorageError, AudioFileError } = require('./storageErrors');
const { inspectAudio, MAX_AUDIO_BYTES, validateAudioHeader } = require('./audioFile');
const { readOnlyStartup } = require('./readOnlyStartup');

const projectRoot = path.resolve(__dirname, '..');

class StorageProvider {
  createKey() { throw new Error('Storage provider must implement createKey'); }
  async storeFile() { throw new Error('Storage provider must implement storeFile'); }
  getUploadDirectory() {
    throw new Error('Storage provider does not support direct uploads');
  }

  toKey() {
    throw new Error('Storage provider must implement toKey');
  }

  openReadStream() {
    throw new Error('Storage provider must implement openReadStream');
  }

  async delete() {
    throw new Error('Storage provider must implement delete');
  }
}

class LocalStorageProvider extends StorageProvider {
  constructor(rootDirectory) {
    super();
    this.root = path.resolve(projectRoot, rootDirectory || 'uploads');
    this.driver = 'local';
    this.namespace = `local:${this.root}`;
    this.temporaryUploads = false;
    this.referenceRoot = path.join(this.root, 'reference_audio');
    fs.mkdirSync(this.referenceRoot, { recursive: true });
  }

  getUploadDirectory(category = 'recordings') {
    const directory = category === 'reference_audio' ? this.referenceRoot : this.root;
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  toKey(filePath) {
    const absolute = path.resolve(filePath);
    this.#assertInsideRoot(absolute);
    return path.relative(projectRoot, absolute).replace(/\\/g, '/');
  }

  resolve(key) {
    const absolute = path.isAbsolute(key) ? path.resolve(key) : path.resolve(projectRoot, key);
    this.#assertInsideRoot(absolute);
    return absolute;
  }

  openReadStream(key) {
    return fs.createReadStream(this.resolve(key));
  }

  createKey(filePath) { return this.toKey(filePath); }

  async storeFile(filePath) { return this.toKey(filePath); }

  async delete(key) {
    if (!key) return;
    const absolute = this.resolve(key);
    await fs.promises.rm(absolute, { force: true });
  }

  #assertInsideRoot(absolute) {
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Storage key resolves outside the configured storage root');
    }
  }
}

function testPrefix(value = '') {
  if (value !== '' && !/^deployment-tests\/[a-f0-9]{32}\/$/.test(value)) {
    throw new Error('Invalid R2_TEST_PREFIX: expected deployment-tests/<32 lowercase hex run ID>/');
  }
  return value;
}

function r2Configuration(env) {
  const required = ['R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  if (!env.R2_ENDPOINT && !env.R2_ACCOUNT_ID) required.push('R2_ACCOUNT_ID or R2_ENDPOINT');
  const missing = required.filter(name => !env[name]);
  if (missing.length) throw new Error(`Missing R2 configuration: ${missing.join(', ')}`);
  if (env.R2_ACCOUNT_ID && !/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID)) throw new Error('Invalid R2_ACCOUNT_ID');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET)) throw new Error('Invalid R2_BUCKET');
  let endpoint;
  try { endpoint = new URL(env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`); }
  catch { throw new Error('Invalid R2_ENDPOINT'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== '/' || endpoint.port || !/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname)) {
    throw new Error('R2_ENDPOINT must be an HTTPS Cloudflare R2 S3 endpoint without credentials or a path');
  }
  return { testPrefix: testPrefix(env.R2_TEST_PREFIX), endpoint: endpoint.origin, bucket: env.R2_BUCKET, region: env.R2_REGION || 'auto',
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } };
}

class R2StorageProvider extends StorageProvider {
  constructor(config, { client, tempRoot } = {}) {
    super();
    const { S3Client } = require('@aws-sdk/client-s3');
    this.driver = 'r2';
    this.temporaryUploads = true;
    this.bucket = config.bucket;
    this.testPrefix = testPrefix(config.testPrefix);
    this.namespace = `r2:${config.endpoint}/${config.bucket}${this.testPrefix ? `/${this.testPrefix}` : ''}`;
    this.client = client || new S3Client({
      endpoint: config.endpoint, region: config.region, credentials: config.credentials,
      maxAttempts: 3, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
    // Only processing scratch space; never a canonical Mongo audio path.
    this.tempRoot = tempRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-audio-'));
  }

  getUploadDirectory(category = 'recordings') {
    const directory = path.join(this.tempRoot, category === 'reference_audio' ? 'reference_audio' : 'recordings');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  createKey(filePath, { category = 'recordings', ownerId } = {}) {
    if (!/^[a-f0-9]{24}$/i.test(String(ownerId))) throw new AudioFileError('Invalid audio owner identifier.');
    const prefix = category === 'reference_audio' ? 'reference-audio' : 'recordings';
    const key = `${this.testPrefix}${prefix}/${String(ownerId).toLowerCase()}/${randomUUID()}${path.extname(filePath).toLowerCase()}`;
    this.assertKey(key);
    return key;
  }

  assertKey(key) {
    if (typeof key !== 'string' || !key.startsWith(this.testPrefix) || !/^(?:recordings|reference-audio)\/[a-f0-9]{24}\/[a-f0-9-]{36}\.(?:wav|mp3|m4a|aac|flac|ogg)$/.test(key.slice(this.testPrefix.length))) {
      throw new StorageError('key');
    }
  }

  async storeFile(filePath, { key } = {}) {
    if (readOnlyStartup()) throw new StorageError('read_only');
    this.assertKey(key);
    const { contentType, size, extension } = await inspectAudio(filePath);
    if (path.posix.extname(key) !== extension) throw new AudioFileError('Audio key and file type do not match.');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const body = await fs.promises.readFile(filePath);
      if (body.length !== size || body.length > MAX_AUDIO_BYTES) throw new StorageError('upload');
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key,
        Body: body, ContentLength: body.length, ContentType: contentType }), { abortSignal: AbortSignal.timeout(60_000) });
      return key;
    } catch { throw new StorageError('upload'); }
  }

  async openReadStream(key) {
    this.assertKey(key);
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    let body;
    const signal = AbortSignal.timeout(60_000);
    const abort = () => body?.destroy(new StorageError('read'));
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
      body = object.Body;
      if (!body || object.ContentLength > MAX_AUDIO_BYTES) throw new StorageError('read');
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) throw new StorageError('read');
      const chunks = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > MAX_AUDIO_BYTES) throw new StorageError('read');
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      if (object.ContentLength != null && size !== object.ContentLength) throw new StorageError('read');
      validateAudioHeader(buffer.subarray(0, 16), path.posix.extname(key));
      // Finish the bounded R2 download BEFORE contacting Python, so a late
      // storage stream failure cannot be mislabeled as a Python outage.
      const stream = Readable.from(buffer);
      stream.audioLength = buffer.length;
      return stream;
    } catch (error) {
      throw new StorageError('read', error?.name === 'NoSuchKey' ? 404 : 503);
    } finally {
      signal.removeEventListener('abort', abort);
      body?.destroy();
    }
  }

  async delete(key) {
    if (!key) return;
    if (readOnlyStartup()) throw new StorageError('read_only');
    this.assertKey(key);
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (error?.name !== 'NoSuchKey') throw new StorageError('delete');
    }
  }
}

function createStorageProvider(env = process.env) {
  const driver = (env.STORAGE_DRIVER || 'local').toLowerCase();
  if (driver === 'local') {
    return new LocalStorageProvider(env.LOCAL_STORAGE_ROOT || 'uploads');
  }
  if (driver === 'r2') return new R2StorageProvider(r2Configuration(env));
  throw new Error(
    `Unsupported STORAGE_DRIVER "${driver}". Add a provider adapter and its credentials before production deployment.`
  );
}

module.exports = {
  LocalStorageProvider,
  R2StorageProvider,
  r2Configuration,
  createStorageProvider,
  StorageProvider,
  storage: createStorageProvider(),
};
