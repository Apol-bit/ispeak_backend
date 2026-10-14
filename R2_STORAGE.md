# R2 audio storage implementation and verification

Verified locally on 2026-10-09. No deployment, commit, push, real R2 access,
existing-audio migration, or existing-audio deletion was performed. Python V2,
speech scoring, authentication middleware and frontend/Admin code are unchanged.

## A. Architecture before changes

The existing `StorageProvider` exposed `getUploadDirectory`, `toKey`,
`openReadStream`, and asynchronous `delete`. Only `LocalStorageProvider` existed.
It resolved keys relative to the Node project, restricted resolution to its
configured root, created recording/reference directories, returned filesystem
read streams and used an idempotent local file delete.

Multer wrote recordings into `uploads` and reference audio into
`uploads/reference_audio`. The session controller streamed the uploaded file to
Python, attached reference audio through `openReadStream`, then saved the local
key after a usable analysis. Resource create/update stored local keys. Reference
replacement updated Mongo before deleting the old file; failed deletes were only
logged. Retention deleted files before clearing `audioPath` and setting
`audioDeletedAt`. Account deletion removed files, sessions, then the user. Callers
therefore required both upload directories and readable streams; no Python file
path or public storage URL was required by the analysis protocol.

## B. Production files changed

- `services/storageService.js`: retained local provider; added R2 provider/configuration.
- `services/audioStorageService.js` (new): upload lifecycle and persistent cleanup retries.
- `services/audioFile.js` (new): audio size/signature checks and MIME mapping.
- `services/storageErrors.js` (new): safe storage/input errors.
- `models/StorageCleanup.js` (new): durable cleanup intents and indexes.
- `models/LearningResource.js`: corrected storage-key comment; no schema field change.
- `controllers/sessionController.js`: durable storage ordering and private reference retrieval.
- `controllers/resourceController.js`: reference storage/replacement/deletion/read access.
- `controllers/userController.js`: journaled recording cleanup during account deletion.
- `routes/resourceRoutes.js`: normalized upload names and protected reference read route.
- `server.js`: cleanup schedule/index initialization; never serve R2 scratch storage.
- `.env.example`: placeholders and local/production configuration guidance.
- `package.json`, `package-lock.json`, `yarn.lock`: AWS S3 SDK dependency and lock updates.

Additional operational files: `scripts/audioInventory.js` and this document.
`services/retentionService.js` did not require an implementation change: its
existing provider calls now operate against R2 and have new regression coverage.

## C. R2 provider

Uses `@aws-sdk/client-s3@3.1148.0` and `PutObjectCommand`, `GetObjectCommand`,
`DeleteObjectCommand`. No ACL or public URL is created. A missing object deletion
is idempotent; missing reads have a controlled 404. Other SDK failures become
safe storage errors without retaining the SDK cause, request, signature or keys.

The existing abstraction is extended with `createKey` and asynchronous
`storeFile`. Local uploads remain in their existing durable development location.
R2 upload directories are private OS scratch directories created with `mkdtemp`.
`openReadStream` remains synchronous in local mode and is awaitable in R2 mode;
callers that support both await it.

Both providers support `getUploadDirectory`, `createKey`, `storeFile`,
`openReadStream`, and asynchronous idempotent `delete`. Local `storeFile` retains
the Multer file and returns its relative key; R2 `storeFile` transfers it under
the previously generated key. Local-only `toKey`/`resolve` are not an R2
materialization interface. There is no separate existence/HEAD method. Missing
local reads emit filesystem stream errors; missing R2 reads return controlled
404 errors. R2 downloads materialize in bounded memory, not durable local files.
Controllers use the shared lifecycle methods; explicit cloud branches implement
journaling/concurrency safeguards and prevent static serving of cloud scratch.

