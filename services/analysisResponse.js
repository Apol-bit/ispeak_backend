// Public messages are constructed here, never forwarded from arbitrary upstream text.
const validationMessages = {
  recording_too_short: 'The recording is too short. Please record at least one second of speech, preferably a complete sentence.',
  insufficient_speech: 'The recording does not contain enough usable speech. Please record a short sentence in a quiet place and try again.',
  invalid_audio: 'This audio could not be read. Please upload a valid recording in a supported audio format.',
};
function mapAiError(error) {
  if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) || error.response?.status === 504) {
    return { status: 504, message: 'Speech analysis took too long. Please try a shorter recording.' };
  }
  const status = error.response?.status;
  if (status === 400 || status === 422) {
    const code = error.response?.data?.detail?.code;
    return { status, message: Object.hasOwn(validationMessages, code) ? validationMessages[code] : 'The audio could not be analyzed. Please check the recording and its audio format.' };
  }
  if (status === 413) return { status, message: 'The audio file is too large. Please upload a smaller recording.' };
  if (status === 429) return { status, message: 'Speech analysis is busy. Please try again shortly.' };
  if (status === 503 || (!error.response && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(error.code))) {
    return { status: 503, message: 'Speech analysis is temporarily unavailable. Please try again shortly.' };
  }
  return { status: 502, message: 'Speech analysis could not be completed. Please try again.' };
}
function usableAnalysis(a) {
  return a?.analysis_valid === true && typeof a.transcription === 'string' && a.transcription.trim().length > 0
    && Number.isFinite(a.duration_seconds) && a.duration_seconds >= 1
    && Number.isFinite(a.pacing?.wpm) && a.pacing.wpm > 0
    && ['overall', 'pacing', 'clarity', 'energy'].every(k => Number.isFinite(a.scores?.[k]) && a.scores[k] >= 0 && a.scores[k] <= 100);
}
function analysisFeedback(a) {
  const pitch = a.vocal_variety?.frequency_pitch;
  const intensity = a.vocal_variety?.signal_intensity;
  const pronunciation = a.articulation?.accurate_pronunciation;
  const availability = {
    pitch: pitch?.analysis_available === true,
    pronunciation: pronunciation?.available === true,
    fillers: a.fillers?.analysis_available === true,
  };
  const wpm = a.pacing.wpm;
  const pace = a.speaking_rate?.reference_wpm > 0
    ? (a.scores.pacing >= 80 ? 'Your pace is close to the reference recording.' : 'Your pace differs from the reference recording. Try matching its speed.')
    : wpm < 120 ? 'Pace is below the target range of 120-150 words per minute.'
    : wpm > 150 ? 'Pace is above the target range of 120-150 words per minute.'
    : 'Pace is within the target range of 120-150 words per minute.';
  const clarity = [a.articulation?.score >= 85 ? 'Word timing and audibility were generally clear.' : 'Some word timing or audibility needs practice.'];
  if (!availability.pronunciation) clarity.push('Pronunciation confidence was unavailable.');
  if (!availability.fillers) clarity.push('Filler analysis was unavailable; clarity uses articulation evidence only.');
  else if (a.fillers.count === 0) clarity.push('No filler spans were detected.');
  else clarity.push(`Detected filler rate: ${a.fillers.rate}% of recognized words.`);
  const energy = [];
  if (intensity?.loudness_status === 'Too loud (shouting)') energy.push('The recorded level is high. Try reducing your volume or moving farther from the microphone.');
  else if (intensity?.loudness_status === 'Too quiet (whispering)') energy.push('The recorded level is low. Try moving closer to the microphone.');
  else if (intensity?.loudness_status === 'Normal volume') energy.push('The recorded level is within the target range.');
  else energy.push('Recorded volume could not be assessed reliably.');
  if (intensity?.is_low_intensity_variation) energy.push('Recorded intensity has limited variation.');
  if (!availability.pitch) energy.push('Pitch analysis was unavailable; the energy score is a partial estimate based on recorded intensity and pauses.');
  else if (pitch.is_monotone) energy.push('Pitch variation was limited.');
  else if (pitch.pitch_variety_score < 50) energy.push('Pitch variation could be increased.');
  if (a.vocal_variety?.temporal_pauses?.possibly_unintentional_count > 0) energy.push('Some gaps between words may need practice.');
  return { availability, feedback: { pace, clarity: clarity.join(' '), energy: energy.join(' ') } };
}
module.exports = { mapAiError, usableAnalysis, analysisFeedback };
