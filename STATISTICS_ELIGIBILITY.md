# Performance statistics contract (version 1)

`performanceStatistics.eligibleAssessmentFilter()` governs both user/admin
averages and the session rows returned by `/stats/:userId` (all views).
It requires Completed, nonblank/nonplaceholder string transcription, and all
four stored Number scores (`overallScore`, `paceScore`, `clarityScore`,
`energyScore`) within 0–100. Zero is legitimate. Explicit analysisValid=false
or structured analysisValid/analysis_valid/usable=false, or completeness
invalid/unusable, excludes a row. Missing modern evidence does not exclude it.
Partial assessment, unavailable optional components, uncertainty and Taglish
do not by themselves exclude a usable assessment.

- totalSessions: all stored attempts, unchanged meaning.
- completedSessions / failedSessions: counts by stored processing status.
- eligibleScoredSessions: qualifying scored assessments; proficiency denominator.
- excludedSessions: all attempts minus eligibleScoredSessions (not all failures).
- avgScore / avgPace / avgClarity / avgEnergy: eligible averages, null if none.
- statisticsVersion=1: returned performance rows use the shared eligibility rule.
- Admin avgAppScore: rounded eligible average; legacy numeric zero if none,
  accompanied by avgScoreAvailable=false and eligibleScoredSessions=0.

History and admin recent-session routes still show all attempts. Existing admin
UI totals remain all attempts and its average now uses eligible records. This
task does not change the separate admin repository; an eligible-count card and
an unavailable-average display are recommended there.

Home proficiency/resource access uses eligibleScoredSessions >= 10 and a finite
0–100 avgScore, retaining <60 / <80 / >=80 thresholds. Old responses without the
eligible count retain demographic placement. Compact chart responses without
statisticsVersion are not certified for performance charts, so newer Flutter
shows no such rows until paired with the updated backend. Home streaks, Profile
streaks, and Progress daily/weekly/language charts use the filtered rows. Existing
Progress grouping of Filipino and Taglish is retained. Attempt counts remain
separate; history numbering is unchanged.

Compatibility heuristic: legacy records with real text and all numeric scores
can qualify even without provenance. It cannot distinguish historically
fabricated/default zero scores from genuine zeros. Placeholder feedback alone
is not grounds for exclusion. No document is migrated, repaired, or deleted.

Aggregation uses a user $match and fixed-size $facet summaries, not materialized
full-collection arrays. Global averages necessarily scan candidate records.
Existing userId/createdAt index supports user lookups; evaluate a future
userId/status/createdAt index with explain before applying it. Regex and score
checks still require document examination. No index changes are performed.
