const MAX_SECONDS = 300;
const TOLERANCE_SECONDS = 0.5;

function recordingDuration(body, resource) {
  const mode = body.practiceMode;
  if (mode !== undefined && !['ordinary', 'script', 'challenge'].includes(mode)) {
    throw new Error('Unsupported practice mode.');
  }
  if ((body.challengeId && body.resourceId) || (mode === 'ordinary' && (body.challengeId || body.resourceId))
    || (mode === 'challenge' && !body.challengeId) || (mode === 'script' && body.challengeId)) {
    throw new Error('Inconsistent practice mode or resource identifiers.');
  }
  let maximum = MAX_SECONDS;
  if (body.challengeId && resource && resource.type !== 'Challenge') {
    throw new Error('Invalid challenge resource.');
  }
  // Only stored resource configuration can establish a shorter trusted limit.
  if (resource?.type === 'Challenge' && typeof resource.timeLimitSeconds === 'number'
    && Number.isFinite(resource.timeLimitSeconds) && resource.timeLimitSeconds >= 1) {
    maximum = Math.min(maximum, resource.timeLimitSeconds);
  }
  let declared;
  if (Object.hasOwn(body, 'durationSeconds')) {
    const raw = body.durationSeconds;
    if (typeof raw !== 'string' || !/^\d+(?:\.\d{1,3})?$/.test(raw) || raw.length > 16) {
      throw new Error('Invalid recording duration metadata.');
    }
    declared = Number(raw);
    if (!Number.isFinite(declared) || declared > maximum) {
      throw new Error('The recording exceeds the permitted duration.');
    }
  }
  return { maximum, declared };
}
module.exports = { recordingDuration, MAX_SECONDS, TOLERANCE_SECONDS };
