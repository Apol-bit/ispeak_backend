const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

class StorageProvider {
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

function createStorageProvider() {
  const driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  if (driver === 'local') {
    return new LocalStorageProvider(process.env.LOCAL_STORAGE_ROOT || 'uploads');
  }
  throw new Error(
    `Unsupported STORAGE_DRIVER "${driver}". Add a provider adapter and its credentials before production deployment.`
  );
}

module.exports = {
  LocalStorageProvider,
  StorageProvider,
  storage: createStorageProvider(),
};
