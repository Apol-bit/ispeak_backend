const { isIP } = require('node:net');
function proxyTrust(value = '') {
  if (!value.trim()) return false;
  const entries = value.split(',').map(item => item.trim());
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined || (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error('TRUST_PROXY_CIDRS must contain explicit IP addresses or nonzero CIDRs');
    }
  }
  return entries;
}
function validateProductionOrigins(origins) {
  if (!origins.length) throw new Error('CORS_ORIGINS is required when NODE_ENV=production');
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('Production CORS_ORIGINS must contain exact HTTPS origins'); }
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || origin.includes('*')) {
      throw new Error('Production CORS_ORIGINS must contain exact HTTPS origins');
    }
  }
}
function validateDatabaseTls(uri) {
  // The driver's parser supports SRV and multi-host replica-set URIs. This
  // constructs no connection and performs no DNS/network operation.
  let options;
  try { options = new (require('mongoose').mongo.MongoClient)(uri).options; }
  catch { throw new Error('MONGO_URI must be a valid MongoDB URI'); }
  // The driver normalizes certificate/hostname bypass flags to Node TLS options.
  if (options.tls !== true || options.tlsInsecure || options.rejectUnauthorized === false ||
      typeof options.checkServerIdentity === 'function') {
    throw new Error('Production MONGO_URI requires TLS and certificate verification');
  }
}
module.exports = { proxyTrust, validateProductionOrigins, validateDatabaseTls };