The SDK has at most three attempts and per-operation abort deadlines (60 seconds
for upload/read, 30 seconds for deletion). Audio is bounded to 25 MiB per file.
R2 upload buffers permit SDK retries; R2 download buffering ensures late stream
failures are classified before contacting Python. Memory usage is bounded per
request, not across all concurrent Node requests. Keep proxy limits and capacity
testing in the deployment plan.

Cloudflare reference: https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/

## D. Environment configuration

Local development remains:

```dotenv
STORAGE_DRIVER=local
LOCAL_STORAGE_ROOT=uploads
ALLOW_LOCAL_STORAGE_IN_PRODUCTION=false
```

Production audio configuration, with values supplied through host secrets:

```dotenv
NODE_ENV=production
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_ENDPOINT=
R2_REGION=auto
```

`R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` are required. Supply
`R2_ACCOUNT_ID` or `R2_ENDPOINT`. Without an explicit endpoint, the account ID
derives `https://<account-id>.r2.cloudflarestorage.com`. Explicit endpoints must
be HTTPS Cloudflare R2 S3 origins, including supported jurisdiction suffixes,
without embedded credentials, ports, queries or paths. Region defaults to `auto`.
Missing or malformed configuration fails startup without displaying its value.

The normal Node production variables (`MONGO_URI`, `JWT_SECRET`, `CORS_ORIGINS`,
`PYTHON_BACKEND_URL`, `PORT`) remain necessary. Do not use the local-storage
production bypass for normal R2 deployment. No `.env` secrets were changed.

## E. Object keys

```text
recordings/<24-character-user-object-id>/<random-UUID>.<normalized-extension>
reference-audio/<24-character-resource-object-id>/<random-UUID>.<normalized-extension>
```

Keys use server-generated UUIDs, validated object IDs, normalized supported
extensions and a strict allowlist. No original filename, traversal segment,
absolute local path, credential or permanent public URL is stored. Mongo keeps
these keys in the existing `audioPath` / `referenceAudioPath` fields.

R2 mode rejects old local keys rather than silently attempting a missing
ephemeral file. **Existing deployment-required references must be migrated in an
explicitly authorized follow-up before switching their database to R2 mode.**
No mixed-provider fallback or automatic migration is implemented.

## F. User recording flow

1. Existing authentication, per-user admission and 25 MiB Multer limit.
2. Temporary upload and existing Python analysis/validation.
3. Reject failed/unusable analysis without uploading a durable object.
4. Recheck size/container signature; create a Mongo cleanup intent before PUT.
5. PUT the complete recording to R2.
6. Save the completed session with the R2 key using the existing analysis data.
7. Finalize the upload intent and remove scratch audio before returning success.

A failed PUT does not create a completed session. A failed or ambiguous Mongo
save leaves an intent so cleanup can later check whether the object is actually
referenced. There is no blind delete after an ambiguous DB acknowledgement.
History/statistics response contracts and score/session field calculations are
unchanged. User recording keys remain omitted from client session responses.

## G. Reference audio flow

New references pass size/container checks, are stored in R2 and then referenced
by the saved resource. During analysis Node privately downloads the bounded
object, then supplies its bytes, filename and validated MIME as multipart
`reference_audio` to Python. Python requires no R2 credentials or changes.
Failure to retrieve a selected reference aborts processing with a storage error;
it does not silently fall back to different scoring.

Replacement journals the previous key, uploads a new object, conditionally
updates the expected old reference in Mongo, then removes the previous object
if unreferenced. A conflicting concurrent replacement returns 409. The old
reference remains intact when the new upload or database update fails.

Authenticated Admin/Validator reference access is available at
`GET /api/admin/resources/:id/reference-audio`, with private/no-store response
headers. This route selects the key through the resource, never arbitrary input.
The old authenticated `/uploads/reference_audio` route remains in local mode
only. There is no new user-recording playback feature or APK distribution code.

## H. Retention and deletion

Retention still deletes the object before clearing the session key and saving
`audioDeletedAt`. R2 missing-object deletion succeeds safely. Delete failure
leaves the DB key unchanged. If the following Mongo save fails, the retained key
can be retried because deleting an already absent object is safe.

