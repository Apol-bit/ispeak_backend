const fs = require('node:fs');
const path = require('node:path');
const { AudioFileError, StorageError } = require('./storageErrors');

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_TYPES = Object.freeze({
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
});

// Container signatures complement Python's actual decode/speech validation.
// Do not add WebM here: the current Python service does not accept it.
function validateAudioHeader(header, extension) {
  const sync = header.length >= 2 && header[0] === 0xff;
  const valid = {
    '.wav': header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WAVE',
    '.mp3': header.subarray(0, 3).toString() === 'ID3' || (sync && (header[1] & 0xe0) === 0xe0),
    '.m4a': header.subarray(4, 8).toString() === 'ftyp',
    '.aac': sync && (header[1] & 0xf0) === 0xf0,
    '.flac': header.subarray(0, 4).toString() === 'fLaC',
    '.ogg': header.subarray(0, 4).toString() === 'OggS',
  }[extension];
  if (!valid) throw new AudioFileError('File content does not match a supported audio type.');
  return AUDIO_TYPES[extension];
}

async function inspectAudio(filePath) {
  let file;
  try {
    file = await fs.promises.open(filePath, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size) throw new AudioFileError('Audio file is empty or invalid.');
    if (stat.size > MAX_AUDIO_BYTES) throw new AudioFileError('Audio exceeds the 25 MiB limit.', 413);
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const extension = path.extname(filePath).toLowerCase();
    return { size: stat.size, extension, contentType: validateAudioHeader(header.subarray(0, bytesRead), extension) };
  } catch (error) {
    if (error instanceof AudioFileError) throw error;
    throw new StorageError('local_read');
  } finally {
    await file?.close();
  }
}

module.exports = { AUDIO_TYPES, MAX_AUDIO_BYTES, inspectAudio, validateAudioHeader };
