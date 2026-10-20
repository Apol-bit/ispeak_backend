// Accept a fixed-size scoring contract, never arbitrary diagnostics or text.
function mapAssessmentDetails(raw, scores) {
  if (!raw || raw.version !== 1) return undefined;
  const scoreKeys = ['overall', 'pacing', 'clarity', 'energy', 'articulation', 'filler_words'];
  const componentKeys = ['pronunciation', 'enunciation', 'pitchVariety', 'pauses', 'energyRuleBase', 'baseEnunciation', 'referenceEnunciation'];
  const availabilityKeys = ['pacing', 'pronunciation', 'enunciation', 'audibility', 'intensity', 'pauses', 'pitch', 'fillers'];
  const fallbackKeys = ['pronunciation', 'fillers', 'pitch', 'pacing', 'referencePacing'];
  const validNumber = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  if (!availabilityKeys.every(k => typeof raw.availability?.[k] === 'boolean')
    || !fallbackKeys.every(k => typeof raw.fallback?.[k] === 'boolean')
    || !['matched', 'mismatch', 'unknown'].includes(raw.coverage)
    || !scoreKeys.every(k => (raw.scores?.[k] === null || validNumber(raw.scores?.[k], 0, 100))
      && raw.scores[k] === scores?.[k])
    || !componentKeys.every(k => raw.components?.[k] === null || validNumber(raw.components?.[k], 0, 100))) return undefined;
  const expected = {
    overall: { pacing: .35, clarity: .40, energy: .25 },
    clarity: { articulation: raw.fallback.fillers ? 1 : .6, fillers: raw.fallback.fillers ? 0 : .4 },
    articulation: { pronunciation: raw.fallback.pronunciation ? 0 : .6, enunciation: raw.fallback.pronunciation ? 1 : .4 },
    energy: { intensityPitchRules: raw.availability.pauses ? .8 : 1, pauses: raw.availability.pauses ? .2 : 0 },
    referenceEnunciation: { user: raw.basis?.referenceEnunciationApplied ? .4 : 1,
      reference: raw.basis?.referenceEnunciationApplied ? .6 : 0 },
  };
  if (!Object.entries(expected).every(([group, weights]) => Object.entries(weights)
    .every(([key, value]) => raw.weights?.[group]?.[key] === value))) return undefined;
  if (!['reference', 'target_range'].includes(raw.basis?.pacing)
    || !['timing_only', 'timing_and_audio', 'unavailable'].includes(raw.basis?.enunciationEvidence)
    || raw.basis?.energy !== 'intensity_pitch_rules_then_pauses'
    || typeof raw.basis?.referenceEnunciationApplied !== 'boolean'
    || !validNumber(raw.basis?.referenceEnergyAdjustment, -100, 100)) return undefined;
  if ((!raw.availability.pronunciation && raw.components.pronunciation !== null)
    || (!raw.availability.pitch && raw.components.pitchVariety !== null)
    || (!raw.availability.fillers && raw.scores.filler_words !== null)
    || raw.fallback.pronunciation !== (raw.components.pronunciation === null)
    || raw.fallback.fillers !== (raw.scores.filler_words === null)
    || raw.fallback.pitch !== !raw.availability.pitch
    || raw.fallback.pacing !== !raw.availability.pacing) return undefined;
  const pick = (source, keys) => Object.fromEntries(keys.map(k => [k, source[k]]));
  return {
    version: 1,
    completeness: raw.completeness === 'complete' && availabilityKeys.every(k => raw.availability[k])
      && raw.coverage === 'matched' && fallbackKeys.every(k => !raw.fallback[k]) ? 'complete' : 'partial',
    availability: pick(raw.availability, availabilityKeys), coverage: raw.coverage,
    scores: pick(raw.scores, scoreKeys), components: pick(raw.components, componentKeys),
    weights: expected, fallback: pick(raw.fallback, fallbackKeys),
    basis: pick(raw.basis, ['pacing', 'energy', 'enunciationEvidence', 'referenceEnunciationApplied', 'referenceEnergyAdjustment']),
  };
}
module.exports = { mapAssessmentDetails };