R2 account deletion persists intents for every captured recording before
deleting those captured sessions and the user. It then attempts cleanup. Cloud
failure can leave deferred cleanup, but not an unrecorded orphan. If new sessions
are detected during deletion, it returns 409 for retry after uploads finish.
These operations are multi-step, not atomic; perform administrative deletion
after the account's uploads have drained. There is no distributed upload/deletion
lock, and a request already in flight can race the final user deletion.

Resource deletion records the intent first and conditionally deletes the
resource only if its reference is unchanged. Afterward it tries object deletion.
If cloud cleanup fails, the acknowledged resource deletion remains valid and
the journal retains work for retry. A concurrent reference change returns 409.

## I. Failure recovery and operating requirements

The `storagecleanups` collection contains namespace (endpoint/bucket), object
key, upload/cleanup purpose, next-attempt time, attempts and timestamps. It holds
no secrets or transcript. Compound indexes protect intent identity and bound the
due-work scan. Production R2 startup initializes these indexes; verify the DB
role permits this or provision them through the deployment process.

- Intents precede remote upload or destructive metadata changes.
- Upload finalization cannot erase a concurrent deletion intent.
- On restart, the worker resumes from Mongo and handles at most 100 due entries
  per scan, once per minute, without overlapping scans in the same process.
- Uncertain/unfinished operations have a 24-hour recovery delay. Ordinary
  post-commit deletions are attempted immediately; transient failures retry on
  a later scan, at least a minute later.
- The worker verifies session AND resource references before deleting. A DB
  lookup failure preserves the object/intent. Still-referenced intents are
  deferred another day. Different endpoint/bucket namespaces are never mixed.
- Multiple workers may attempt the same deletion; deletion is idempotent. This
  is not a distributed transaction or exactly-once worker.
- Monitor repeated generic cleanup errors and old due intents. Investigate
  permissions, bucket changes and DB availability without logging SDK objects.
- Preserve both database records (including cleanup intents) and bucket data in
  recovery planning. Out-of-band deletion of either cannot be repaired by this code.
- Do not suspend and resume a half-completed upload beyond the 24-hour recovery
  window. Terminate/drain old processes during replacement instead.

Temporary files are removed on normal success/error paths. Forced termination,
host failure or filesystem refusal can leave scratch files; the application logs
cleanup refusal but cannot run `finally` after termination. Container scratch can
be discarded; a persistent host needs an age/process-aware maintenance policy
for old `ispeak-audio-*` scratch directories, never for durable local uploads.

## J. Security and content validation

Credentials stay inside the Node environment/client. Flutter, Admin and Python
receive no storage secret. S3 error details are discarded and are not embedded
in client responses or cleanup records. Endpoint validation prevents accidental
credential forwarding to arbitrary hosts. R2 scratch is never exposed through
Express static serving. No public ACL, presigned link or bucket-publication API
is called.

**Bucket privacy is a Cloudflare configuration requirement, not proven by mock
tests.** Disable public bucket access/custom public audio domains and scope the
API token to the private test/production audio bucket with only needed object
read/write permissions. Keep public APK distribution in a separate bucket/domain.

MIME is derived from container signatures plus normalized extensions, not the
client's MIME header: WAV, MP3, M4A, AAC, FLAC, OGG. Signature checks are not a
complete decoder; Python still performs real recording decode/speech checks.
WebM is deliberately not added because Python V2 does not currently accept it.
Multer rejects files above 25 MiB before R2 transfer; the provider repeats that
guard for direct callers. No extra personal metadata is uploaded.

## K. Added tests

- `test/storageProvider.test.js`: SDK commands, MIME, safe keys, buffer/read
  failures, missing objects, idempotent deletes, size/signature checks, secret
  redaction, config validation, local-provider behavior.
