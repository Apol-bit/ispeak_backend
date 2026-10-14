// Never retain an SDK error/cause: it can contain signed requests or credentials.
class StorageError extends Error {
  constructor(operation, status = 503) {
    super(status === 404 ? 'Stored audio was not found.' : 'Audio storage is temporarily unavailable. Please try again.');
    this.name = 'StorageError';
    this.code = `STORAGE_${operation.toUpperCase()}`;
    this.status = status;
  }
}

class AudioFileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AudioFileError';
    this.status = status;
  }
}

function storageFailure(res, error) {
  if (!(error instanceof StorageError || error instanceof AudioFileError)) return false;
  res.status(error.status).json({ message: error.message });
  return true;
}

module.exports = { StorageError, AudioFileError, storageFailure };
