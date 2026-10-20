// Validate presence, not speech quality; Python retains content validation.
function isUsableTranscript(value) {
  return typeof value === 'string' && value.trim().length > 0
    && !/^no transcription available\.?$/i.test(value.trim());
}

module.exports = { isUsableTranscript };