- `test/storageCleanup.test.js`: write-ahead failure, failed/ambiguous PUT and
  Mongo save, restarted worker, reference protection, retry, bucket namespace,
  concurrent intent finalization and temporary cleanup.
- `test/r2Flows.test.js`: authenticated HTTP recording/reference flows, byte
  delivery to a mock Python multipart endpoint, create/read/replace/delete,
  conflict/storage/DB failures, retention, account deletion, upload limits,
  client disconnect during inference and Python timeout in R2 mode.
- `test/storageEnvironment.test.js`: production local-storage guard and R2
  configuration errors using isolated child processes, without DB connections.
- `test/audioInventory.test.js`: read-only referenced/missing/orphan accounting.
- `testing/storageFixtures.js`: synthetic WAV, in-memory S3 transport and cleanup
  journal fixtures. No actual credentials or production audio.

## L. Regression result

`npm.cmd test`: **93 tests passed, 0 failed** (36 existing + 57 storage/tool tests).
Final continuation run: **4096.8742 ms**, zero skipped/cancelled/todo.
Node syntax checks and `git diff --check` succeeded. Tests use isolated temporary
directories and Mongo/S3/Python stubs; they do not write to the existing database
or use the existing recordings. Actual S3 request signing/R2 compatibility and
Mongo cleanup-index creation still require live environment verification.

## M. Local storage regression

All original 36 tests still pass, including authentication/authorization,
gateway failures, history/statistics and resource management. Additional tests
exercise local file persistence/read/delete and the production local guard.
The normal MongoDB Windows service was already running during this continuation.
It was read through the standalone inventory command only. No production
application startup, retention worker, cleanup worker, collection/index creation
or database mutation was invoked. No database service was started or stopped.

## N. R2 live integration

**NOT TESTED — credentials/test bucket not configured.**

Presence-only verification found none of the six R2 variables configured in the
process environment or local `.env`. `.env.example` contains blank R2 account,
bucket, endpoint and credential fields, with `R2_REGION=auto`. A credential-pattern
scan of 43 tracked/nonignored candidate files found no matches; this is a bounded
scan, not proof against every possible secret format. No secret values were printed.

When explicitly provided later, use only a dedicated private test bucket and
disposable keys. Verify PUT, exact-byte GET, delete, repeated delete, missing GET,
privacy, failure mappings, reference multipart forwarding and restart/redeploy
persistence. Verify cleanup indexes/retry and retention against isolated Mongo
data. Do not use production audio for this smoke test.

## O. Existing audio inventory and migration plan

Read-only inventory again observed **45 files / 64,475,986 bytes (61.49 MiB)**
under the current local storage root; zero symlinks skipped. MongoDB was already
running, and the inventory safely read projected `audioPath` and
`referenceAudioPath` fields without importing the application or writing data.

| Classification | Files | Bytes |
| --- | ---: | ---: |
| Referenced by sessions | 4 | 3,376,816 |
| Referenced by resources | 0 | 0 |
| Orphan candidates (no reference in the two scanned collections) | 41 | 61,099,170 |
| Unknown | 0 | 0 |
| Total | 45 | 64,475,986 |

All four session references resolve to existing files. Missing references, cloud
references and unsafe/unsupported references are zero. These four files are
migration candidates, subject to owner/retention/valid-audio review. The 41
unreferenced files are **not authorized for deletion** and have not been declared
disposable. No file was migrated, deleted, renamed or modified, and no MongoDB
document was changed. Classification reflects only the existing session/resource
reference fields at the read time; it is not a transactionally frozen snapshot
of other concurrent application activity.

After MongoDB is available, run from the Node repository:

```sh
node scripts/audioInventory.js
node scripts/audioInventory.js --details
```

This command uses raw projected collection reads with automatic indexing and
collection creation disabled. It never imports the server/provider, starts
retention, writes files or contacts R2. Default output is counts/sizes. The
optional details include document IDs, internal paths and orphan candidates;
keep that output private. Without DB access it reports only file totals and
does not fabricate orphan counts.

