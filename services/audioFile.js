const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
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

function wavMetadata(header, totalBytes) {
  if (header.length < 12 || header.subarray(0, 4).toString() !== 'RIFF'
    || header.subarray(8, 12).toString() !== 'WAVE') return {};
  let offset = 12; let sampleRate; let channels; let bitsPerSample; let dataBytes;
  while (offset + 8 <= header.length) {
    const type = header.subarray(offset, offset + 4).toString();
    const size = header.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (type === 'fmt ' && size >= 16 && body + 16 <= header.length) {
      channels = header.readUInt16LE(body + 2);
      sampleRate = header.readUInt32LE(body + 4);
      bitsPerSample = header.readUInt16LE(body + 14);
    } else if (type === 'data') {
      dataBytes = Math.min(size, Math.max(0, totalBytes - body));
      break;
    }
    offset = body + size + (size % 2);
  }
  const bytesPerSecond = sampleRate && channels && bitsPerSample
    ? sampleRate * channels * bitsPerSample / 8 : 0;
  return {
    sampleRate: sampleRate || null,
    channels: channels || null,
    bitsPerSample: bitsPerSample || null,
    durationSeconds: bytesPerSecond && Number.isFinite(dataBytes)
      ? dataBytes / bytesPerSecond : null,
  };
}

async function audioTransportMetadata(filePath) {
  const stat = await fs.promises.stat(filePath);
  const header = Buffer.alloc(Math.min(stat.size, 64 * 1024));
  const file = await fs.promises.open(filePath, 'r');
  try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
  const digest = createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(filePath)
    .on('data', chunk => digest.update(chunk)).on('end', resolve).on('error', reject));
  const extension = path.extname(filePath).toLowerCase();
  return {
    sha256: digest.digest('hex'),
    bytes: stat.size,
    extension,
    contentType: AUDIO_TYPES[extension] || 'application/octet-stream',
    ...wavMetadata(header, stat.size),
  };
}

module.exports = { AUDIO_TYPES, MAX_AUDIO_BYTES, inspectAudio, validateAudioHeader,
  audioTransportMetadata, wavMetadata };
