// Error names/codes are allowlisted: messages, stacks, causes and payloads may
// contain URIs, duplicate values, request headers or cloud credentials.
const names = new Set(['Error', 'TypeError', 'ValidationError', 'CastError',
  'MongoServerError', 'MongoNetworkError', 'MongoServerSelectionError',
  'MongooseServerSelectionError', 'MongooseError', 'StorageError', 'AudioFileError']);
const codes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EADDRINUSE', 'EACCES', 'ENOENT', 'ERR_SERVER_NOT_RUNNING']);
function logError(event, error) {
  const details = { event, category: names.has(error?.name) ? error.name : 'Error' };
  if ([11000, 50, 13, 18, 121].includes(error?.code) || codes.has(error?.code)) details.code = error.code;
  console.error(JSON.stringify(details));
}
module.exports = { logError };