For a separately authorized migration: back up the database/files, identify
existing referenced audio, resolve missing references and retention eligibility,
review orphan candidates without deleting them, then upload selected files to
generated private keys. Verify byte checksums/readback before conditionally
updating the matching DB references. Retain local originals until an explicit
verification/rollback decision. Quiesce writes during final cutover. Do not
switch the existing DB to R2 while required local references remain unmigrated.

## P. Remaining deployment blockers

Real private bucket/token provisioning, live R2 verification, existing-audio
migration decision, production Mongo cleanup-index/recovery testing, and actual
container scratch permissions remain. The read-only inventory classification is
now complete. Other deployment-audit gates (Android signing/identity, production
URLs/secrets, dependency/security disposition, backups/restore and
physical-device/cloud E2E) remain separate and were not reverified here.
Python V2 was not modified. This task did not Dockerize Node or authorize deployment.

## Q. Durable-storage gate

**🟡 IMPLEMENTED — LIVE R2 VERIFICATION PENDING** for the missing R2 implementation.

This is not a claim that the actual bucket is private, deployed persistence is
verified, existing local references are migrated, or the overall system is ready
to deploy. Review these uncommitted changes before live verification or release.

## Final continuation findings

- Disconnect policy: an accepted analysis continues after the client disconnects.
  Its per-user admission slot remains occupied until processing/cleanup finishes.
  Successful Python/R2/Mongo work persists a valid completed session, available
  through history even if the client cannot receive the response. A Python timeout
  returns 504, cleans scratch, and produces no durable upload or completed session.
- The cleanup schema's duplicate identical `purpose` declaration was removed in
  final review; the field and behavior are unchanged.
- `npm.cmd ls --depth=0` resolved successfully. The only new direct dependency is
  exact `@aws-sdk/client-s3@3.1148.0`; both lockfiles include its transitive graph.
- `npm.cmd audit --omit=dev` completed against the registry: **one critical
  advisory**, no high/moderate/low advisories, in preexisting `proxy-addr@2.0.7`
  through Express. Advisory: https://github.com/advisories/GHSA-jqcg-44mw-7w3h
  (IPv4-mapped IPv6 trust-subnet IP spoofing). The HEAD lockfile already contained
  this version. No unrelated upgrade was applied. Review exposure and remediation
  before deployment; the green storage tests do not resolve this audit finding.
- Temporary/ignored artifacts are dependency installations, the unchanged local
  `.env`, existing uploads, and isolated OS test scratch; none are migration
  outputs or cloud-verification evidence. No production server was started.

## Final verification continuation: A–T

The existing working tree was inspected first and retained. This continuation
changed only this report and added four cases to three existing untracked test
files: `test/storageCleanup.test.js`, `test/storageProvider.test.js`, and
`test/r2Flows.test.js`. **No production file was changed in this continuation.**
No reset, restore, checkout, stash, revert, commit, push or deployment was used.
Python V2, scoring, authentication middleware, UI and legacy Python were untouched.

