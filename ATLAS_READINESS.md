# MongoDB Atlas readiness verification

Security follow-up: `SECURITY_READINESS.md` supersedes the raw-logging and
post-connect startup findings below. Those paths now use sanitized logs and
startup cleanup regression coverage. Production also rejects TLS/certificate
bypasses and requires explicit TLS for standard MongoDB URIs. Live Atlas roles,
networking, indexes, backup and restore remain unverified; this historical audit
does not establish production readiness.

Verified on 2026-10-09. Existing R2, Admin, Android and Python V2 work was preserved.
No deployment, migration, existing-data modification, index creation, commit or
push occurred. Legacy Python was excluded. This audit changed documentation and
added an independent read-only tool and database-focused tests; application
behavior was not changed.

**A. Status: IMPLEMENTED — LIVE PRODUCTION VERIFICATION PENDING.** Node's Atlas
connection path and schema compatibility are implemented. This is not READY FOR
INITIAL DEPLOYMENT: live credentials, permissions, networking, indexes, backup and
restore remain unverified. Logging and startup/index caveats below also need
resolution or explicit review before production.

**B. Database configuration.** `server.js` calls
`await mongoose.connect(process.env.MONGO_URI)` without an options object. Both
development and production require `MONGO_URI` and `JWT_SECRET`; production also
requires CORS origins and Python URL, plus the existing safe-storage configuration.
There is no automatic local database fallback and no `MONGODB_URI` alias. Dotenv
loads the private backend `.env` for local execution; deployment must provide
server-side secrets. The current private configuration is local, not Atlas, and
has an explicit database name. Its value, host and credentials are not reported.

