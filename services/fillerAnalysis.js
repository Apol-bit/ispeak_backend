const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value)
  && value >= min && value <= max ? value : null;
const count = value => Number.isInteger(value) ? finite(value, 0, 1000000) : null;
const statusValues = ['matched', 'mismatch', 'unknown'];

function mapFillerAnalysis(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const available = source.analysis_available === true && count(source.count) !== null;
  function spans(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).flatMap(item => {
      if (!item || typeof item.word !== 'string') return [];
      const start = finite(item.start, 0, 86400);
      const end = finite(item.end, 0, 86400);
      if (start === null || end === null || end < start) return [];
      return [{ word: item.word.slice(0, 120), start, end,
        confidence: finite(item.confidence, 0, 1) }];
    });
  }
  const candidates = available ? spans(source.candidates) : [];
  const words = available ? spans(source.words) : [];
  const failureCodes = ['classifier_unavailable', 'classifier_inference_failed', 'classifier_output_invalid'];
  return {
    version: 1, available, countUnit: 'grouped_spans',
    count: available ? source.count : null,
    rate: available ? finite(source.rate, 0, 100) : null,
    score: available ? finite(source.score, 0, 100) : null,
    threshold: finite(source.threshold, 0, 1), words, candidates,
    candidateCount: available ? Math.max(count(source.candidate_count) ?? 0,
      Array.isArray(source.candidates) ? Math.min(source.candidates.length, 1000000) : 0) : null,
    detailsTruncated: available && (source.words?.length > 100 || source.candidates?.length > 100),
    coverage: {
      status: statusValues.includes(source.coverage?.status) ? source.coverage.status : 'unknown',
      classifierWordCount: count(source.coverage?.classifier_word_count),
      transcriptWordCount: count(source.coverage?.transcript_word_count),
    },
    failure: available ? null : { code: failureCodes.includes(source.failure?.code)
      ? source.failure.code : source.analysis_available === true ? 'invalid_details' : 'analysis_unavailable' },
  };
}
module.exports = { mapFillerAnalysis };