| ID | Requested result | Verified finding |
| --- | --- | --- |
| A | R2 implementation status | Implemented; local/provider/lifecycle/HTTP mock verification passes. Real R2 remains unverified. |
| B | Production files changed | The 15 files listed in section B above, including the three npm/lock manifests. Existing production changes were preserved exactly. |
| C | Tests/tools changed | Five new storage/inventory test files, `testing/storageFixtures.js`, `scripts/audioInventory.js`, and this report; exact list below. |
| D | New npm dependencies | Only new direct dependency: exact `@aws-sdk/client-s3@3.1148.0`; both lockfiles include its transitive graph. `npm.cmd ls --depth=0` passes. |
| E | Environment variables | `STORAGE_DRIVER`, `LOCAL_STORAGE_ROOT`, `ALLOW_LOCAL_STORAGE_IN_PRODUCTION`; R2 uses `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_REGION`. `NODE_ENV` enables the production guard; `RECORDING_RETENTION_DAYS` controls retention. `.env.example` contains only blanks, placeholders and safe defaults. |
| F | Object-key strategy | `recordings/<user ObjectId>/<UUID>.<extension>` and `reference-audio/<resource ObjectId>/<UUID>.<extension>`. Generated server-side; normalized owner/extension; no personal filenames, URLs or traversal. Both categories verified. |
| G | User-recording lifecycle | Validate/analyze first; write-ahead intent, R2 PUT, Mongo Completed save, finalize intent, remove scratch. No failed/unusable Python or failed PUT can create a Completed session. Ambiguous DB acknowledgement preserves a genuinely saved session/object. |
| H | Reference lifecycle | Create/store/read/replace/delete pass. Bytes reach Python only after complete validated download. Two simultaneous replacement requests produced one winner and one 409; only the winner's new object remained. Old audio survives failed upload/DB update. |
| I | Cleanup journal | Schema inspected: namespace/key/purpose/nextAttemptAt/attempts/timestamps; unique namespace+key and due-scan indexes. Retry preserves referenced/uncertain objects; three consecutive delete failures retained one intent, then recovery resolved it; a second scan performed no extra deletion. |
| J | Retention | Delete before clearing metadata; missing object safe; outage leaves session key intact; successful retry clears key/timestamps; second cleanup no-op. Retention retries through session metadata on the next retention run (startup/daily), separately from the minute-based cleanup-journal worker. |
| K | Account/resource deletion | Journal must succeed before destructive metadata operations. R2 cleanup outage can return successful metadata deletion while retaining durable cleanup work; recovery removes the object. Journal failure returns 503 without metadata deletion. Concurrent reference change returns 409. |
| L | Failure/error behavior | Controlled input/storage errors; raw SDK errors, signed requests and credentials discarded. Reference download failure returns storage 503 before Python; engine failures keep existing gateway mappings. See recording matrix below. |
| M | Security findings | Placeholder-only example; no live R2 credentials in process or local `.env`; authenticated reference access, private/no-store headers, no public ACL or cloud scratch serving. Fresh dependency audit: one preexisting critical `proxy-addr@2.0.7` advisory; not introduced by R2 and not fixed here. |
| N | Local regression | `STORAGE_DRIVER=local` retains upload/read/delete behavior. Original 36 tests pass within the complete suite. Production local storage is refused unless `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true`; this acknowledges persistent local storage, not automatic durability. |
| O | Complete Node suite | **93 passed, 0 failed, 0 cancelled/skipped/todo**, 4096.8742 ms. `git diff --check` passes. Git emits existing LF/CRLF conversion warnings, not whitespace errors. |
| P | Live R2 | **NOT TESTED — credentials/test bucket not configured.** Mock S3 transport is not live signing, bucket privacy or cloud persistence evidence. |
| Q | Local audio inventory | **45 / 64,475,986 bytes**: session-referenced **4 / 3,376,816**; resource-referenced **0 / 0**; orphan candidates **41 / 61,099,170**; unknown **0 / 0**. Mongo already running; raw projected reads only. No files/documents modified. |
| R | Migration plan | Back up, review the four referenced candidates and missing/retention eligibility, authorize selected uploads, verify checksum/readback, conditionally update matching references, retain originals for rollback and quiesce writes at cutover. Review 41 orphan candidates separately; delete none without authorization. No migration performed. |
| S | Remaining limitations | No mixed-provider fallback/automatic migration, no global Node transfer-memory bound, no distributed upload/account-delete lock or atomic DB+R2 transaction. Live R2, real Mongo journal-index/recovery tests, container scratch permissions, bucket privacy and cloud E2E remain pending. |
| T | Readiness status | Durable-storage implementation gate can move to **IMPLEMENTED — LIVE R2 VERIFICATION PENDING**. Overall deployment remains gated by live verification, cutover/migration decisions and the preexisting dependency/security issue. No deployment authorized or performed. |

