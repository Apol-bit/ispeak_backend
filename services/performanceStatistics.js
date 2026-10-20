// Shared by averages and every returned performance row. No legacy data writes.
const scoreFields = ['overallScore', 'paceScore', 'clarityScore', 'energyScore'];
function eligibleAssessmentFilter() {
  return {
    // Query $type also matches array elements; $expr enforces scalar fields.
    $expr: { $and: [
      { $eq: [{ $type: '$transcription' }, 'string'] },
      { $eq: [{ $type: '$status' }, 'string'] },
      ...scoreFields.map(key => ({ $isNumber: `$${key}` })),
    ] },
    status: 'Completed',
    transcription: { $type: 'string', $regex: /\S/, $not: /^\s*no transcription available\.?\s*$/i },
    analysisValid: { $ne: false },
    'assessmentDetails.analysisValid': { $ne: false },
    'assessmentDetails.analysis_valid': { $ne: false },
    'assessmentDetails.usable': { $ne: false },
    'assessmentDetails.completeness': { $nin: ['invalid', 'unusable'] },
    ...Object.fromEntries(scoreFields.map(k => [k, { $type: 'number', $gte: 0, $lte: 100 }])),
  };
}

function statisticsPipeline(filter = {}) {
  return [{ $match: filter }, { $facet: {
    attempts: [{ $group: { _id: null, totalSessions: { $sum: 1 },
      completedSessions: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
      failedSessions: { $sum: { $cond: [{ $eq: ['$status', 'Failed'] }, 1, 0] } } } }],
    eligible: [{ $match: eligibleAssessmentFilter() }, { $group: { _id: null,
      eligibleScoredSessions: { $sum: 1 }, avgScore: { $avg: '$overallScore' },
      avgPace: { $avg: '$paceScore' }, avgClarity: { $avg: '$clarityScore' }, avgEnergy: { $avg: '$energyScore' } } }],
  } }];
}

function summarizeStatistics(facet) {
  const attempts = facet?.attempts?.[0] || {};
  const eligible = facet?.eligible?.[0] || {};
  const totalSessions = attempts.totalSessions ?? 0;
  const eligibleScoredSessions = eligible.eligibleScoredSessions ?? 0;
  return { totalSessions, eligibleScoredSessions,
    completedSessions: attempts.completedSessions ?? 0, failedSessions: attempts.failedSessions ?? 0,
    excludedSessions: totalSessions - eligibleScoredSessions,
    avgScore: eligible.avgScore ?? null, avgPace: eligible.avgPace ?? null,
    avgClarity: eligible.avgClarity ?? null, avgEnergy: eligible.avgEnergy ?? null };
}
module.exports = { eligibleAssessmentFilter, statisticsPipeline, summarizeStatistics };
