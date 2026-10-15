# Railway release preparation — 2026-10-15

Status: local preparation only. No commit, image publication, billing activation,
cloud service, database operation, or account-setting change is authorized by this
document. The operating procedure is [RAILWAY_SESSION_RUNBOOK.md](RAILWAY_SESSION_RUNBOOK.md).
The machine-readable source snapshot is [railway-release-inventory.json](railway-release-inventory.json).

## Evidence and unresolved acceptance

- Phase 1: disposable Atlas permissions/lifecycle and approved-prefix R2 lifecycle passed.
- Phase 2A: private v6/Node startup, service authentication and trusted HTTPS passed.
- Phase 2B: startup/authentication/CORS passed; stopped during English inference
  when Windows available RAM fell below 1 GiB. Filipino/Taglish end-to-end, session
  ownership/deletion, and final workflow log-redaction checks remain incomplete.
- Earlier isolated Python English/Filipino/Taglish compatibility checks passed;
  they do not replace full-stack acceptance or establish speech accuracy.
- Node previously passed 116 tests. This preparation changes documentation only;
  those results are historical, not a new test run.

The first Railway environment must be a restricted acceptance pilot. Real beta/UAT
participation requires completed acceptance, consent/data-retention decisions,
verified backup/restore, and measured operating cost. Do not claim production readiness.

## Files requiring review and explicit staging after approval

Both branches currently match their cached upstream HEADs, with dirty working trees.
This is not a fresh remote synchronization check. Never use blanket staging.

| Repository | Pending runtime/release inputs that must be committed if included |
| --- | --- |
| Node, HEAD c742f3c | server.js; docker/validateConfiguration.js; services/storageService.js; services/audioStorageService.js; services/retentionService.js; new services/readOnlyStartup.js |
| Node verification | new test/integrationIsolation.test.js and test/readOnlyStartup.test.js; review scripts/r2LiveProbe.js separately |
| Node operator evidence | review deployment/ files individually, including this checklist, runbook and inventory; preserve historical reports as dated evidence |
| Python V2, HEAD a8469eb | Dockerfile; .dockerignore; .gitignore; model.py; new model_integrity.py; model_manifests/ispeak-v5.json and ispeak-v6.json |
| Python verification | testing_script/check_v6_linux.py; test_model_integrity.py; test_paired_evaluation.py; test_v6_candidate.py; evaluate_v5_v6.py; evaluation_dataset.template.json; prepare_v6_candidate.py; validate_v6_candidate.py; verify_local_activation.py; verify_model_provisioning.py; verify_provisioned_runtime.py; verify_v6_docker.py |
| Python local/operator work | review DOCKER.md, start_backend.ps1, LOCAL_V6_ACTIVATION.md, MODEL_PROVISIONING.md, MODEL_PROVISIONING_VERIFICATION.md, SECURE_V5_ROLLBACK.md, V5_V6_EVALUATION.md, V6_CANDIDATE_VALIDATION.md and V6_DOCKER_VERIFICATION.md; launcher changes are not cloud-image inputs |

Already tracked dependencies remain release inputs: each Dockerfile/ignore file,
Node package.json/package-lock.json, controllers/middleware/models/routes/services,
Python requirements.txt/requirements-linux.txt, runtime Python modules, acoustic
modules and model configuration/tokenizer metadata admitted by the Dockerfile.
Commit all selected runtime inputs and tests, including imported untracked helpers,
before building a candidate from a clean, isolated release checkout. Do not rewrite
the demonstration checkout or discard its work.

Never commit .env files, protected live-config directories, credentials, recordings,
database dumps, benchmark artifacts, model weight binaries, .venv or node_modules.
Model manifests contain checksums, not model weights. Large private artifacts must
be provisioned separately. Older notes describing a v5 production default are
historical; the current Python Dockerfile's final/default target is v6.

## Image/provenance gate