The installed Mongoose 9.10.1 / MongoDB driver 7.6.0 successfully parsed a synthetic
SRV URI without any network contact, with TLS enabled and database `ispeak`.
There is no forced localhost, custom CA bypass or disabled TLS in the connection
code. Include `/ispeak` (or the approved database) in the real URI: without an
explicit database, the driver defaults to `test`. `authSource` is authentication
configuration, not a substitute for the application database. URL-encode password
characters. SRV enables TLS by default, but the application does not reject an
explicit unsafe URI option such as `tls=false`; production configuration review
must reject TLS/certificate-validation bypasses.
[MongoDB connection formats](https://www.mongodb.com/docs/manual/reference/connection-string-formats/).

**C. LIVE ATLAS: NOT TESTED — credentials/configuration unavailable.** The
configured `MONGO_URI` is not an Atlas URI; `LIVE_MONGO_URI` is absent. No alternate
credentials were requested, created or printed. Atlas connection, ready health,
signup/login, session/resource writes, index inspection and outage recovery were
not exercised. Mock/local results are not Atlas integration evidence.

**D. Database user.** Provision a dedicated service user with `readWrite` scoped
only to the approved iSpeak database and, where supported, the intended cluster.
Do not grant `root`, `atlasAdmin`, `dbAdminAnyDatabase`, `readWriteAnyDatabase` or
project/cluster management roles. The database role supports ordinary CRUD and
index creation; use separate maintenance/backup identities where practical.
Use a separate user/database for test writes. Actual Atlas role assignments have
not been verified. [MongoDB built-in roles](https://www.mongodb.com/docs/manual/reference/built-in-roles/).

**E. Network access.** Allowlist only the Node service's outbound addresses where
practical, plus temporary controlled maintainer access. Railway currently offers
static outbound IPv4 on Pro; allowlist all addresses displayed for the service,
and review changes when its region changes. These addresses may be shared, so
allowlisting supplements strong scoped credentials and TLS. Railway private
service DNS alone does not provide an Atlas private endpoint.
[Railway static outbound IPs](https://docs.railway.com/networking/static-outbound-ips).

If the selected hosting plan lacks fixed egress, prefer a plan/provider with fixed
egress or a compatible private-network architecture. An unrestricted Atlas
`0.0.0.0/0` entry exposes authentication to the internet; it is a last-resort team
risk decision requiring strong rotated credentials, TLS, monitoring and limited
database roles. This audit did not add or weaken any access rule.

**F. Index audit.** All collections have MongoDB's automatic unique `_id` index.
Other declared indexes are listed below. No TTL index is declared.

| Model | Index | Purpose | Declared? | Local inspection | Atlas verification needed? |
| --- | --- | --- | --- | --- | --- |
| User | `{ email: 1 }`, unique | Account email uniqueness | Yes | Exists, unique | Yes |
| User | `{ username: 1 }`, unique | Username uniqueness | Yes | Exists, unique | Yes |
| SpeechSession | `{ userId: 1, createdAt: -1 }` | History/stat queries by user/date | Yes | Exists | Yes |
| LearningResource | Only `_id` | Identity | Automatic | Exists | Yes |
| LearningResource | `{ type: 1, difficulty: 1, displayOrder: 1, createdAt: -1, _id: 1 }` | Resource listing/group ordering | No; candidate only | Absent | Review query plans/load before adding |
| StorageCleanup | `{ namespace: 1, key: 1 }`, unique | One durable intent per storage object | Yes | Collection absent | Yes, required for R2 |
| StorageCleanup | `{ namespace: 1, nextAttemptAt: 1 }` | Due retry batches | Yes | Collection absent | Yes |

Only these four active Mongoose models were found. Resource order is not unique;
do not introduce a uniqueness constraint on displayOrder. GuidedTask ordering
omits difficulty, so evaluate that query separately before choosing indexes.
History's `_id` tie-breaker and recording retention may merit additional indexes
after measurement; neither is an initial correctness blocker at thesis scale.

Mongoose's actual global `autoIndex` and `autoCreate` are both true. Production
does not disable them. Declared indexes may therefore be created at normal app
startup. User/session/resource model initialization is not explicitly awaited
before HTTP readiness; `StorageCleanup.init()` is awaited in R2 mode. Health
checks database connectivity, not complete index readiness. Before the first
production start, inspect duplicates and approve/create required indexes through
a controlled process, then verify them. Do not run `syncIndexes()` blindly: it
can remove indexes. No such operation was performed here.

**G. Duplicate-data risk.** Read-only inspection of the existing local database
found 7 users, 110 sessions and 20 learning resources. Email and username each
had zero exact duplicate groups, zero trimmed/lowercase duplicate groups, and
zero missing/null/empty values. Local unique indexes exist. StorageCleanup does
not exist locally, so its data constraints cannot be evaluated here. Atlas data
was not inspected. Binary unique indexes do not enforce case-insensitive
uniqueness; current signup normalizes and checks case-insensitively, but legacy
or external writes still warrant normalized duplicate checks before migration.
No identities, documents or duplicate values were printed or changed.

Reproduce the safe inspection with `node scripts/databaseReadinessAudit.js`.
It uses the private MONGO_URI with autoIndex/autoCreate disabled and raw collection
reads only. It emits counts, index definitions and aggregate duplicate counts,
never URI/password/user identities. No model import or database write occurs.

**H. Schema compatibility.** User, SpeechSession, LearningResource and
StorageCleanup use normal BSON-supported strings, numbers, booleans, dates,
arrays and ObjectIds. All enable timestamps. User normalizes email/username and
defaults role/status; optional profile/terms fields remain nullable. Sessions
retain Pending/Completed/Failed, nullable audioPath/audioDeletedAt and optional
analysis fields for old documents. Resource displayOrder is optional, numeric
and at least 1 when provided; referenceAudioPath defaults to an empty string.
Cleanup namespace/key/purpose/nextAttemptAt are required; attempts defaults to 0.
No schema depends on local filesystem access or server-specific ObjectId behavior.
References are logical Mongoose refs, not MongoDB foreign-key constraints.
No data/schema migration was executed or required for SRV compatibility.

**I. R2/Atlas consistency and retention.** The existing R2 provider stores object
keys in SpeechSession.audioPath and LearningResource.referenceAudioPath, despite
the historical field names. R2 uploads write a Mongo cleanup intent BEFORE object
upload. Session completion is saved only after usable Python analysis and durable
upload succeed. A failed/ambiguous Mongo save leaves the upload intent recoverable;
reference lookups protect an object when a save actually succeeded. Finalization
removes upload intents only, preserving concurrently promoted cleanup intents.
Cleanup batches check references, retain work through outages and retry; storage
and Mongo cannot form one atomic transaction. Namespaced journal uniqueness must
exist in Atlas. Existing storage/flow tests cover this behavior using mocks;
neither live R2 nor Atlas was exercised by this audit.

Recording retention deletes storage first, then clears audioPath and records
audioDeletedAt while retaining session analysis/history. An outage leaves the
session reference for the next daily sweep. Missing objects and second cleanup
are idempotent. If Mongo save fails after deletion, the next sweep can reconcile
the missing object. Account/resource deletion journals cloud cleanup before
removing DB references; failed storage deletes remain retryable. Jobs and sessions
must not receive a TTL index that bypasses this coordination. No TTL was enabled.

**J. Backup strategy.** Actual Atlas tier/backup settings are UNKNOWN. Atlas Free
(M0) has no managed Atlas backups; use mongodump/mongorestore. M10+ supports cloud
backups; snapshots and point-in-time recovery depend on the tier/settings and
must be verified in the selected project. Flex provides daily snapshots.
[Atlas backup capabilities](https://www.mongodb.com/docs/atlas/backup-restore-cluster/).

Assign a named thesis release maintainer and a second reviewer to own backups.
Proposed initial policy: encrypted BSON dump daily and before approved data/index
changes, retain 7 daily and 4 weekly copies, with two access-controlled locations
including an offline team copy. Run during a low-write/paused-write window and
record collection counts, tool/server versions and archive checksum; a plain
dump under concurrent writes is not necessarily a consistent point-in-time view.
Use scoped read/backup permissions and protected tool configuration, not credentials
in shell arguments, logs or backup manifests. Do not archive `.env`, JWT/R2
credentials or signing keys. User password hashes are sensitive application data:
encrypt and restrict the database backup containing them.
[mongodump consistency](https://www.mongodb.com/docs/database-tools/mongodump/mongodump-examples/).

Mongo dumps do not contain R2 audio. Maintain a protected object-key manifest and
an agreed audio backup/retention policy aligned with DB recovery. A database
snapshot can reference audio later deleted by retention; database restore alone
cannot reconstruct it. Backup scheduling/ownership and backup-copy readability
remain proposed, not executed or verified.

**K. RESTORE TEST: NOT TESTED — deployment database not established.** No designated
safe deployment backup was available; mongodump/mongorestore were not found on
PATH. Plan: verify encrypted archive checksum, decrypt on a controlled machine,
restore to an empty isolated `ispeak_restore_test_<runId>` database using namespace
mapping and a user restricted to that destination. Do not use `--drop` or an active
production target. Verify counts, indexes, representative User/Session/Resource
schema values and ObjectId relationships; compare R2 keys to the protected manifest
and check object existence through an approved read-only credential.

Do not start the normal app against a restored copy with production R2 credentials:
startup immediately schedules retention and journal cleanup. Use a read-only
verification harness or an isolated test bucket until cleanup intents and restored
references are reconciled. Record findings and clean up only the explicitly created
restore-test database after authorization. Rehearse monthly and before release.

**L. Startup/failure behavior.** Invalid and unavailable Mongo URI subprocess
probes exited 1, reported startup failure and opened no HTTP listener. The
unavailable probe used a 250 ms URI selection timeout to avoid a 30-second wait;
normal production uses the default timeout. Valid Atlas startup remains untested.
HTTP health tests simulated disconnected/connected/disconnected/reconnected
states and verified 503/200/503/200 with generic bodies. The state check follows
Mongoose's monitoring, so detection is not instantaneous or a per-request ping.

Injected query failures verified auth middleware returns 503, login 500 and
history 500 with generic response bodies. These are controlled errors, not live
failover tests. Driver reconnect is automatic after an established connection
is lost; the HTTP listener remains alive and health returns ready when Mongoose
recovers. An initial connection failure exits and requires the host to restart.
No live drop/recovery was induced, and the existing local Mongo was not stopped.

Startup has a further caveat: if an R2 cleanup-model init fails after Mongo connects,
the catch sets process.exitCode but does not explicitly disconnect or unwind
startup. A connected pool can keep the process alive without HTTP listening.
That post-connect failure path needs focused hardening/testing before deployment;
the clean-exit probes above cover initial connection failures only.

**M. Connection pool.** Installed driver defaults: maxPoolSize 100, minPoolSize 0,
serverSelectionTimeoutMS 30000. Mongoose normally buffers disconnected operations
for up to 10000 ms. No explicit pool/wait-queue/socket tuning is set; URI options
can alter defaults. One process at initial thesis scale can begin with defaults,
subject to actual Atlas tier connection limits, replicas and monitoring. Count
each Node replica's pools/monitor sockets, and tune only after measuring concurrency,
slow queries and outages. No tuning was made.
[Mongoose connection behavior](https://mongoosejs.com/docs/connections.html).

**N. Security findings.** MONGO_URI is server-only environment configuration.
The example has placeholders only. Backend current tracked files contained no
credential-bearing Mongo URI before adding the explicitly labeled documentation
placeholder; this was not a Git-history secret audit. Source/config scans of 65
Flutter and 38 Admin files found no Mongo configuration or credentialed Mongo URI.
No actual private URI was printed. Least privilege, network access and TLS on a
real Atlas connection remain unverified.

Application logs are NOT fully sanitized: startup/shutdown log error.message;
signup, resource reads, history/stats and some user handlers log full error objects;
retention logs database error messages. Driver errors can disclose topology/host
details and duplicate-key values. A malformed configuration can also disclose
URI content through an error. HTTP paths inspected return generic errors, but
this is not proof that all server logs are safe. Replace raw DB errors with safe
error classifications before production and restrict log access. This audit
documented the finding without changing unrelated controller behavior.

**O. Tests.** Baseline npm.cmd test: 93 passed, 0 failed. Final complete npm.cmd
test: **100 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo**. Seven focused DB
tests are included in the normal suite and need no Atlas credentials. They cover
SRV parsing/TLS/database selection, required variable, invalid/unavailable startup,
health states and controlled auth/login/history errors. The first focused run had
one test harness import typo, corrected before the final full passing run.
Read-only local inspection succeeded. Live Atlas integration was not run.

**P. Files changed by this audit.** `.env.example` (Atlas placeholder comments
only), `ATLAS_READINESS.md`, `scripts/databaseReadinessAudit.js`, and
`test/databaseReadiness.test.js`. No dependencies were added. Preexisting R2
working-tree changes were preserved. Ignored test output is
`atlas-node-tests.local.log`. Final `git diff --check` passed.

**Q. Remaining Atlas blockers.** Privately provision the intended Atlas database,
service/test users and URI; verify TLS, role scope and host egress allowlist; run
read-only Atlas duplicate/index inspection; approve required indexes and readiness
policy; address raw database logging and post-connect startup cleanup; exercise
controlled CRUD and outage/recovery only in a dedicated test database; establish
backup ownership/tier configuration and complete isolated restore verification.
The existing LIVE integration script is not a substitute for these safeguards:
it writes through HTTP and directly updates Mongo accounts, and has no enforced
test-database identity check. Do not run it against production by inference.

**R. Deployment decision.** Atlas compatibility can move from PARTIAL / NEEDS
VERIFICATION to **IMPLEMENTED — LIVE PRODUCTION VERIFICATION PENDING**, with the
documented hardening and operational gates still open. It cannot move to
READY FOR INITIAL DEPLOYMENT. Node was not deployed and no existing data was
migrated, changed or deleted. No commit or push was performed.
