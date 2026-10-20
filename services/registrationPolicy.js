function readRegistrationPolicy(env = process.env) {
  // Production must name its signup policy explicitly. Invitation codes are
  // unsupported; obsolete configuration must never silently enable signup.
  const mode = env.REGISTRATION_MODE === undefined && env.NODE_ENV !== 'production'
    ? 'open' : env.REGISTRATION_MODE;
  if (!['open', 'closed'].includes(mode)) throw new Error('REGISTRATION_MODE must be open or closed');
  return { mode };
}

function registrationAllowed(policy) { return policy.mode === 'open'; }

module.exports = { readRegistrationPolicy, registrationAllowed };