| Preserved local image | Recorded local content ID |
| --- | --- |
| ispeak-node:local | sha256:cdf92edb724a9c8868e64e654c6f014cae7e1c9d1ae2c8ea651020c062cf37fb |
| ispeak-node:integration-local | sha256:4c9c47a826a233b5079c28b41193956270c9d5ee089f19eadf7979906830028d |
| ispeak-node:readonly-integration-local | sha256:18292eddfc574c6bed09df9247548fe23d97225527c834945cc2c5c9862a8295 |
| ispeak-python-v2:v6-local | sha256:41e3779d97354831b6f5aa4a22b813ef5cf1b0d6dd93c3e6f36fe2f882a3857e |
| ispeak-python-v2:v5-secure-local | sha256:787831cdcbf055eac5b707226dd648f49bb712724cb1696ef18a24744e157a14 |

These are verified historical local artifacts, not new clean-commit release builds
or remote GHCR pull digests. The writable integration image predates the latest
read-only source changes. Do not mislabel its provenance as the current checkout.

The base compose.yaml still selects ispeak-node:local, which lacks test-prefix
support. Do not use that base selection for writable acceptance testing. The existing
integration overlay selects the verified writable image, while the read-only overlay
is for health-only checks. Railway must select an explicitly approved release digest.

- [ ] Review and approve the exact source diff and Python dependency-risk exception.
- [ ] Record clean source commit IDs, target linux/amd64, lockfiles, model-manifest
  hashes, build arguments, toolchain, resolved base-image digests and dependency inputs.
- [ ] Pin future base-image references; current Dockerfiles use version tags.
  Mutable apt repositories and unhashed package downloads mean identical future
  rebuild bytes are not guaranteed. Preserve the tested artifact by digest.
- [ ] Build future candidates with new unique tags only, after separate approval;
  provision only manifest-approved private model files. Reverify checksums and tests.
- [ ] Verify no secrets or recordings in final images or intermediate layers,
  nonroot execution, production guards, ports and writable scratch directories.
- [ ] Record image/SBOM/security evidence; resolve or explicitly accept remaining
  Python advisories. Do not change model selection/weights as a packaging workaround.

## Private GHCR publication plan — future authorization required

Use separate private packages such as ghcr.io/<approved-owner>/ispeak-python and
ghcr.io/<approved-owner>/ispeak-node. Confirm package visibility and organization
permissions, rather than assuming a private Git repository makes every package private.
Approve redistribution rights for adapter, Whisper base and filler artifacts.

After approval, publish unique release tags tied to reviewed source commits and
model manifests; preserve hardened v5 as a separately identified rollback release.
Use an upload identity with only required package-write scope and a separate Railway
read-only read:packages credential. Do not paste either into commands/history or
image layers. Confirm anonymous pulls fail, authorized pulls work, and pulled
manifest/model checksums match. Record remote digests and immutable image paths.
Do not assume a local image ID is automatically its remote registry pull digest.

Keep both release artifacts available independently of Railway's deployment-retention
window. No public model package, mutable latest dependency, automatic image update,
or per-session rebuild is part of the approved design. Private source builds are
possible, but the Git repository omits weights and the present Dockerfile cannot
fetch/provision them itself. Private prebuilt images are the preferred path.

