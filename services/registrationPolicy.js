const { createHash, timingSafeEqual } = require('node:crypto');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readRegistrationPolicy(env = process.env) {
  const mode = env.REGISTRATION_MODE === undefined
    ? (env.NODE_ENV === 'production' ? undefined : 'open')
    : env.REGISTRATION_MODE;
  if (!['open', 'invite', 'closed'].includes(mode)) {
    throw new Error('REGISTRATION_MODE must explicitly be open, invite or closed in production');
  }
  const invitations = new Map();
  if (env.REGISTRATION_INVITES_JSON !== undefined) {
    let entries;
    try { entries = JSON.parse(env.REGISTRATION_INVITES_JSON); }
    catch { throw new Error('REGISTRATION_INVITES_JSON must be a JSON object of email-to-SHA256 hashes'); }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error('REGISTRATION_INVITES_JSON must be a JSON object of email-to-SHA256 hashes');
    }
    for (const [email, hash] of Object.entries(entries)) {
      const normalizedEmail = email.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(normalizedEmail) || normalizedEmail.length > 254 ||
          invitations.has(normalizedEmail) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
        throw new Error('REGISTRATION_INVITES_JSON contains an invalid or duplicate invitation');
      }
      invitations.set(normalizedEmail, Buffer.from(hash, 'hex'));
    }
  }
  if (mode === 'invite' && invitations.size === 0) {
    throw new Error('Invite registration requires at least one configured invitation hash');
  }
  return { mode, invitations };
}

function registrationAllowed(policy, email, code) {
  if (policy.mode === 'open') return true;
  if (policy.mode !== 'invite') return false;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
  const suppliedHash = createHash('sha256').update(code).digest();
  const expectedHash = policy.invitations.get(email.trim().toLowerCase());
  // Also compare for unknown emails; return the same response for every rejection.
  return timingSafeEqual(suppliedHash, expectedHash || Buffer.alloc(32)) && !!expectedHash;
}

module.exports = { readRegistrationPolicy, registrationAllowed };
