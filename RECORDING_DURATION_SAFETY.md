# Recording-duration safety (local Phase 2)

## Baseline before this change

- Flutter ordinary/script recordings had no duration ceiling; challenges used their configured timer (default 60 seconds). Upload timeout: six minutes; ordinary HTTP timeout: 15 seconds.
- Node multipart limit: 25 MiB per uploaded recording; outgoing multipart maximum: 51 MiB including reference audio. Python request timeout defaults to 300,000 ms. Admission: one active analysis per user and ten requests per minute.
- Python: 25 MiB per file, one analysis worker, four queued requests, 30-second queue wait. Decoding previously loaded the whole recording before signal validation.

These upload, timeout, authentication and concurrency settings are unchanged.

## Final rules and enforcement

| Mode | Mobile recording limit | Server limit |
| --- | --- | --- |
| Ordinary | 300 active seconds | 300 seconds |
| Script | 300 active seconds | 300 seconds |
| Timed challenge | Configured positive duration, capped at 300; invalid/missing configuration defaults to 60 | Stored Challenge resource duration, capped at 300; unresolved or invalid configuration falls back to global 300 |

Flutter stops ordinary/script recording into a draft at the deadline; the user can analyze or reset it. Timed challenges retain automatic submission. Ordinary/script backgrounding pauses recording; challenge backgrounding cancels and discards the interrupted attempt. Active-time deadlines preserve fractions across pauses. Native recorder failures reset the attempt. Drafts are removed on reset, disposal, and upload completion/failure. Abrupt process termination remains OS-managed cleanup.

Node accepts optional `practiceMode` and `durationSeconds` multipart fields. Missing metadata remains compatible with older clients. Supplied duration must be a nonnegative decimal string with at most three fractional digits and cannot exceed the nominal limit. Unsupported modes and inconsistent identifiers are rejected. A smaller limit comes only from the stored Challenge resource obtained through the existing authenticated lookup, never client configuration. Changing a challenge identifier into `resourceId` still applies the stored challenge constraint. An omitted or nonexistent resource cannot establish challenge identity: the global cap applies. No new mandatory challenge-binding contract is introduced.

Python receives `max_duration_seconds` (1–300, default 300) from Node and optional `duration_seconds`; neither can increase its hard global maximum. Service authentication is unchanged. FFmpeg decodes the first audio stream into mono 16 kHz float32 PCM, bounded by an output time window AND an audio sample trim. Only the limit plus 0.5 seconds and one detection sample can be emitted (about 19.23 MB at the global cap), with a 30-second subprocess timeout, one decoding/filter thread, discarded stderr, and file/pipe protocols only. Existing FFmpeg installation is required; no new dependency was installed. Codec internals still consume resources within the subprocess; this is not an OS memory sandbox.

Decoded duration up to nominal limit + 0.5 seconds is accepted for encoding/timer precision; a further sample causes rejection, not silent acceptance of a truncated recording. Declared duration has no tolerance. Actual samples override spoofed or missing client metadata. User audio is checked before Whisper/ModernBERT and before reference analysis; reference audio is separately capped at the global limit. Invalid audio and decode timeout return controlled errors; missing FFmpeg is a server failure. Node additionally rejects over-limit Python results before creating sessions or permanent recording objects. Existing cleanup paths remove upload temporary files and preserve R2 rollback behavior.

## Compatibility and remaining verification

Successful response structure, scoring formulas, weights, API settings and historical records are unchanged. Old clients may omit the new fields but are still subject to decoded duration checks. The bounded FFmpeg normalization replaces the previous soundfile/librosa decode path; real microphone recordings should be checked for format and waveform compatibility before release. No inference-quality equivalence is claimed by these model-free tests.

Local regression coverage uses mocked large sample counts rather than long recordings; short synthetic WAV/MP3/AAC/M4A/FLAC/OGG fixtures exercise actual decoding. Node mocks storage and Python; mobile tests mock recorder and HTTP. Real Android lifecycle/timer precision, legitimate near-five-minute microphone recordings, end-to-end reference scoring, and Linux container FFmpeg remain manual local verification steps. No deployment is authorized by this change.