Sources: [Railway private registries](https://docs.railway.com/builds/private-registries),
[GHCR immutable pulls](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Startup/storage audit and data-preservation decisions

Normal Node startup connects Mongoose, creates declared collections/indexes, awaits
StorageCleanup.init(), starts an immediate retention scan and starts cleanup scans
immediately and every minute. There are no separate startup migrations in the
audited paths. R2 construction creates a client/scratch directory, not an SDK request.

The application validates owner-shaped keys and the exact configured R2_TEST_PREFIX
before put/get/delete. Cleanup journals include bucket/endpoint/prefix namespace.
Retention scans the selected database and deletes audio before saving retention
metadata. One replica and stopped/drained deployments avoid overlapping workers;
do not presume distributed upload/delete locking exists.

For persistent beta/UAT, propose RECORDING_RETENTION_DAYS=0 in the FUTURE Railway
environment only, subject to owner approval. The current code then skips expiry
purges. This does not disable intentional account deletion or journal recovery.
Keep cleanup journals and review their pending keys before each restart. Do not
delete journals to make an audit pass. No local .env or existing behavior is changed.

Keep a stable approved database, R2 prefix and namespace across scheduled sessions.
Changing R2_TEST_PREFIX makes old prefixed keys unreadable to that provider. A fresh
prefix is appropriate for a disposable run with separate data, not a resumed UAT
environment. Do not remove the beta prefix to turn the same data into production;
any migration needs its own reviewed mapping and authorization.

The standalone scripts/r2LiveProbe.js currently generates its own run prefix rather
than enforcing the protected authorization record. Do not use it for an approved
exact-prefix test until separately corrected/reviewed. Existing approved-prefix
lifecycle verification used a scoped harness, not that helper.

For writable testing, leave ISPEAK_READ_ONLY_STARTUP and ISPEAK_BACKGROUND_JOBS
unset (normal workers). Do not use the read-only image/overlay: API workflows
intentionally return 503 there. Read-only startup remains available for its narrowly
authorized integration database only. Keep diagnostic credentials separate from
future real production credentials.

## Backup/restore gate before beta/UAT

- [ ] Confirm the Atlas tier and actual backup features with the owner. Free/M0
  does not provide Atlas backups; an authorized mongodump strategy may be needed.
- [ ] Assign a backup owner and approve encryption, access, retention, consent,
  storage location and incremental cost. mongodump/mongorestore were not found on
  this audit's PATH; availability must be established without assuming installation.
- [ ] Proposed target: checkpoint before/after sessions and at most four hours of
  unprotected work; longer sessions need a checkpoint. Proposed RTO: two hours,
  subject to an actual timed restore drill. These are targets, not measured guarantees.
- [ ] Quiesce intake, drain requests and stop Node before a consistent paired
  checkpoint. Back up only the authorized database, including indexes/metadata,
  and the exact corresponding R2 key set. Record checksums, counts, timestamp,
  image digests, model manifests and a DB-to-object mapping. Encrypt recordings and
  user data; keep secrets out of shell arguments, logs, Git and ordinary artifacts.
- [ ] Store a separate recoverable object copy. A DB dump does not restore missing
  R2 bytes; a mirror that propagates deletions is not a sufficient backup.
- [ ] Restore first into a NEW authorized database and isolated object namespace;
  never --drop or overwrite the demo/production database. Review object-key remapping
  and quarantine replayable cleanup journals so restored workers cannot delete live
  objects. Verify collection/index counts, referential mapping and object checksums.
- [ ] Record a successful timed drill and recovery sign-off before real UAT data.
  Do not execute backups, restores, copies or account changes under this preparation.

Source: [Atlas backup limitations](https://www.mongodb.com/docs/atlas/backup-restore-cluster/).

## Release gates and next approval

- [ ] Complete reviewed source provenance and private-registry authorization.
- [ ] Approve the data environment, stable prefix, retention and backup design.
- [ ] Confirm Pro dashboard capacities, three Node static egress IPs, secret scopes,
  actual currency/tax/card costs and hard usage limits.
- [ ] Prepare Railway settings from the runbook, then obtain separate approval for
  registry publication, billing, service creation and Atlas network changes.
- [ ] Complete restricted cloud acceptance: three languages sequentially, timestamps,
  scores/fillers, persistence/checksums, cross-user session access, supported account
  deletion/cascade cleanup, log privacy, restart and shutdown. No real user promotion
  or broad object cleanup. Standalone session DELETE is not implemented.
- [ ] Prove session stop/resume preserves DB and objects, then rehearse hardened v5
  rollback and safe shutdown. Only then approve beta/UAT/final-defense operation.

Exact next step: owner reviews this source/commit inventory, budget/retention/backup
decisions and the open acceptance list. Request explicit authorization to stage and
commit the reviewed allowlist and prepare clean release candidates. No commit or
publication has occurred. A paid pilot requires a later, separate bounded approval.