### Exact test/tool/document files

- `test/audioInventory.test.js`
- `test/r2Flows.test.js`
- `test/storageCleanup.test.js`
- `test/storageEnvironment.test.js`
- `test/storageProvider.test.js`
- `testing/storageFixtures.js`
- `scripts/audioInventory.js`
- `R2_STORAGE.md`

### Final provider contract

| Operation | Local | R2 |
| --- | --- | --- |
| Upload directory | Durable local recordings/reference directories | Private OS processing-scratch directories |
| Key generation | `createKey(filePath)` returns the validated local relative key | `createKey(filePath, {category, ownerId})` generates the category/ObjectId/UUID key |
| Store | `storeFile(filePath)` retains the Multer file and returns its key | `storeFile(filePath, {key})` validates size/signature/type, PUTs private bytes, returns key |
| Read/get | `openReadStream(key)` returns filesystem stream | Async `openReadStream(key)` finishes bounded validated GET, then returns a readable buffer stream with `audioLength` |
| Delete | Async `delete(key)`, force/idempotent | Async `delete(key)`, missing object/second deletion safe |
| Materialization | Existing local path/stream; `toKey`/`resolve` are local-only | Bounded in-memory download, not a durable local materialization/path; no HEAD or presigned-public-link contract |

### User-recording failure matrix

| Trigger | Outcome | Durable/session state |
| --- | --- | --- |
| Python validation 400 | Controlled 400 | No PUT, no session; scratch removed |
| Python 500 | Gateway 502 | No PUT, no session; scratch removed |
| Python 503 | Gateway 503 with engine-unavailable message | No PUT, no session; scratch removed |
| Python timeout | 504 | No PUT, no session; scratch removed |
| Unusable Python success payload | Existing usability guard rejects before storage | No durable transfer/Completed save |
| Reference GET/body failure | Storage 503 before Python | No Python request/new session; existing resource/object preserved |
| Cleanup-journal write failure | Storage 503 before PUT | No durable transfer; metadata unchanged |
| Failed/ambiguous R2 PUT | Storage 503 | No Completed session; persisted intent reconciles any object that actually arrived |
| Mongo save fails before commit after PUT | 500 | Object and intent retained; delayed reference-safe cleanup removes unreferenced object |
| Mongo save commits but acknowledgement fails | 500 to caller | Valid Completed session may exist; lookup protects its referenced object. This is not a false Completed analysis, but caller retry can duplicate work. |
| Intent finalization unavailable | Valid committed success retained | Upload intent remains; worker protects referenced object instead of deleting it |
| Cloud compensation/delete repeatedly fails | Metadata success may already be acknowledged | Durable intent and object remain; generic logs, scheduled retry, no blind delete |
| Client disconnect after admission | Processing continues with slot held | Valid analysis/PUT/save can persist a Completed session discoverable through history |

The full suite exercises synthetic audio with the real provider/controller/SDK
command classes, injected in-memory S3 transport, Mongo stubs and mock Python.
The read-only inventory is the only interaction with the existing Mongo data.
Actual cleanup collection/index creation and destructive retention/cleanup against
the normal database were deliberately not invoked.

The fresh production dependency audit completed after using a workspace-local
npm cache and returned **one critical, zero high/moderate/low advisories**. Both
HEAD and current lockfiles have `proxy-addr@2.0.7`; it is preexisting through
Express. The [upstream advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)
lists **2.0.8** as patched. This audit finding concerns unsafe IPv6 trust-subnet
configuration; it is separate from storage credential redaction. No unrelated
dependency or authentication change was applied. Review/remediate it before
deployment. npm audit's nonzero exit reflects this known vulnerability, whereas
the complete functional test suite exits successfully.

Local ignored evidence: `node-storage-verification.local.log`,
`audio-inventory-verification.local.log`, and `node-storage-audit.local.log`.
No real R2 calls, existing-audio deletion/migration, Mongo document changes,
deployment, commit or push occurred.
