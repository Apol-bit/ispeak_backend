# iSpeak controlled cloud deployment runbook

Prepared 2026-10-09. **READY TO START CONTROLLED CLOUD SETUP** means the team can
begin the manual preparation below after account/budget approval. It does **not**
mean ready to deploy every service, open access, or distribute an APK. No cloud
resources, deployments, credentials, commits, or pushes were created by this task.
All live verification below is pending; earlier local tests are not live evidence.

## 1. Scope, source and release evidence

Use only these repositories, branch `main`, project root `/`:

| Component | Team source | Release constraint |
| --- | --- | --- |
| Node | `Apol-bit/ispeak_backend` | Include all reviewed storage/security changes and lockfiles |
| Python V2 | `myfork` -> `Apol-bit/ispeak_python-backendV2` | Preserve `myfork`; do not deploy/push unrelated `origin` |
| Admin | `Apol-bit/ispeak_admin` | Include current verified API-config and Admin changes |
| Android | `Apol-bit/ispeak_frontend` | Include identity/signing guards and release manifest |
| Landing page | Not supplied | Separate teammate source required |

Working trees are dirty and no release SHA is established. First review existing
diffs without discarding anything. A separately authorized team action must commit
and push reviewed source to the correct remotes and record exact SHAs. Inspect
Python evaluation artifacts for consent/provenance before publishing source;
do not publish private recordings, model weights, secrets or signing material.
Exclude `ispeak_python-backend` entirely.

Prior local evidence: Node 109 passed / 0 failed; Node dependency audit zero
vulnerabilities; Python security/admission tests 33 native and 33 Linux passed;
container real inference and reference inference preserved their baseline.
These results predate this documentation-only continuation. Consult
[SECURITY_READINESS.md](SECURITY_READINESS.md), [ATLAS_READINESS.md](ATLAS_READINESS.md),
[R2_STORAGE.md](R2_STORAGE.md), and Python V2's
`ACCELERATE_PRODUCTION_DISPOSITION.md` and `DOCKER_LOCAL_VERIFICATION.md`.
The accepted Accelerate disposition supersedes earlier statements that its
advisory alone prohibits controlled thesis deployment; all other gates remain.

## 2. Manual ownership and secret handling

Every step marked **TEAM MANUAL ACTION** happens in the team's own account or
private terminal. Never send secret values to Codex, screenshots, Git, build logs
or this document. Host secret settings are runtime configuration; Flutter's
`API_BASE_URL` is public compiled configuration. Placeholder URLs below are not
working endpoints. Record actual values privately after creation.

| Task | Codex can prepare? | Team must do manually? | Secret/payment/account access? |
| --- | --- | --- | --- |
| Atlas project/cluster/database | Steps and sizing | Yes | Account; possible payment |
| Atlas application user | Permission plan | Yes | Secret and account |
| R2 private bucket | Bucket plan | Yes | Account; usage billing |
| R2 scoped credentials | Configuration mapping | Yes | Secret and account |
| Railway project | Service plan | Yes | Account and budget |
| Railway service creation | Build/start/health plan | Yes | Account and usage billing |
| Environment variables | Names and safe defaults | Yes for live secret entry | Secrets and account |
| Billing/resource approval | Estimates and gates | Yes | Payment decision |
| Model artifact/private registry | Provisioning design | Yes; trusted artifact upload later | Private assets, account, possible payment |
| Keystore creation | Interactive instructions | Yes | Private key |
| Android password entry | Ignored template/guards | Yes | Secret |
| Physical phone testing | Test checklist | Yes | Device and approved test identity |
| Landing-page source handoff | Requirements | Yes | Teammate repository access |
| Review/release SHAs | Diff and check preparation | Team authorizes commit/push separately | Repository permissions |

Assign named deployment, privacy/backup and Accelerate-risk owners. Record budget,
participant roster, test-data consent, approved endpoints and gate evidence in a
private release ledger. Do not record credentials or transcripts in that ledger.

## 3. Atlas manual runbook

1. **TEAM MANUAL ACTION:** create/select the team Atlas project, choose a region
   near the future Railway services, and select a budget-approved cluster tier.
   Use separate test and production databases/users. Proposed production database
   name: `ispeak_prod`; verify that name before entering the URI.
2. **TEAM MANUAL ACTION:** create the database and application user scoped to
   `readWrite` on that database only, not cluster-wide/admin access. Keep a separate
   maintenance identity for backups/index work; never place it in Node settings.
3. **TEAM MANUAL ACTION:** configure Network Access for exact approved outbound
   addresses. Railway static outbound IPs require Pro; include all addresses the
   service actually provides, recheck after region changes. These are egress
   addresses for Atlas, **not** `TRUST_PROXY_CIDRS`. Do not leave `0.0.0.0/0` as
   the normal production policy. See [Railway static outbound IPs](https://docs.railway.com/networking/static-outbound-ips).
4. **TEAM MANUAL ACTION:** obtain the Atlas `mongodb+srv` connection URI, insert a
   URL-encoded password and explicit database name privately, retain TLS and
   certificate verification. Put it in Node `MONGO_URI`, not `MONGODB_URI`.
5. From an approved network with the URI privately injected, run from Node's root:
   `node scripts/databaseReadinessAudit.js`. This tool disables auto-index/create,
   reads collection/index/duplicate summaries, and does not start background jobs.
   Verify ping, explicit database selection and zero conflicting user duplicates.
6. Compare live indexes with current `models/*.js`, including unique user email
   and username and StorageCleanup unique `{namespace:1,key:1}` plus
   `{namespace:1,nextAttemptAt:1}`. Arrange a reviewed index-maintenance window if
   needed. Do not blindly use `syncIndexes`, drop indexes, or add a TTL index.
   Node currently uses Mongoose's automatic index/create behavior; application
   startup alone is not proof all indexes finished successfully.
7. **TEAM MANUAL ACTION:** choose and test backups before participant access.
   M0 has no Atlas-managed backups; use a privately stored encrypted scheduled dump
   with a documented restore drill, or approve a tier with managed backups. Flex
   snapshots and dedicated-cluster backup features differ; verify the chosen
   tier's actual retention/PITR. See [Atlas backup options](https://www.mongodb.com/docs/atlas/backup-restore-cluster/).
8. Restore into an isolated database with isolated bucket credentials and no
   production background workers. Record restore duration, counts/indexes and
   audio-reference integrity. A database backup alone does not back up R2 audio;
   expired audio may be absent from older DB snapshots. Define recovery objectives
   and object-backup/manifest policy explicitly.

Live Atlas connectivity/indexes/restore: **NOT VERIFIED — live configuration pending**.

## 4. R2 manual runbook and disposable verification

1. **TEAM MANUAL ACTION:** create a private Standard-class production audio bucket.
   Keep `r2.dev` and public custom-domain access disabled. Do not set lifecycle
   deletion that bypasses application references/retention.
2. **TEAM MANUAL ACTION:** create S3 Object Read & Write credentials limited to
   that bucket. Do not give bucket-admin/account-wide access. Record privately:
   `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_ENDPOINT`, `R2_REGION`. The normal endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`; region is `auto`.
   Source: [R2 S3 setup](https://developers.cloudflare.com/r2/get-started/s3/).
3. Configure Node `STORAGE_DRIVER=r2`. The implementation requires bucket and
   both key values, plus either account ID or endpoint. Record both account and
   endpoint for operational clarity; ensure they identify the same account.
4. Provision a **separate disposable test bucket and scoped test credentials**.
   With an approved short synthetic/consented audio fixture, run an isolated
   harness using `R2StorageProvider` from `services/storageService.js`:
   `createKey` -> `storeFile` -> `openReadStream` -> compare bytes/SHA-256 ->
   `delete` -> repeat delete -> confirm missing object. Use an ObjectId owner and
   UUID key generated by the provider; keep an exact-key cleanup ledger.
   This is the required future test procedure, not a supplied live-test script.
   Never use real participant audio as a disposable fixture.
5. In an isolated test DB/bucket, exercise the application scenarios in section 10
   and prove cleanup survives process restart. Avoid fault injection against the
   live production bucket. Confirm unauthenticated direct audio access is denied.
6. Keep public APK distribution in a separate bucket/project/location with
   separate permissions; a different prefix in the private audio bucket is not
   sufficient separation. Never make the speech bucket public to serve an APK.

Keys are `recordings/<ownerObjectId>/<UUID>.<validated-extension>` and
`reference-audio/<resourceObjectId>/<UUID>.<validated-extension>`. User filenames
are not object paths. The provider rejects unsafe keys and validates audio
size/signature; read access stays behind authorized Node routes. No public audio
URL/presigned browser upload is required. Existing local paths are **not** migrated
by switching the driver. Before retaining existing data, execute a separately
approved manifest-based copy/verify/DB-reference update migration, preserve old
files until rollback and reference verification succeed, and never treat the
unclassified inventory as permission to delete.

LIVE R2 INTEGRATION: **NOT TESTED — credentials/test bucket not configured**.

## 5. Railway Python V2

**TEAM MANUAL ACTION:** after spending approval, create/select the Railway project
and a new environment for two services. Suggested logical service names are
`ispeak-python-v2` and `ispeak-api`; these are labels, not established endpoints.
Use one region/environment and one replica of each service. Disable automatic
unreviewed redeploys during controlled validation.

| Setting | Required handoff |
| --- | --- |
| Reviewed source | `myfork` -> `Apol-bit/ispeak_python-backendV2`, `main`, recorded SHA |
| Container definition | Root `Dockerfile`; Python 3.13.12 CPU image, UID/GID 10001 |
| Build source | Trusted private model-inclusive context or pinned private OCI image digest |
| Start | Preserve Dockerfile CMD: `python -m uvicorn fastapi_backend:app --host 0.0.0.0 --port ${PORT:-${ISPEAK_PORT:-8000}} --workers 1` |
| Port | Set `PORT=8000`; `ISPEAK_PORT=8000` is the fallback |
| Network | Private only; do not generate public ingress/domain |
| Health | `/health`, deployment timeout 300 seconds; require models ready |
| Resources | 6 GiB minimum; 8 GiB safer; start with capacity for 4 vCPU |
| Admission | One active inference, four queued, 30-second queue wait |
| Restart | Bounded `ON_FAILURE`, proposed maximum 5 retries; observe crash/OOM behavior |
| Storage | Models/code root-owned and unwritable by runtime UID; writable scratch only |

**Model provisioning is a deployment blocker until resolved.** Required
`models/iSpeak_v5` (adapter and base model) and `models/filler_classifier` are not
in Git. A Git-only Docker build will not satisfy the Dockerfile's COPY steps.
Provision approved trusted model artifacts privately, record their hashes, then
build the existing Dockerfile from that controlled context. Recommended handoff:
push to an approved **private** OCI registry and deploy the recorded image digest.
Railway private registry credentials require Pro; no public model image as a
shortcut. If the team instead selects host-side artifact provisioning, prepare
and review that workflow before deployment. Do not embed credentials in build
arguments or images. See [private registry deployment](https://docs.railway.com/builds/private-registries).

Local measurements: readiness about 17–18 seconds, first inference about 49
seconds, warm inference about 15–17 seconds, reference inference about 41 seconds.
Peak observed memory about 4.72 GiB; image content about 1.85 GB, expanded about
3.84 GB, model files about 1.62 GB. Cloud build/pull/readiness and CPU performance
remain unmeasured. Do not equate health passing with an inference benchmark.

Record the **actual** assigned private domain after service creation. New Railway
environments use dual-stack private networking; older ones may be IPv6-only.
Verify A/AAAA resolution and connection from Node. Docker binds `0.0.0.0`;
changing `ISPEAK_HOST` does not change this Docker CMD. An IPv6-only environment
needs a separately reviewed binding/network solution before proceeding. See
[Railway domains/private networking](https://docs.railway.com/networking/domains/working-with-domains).

Accelerate is **accepted risk for controlled thesis use**, not patched or safe
for unrestricted public use. Enforce: private Python + service token, trusted
offline unsharded models, immutable code/models, no user checkpoints, one CPU
worker and a restricted participant group. Keep GPU/distributed workflows off.
Assign a named risk owner, review weekly and reassess by 2026-11-08 or immediately
on model/dependency/exposure changes. Missing any control is NO-GO; see the
Python disposition for advisory IDs and supporting runtime/removal evidence.

## 6. Environment matrix: actual application names

**TEAM MANUAL ACTION:** enter all live secret values privately in host settings.
No placeholder below is a production secret. Secret rotations require coordinated
rollout; changing JWT signing secrets invalidates existing tokens.

### Node runtime

| Name | Production handoff |
| --- | --- |
| `MONGO_URI` | Secret Atlas SRV URI with explicit production database |
| `JWT_SECRET` | Independent cryptographically random secret, at least 32 characters |
| `JWT_EXPIRES_IN` | `7d` initially; approved session policy |
| `JWT_ISSUER` | `ispeak-api` |
| `JWT_AUDIENCE` | `ispeak-clients` |
| `TERMS_VERSION` | `1.0`, matching published consent terms |
| `NODE_ENV` | `production` |
| `PORT` | Explicit `5000` for this service; match Railway routing/health |
| `CORS_ORIGINS` | Required nonempty exact approved HTTPS browser origins, comma-separated; no paths/wildcards |
| `TRUST_PROXY_CIDRS` | Only independently verified ingress peer IPs/nonzero CIDRs; initially empty |
| `PYTHON_BACKEND_URL` | Actual private Python base URL with port; no `/api` or `/transcribe` suffix |
| `PYTHON_SERVICE_TOKEN` | Secret >=32 characters, identical to Python `ISPEAK_SERVICE_TOKEN` |
| `PYTHON_TIMEOUT_MS` | `300000`; verify real ingress/client timeout compatibility |
| `STORAGE_DRIVER` | `r2` |
| `R2_ACCOUNT_ID` | Actual account ID |
| `R2_BUCKET` | Private production audio bucket |
| `R2_ACCESS_KEY_ID` | Secret scoped S3 credential |
| `R2_SECRET_ACCESS_KEY` | Secret paired S3 credential |
| `R2_ENDPOINT` | Actual account HTTPS S3 endpoint |
| `R2_REGION` | `auto` |
| `RECORDING_RETENTION_DAYS` | `30` initially, approved consent/retention policy |
| `AUTH_RATE_LIMIT_MAX` | `20` per 15-minute IP window |
| `ANALYSIS_RATE_LIMIT_MAX` | `10` per minute per authenticated user; one in-flight upload per user |
| `ALLOW_LOCAL_STORAGE_IN_PRODUCTION` | `false`; do not override for Railway ephemeral storage |
| `LOCAL_STORAGE_ROOT` | Development-only `uploads`; unused for durable R2 audio |

There are no implemented queue-cleanup-interval or retention-schedule environment
variables. Cleanup scan is 60 seconds, batch at most 100; failed deletion is
rescheduled after 60 seconds; new upload intent recovery delay is 24 hours.
Retention runs immediately at startup and daily. Do not invent configuration names
for these constants. Admission/rate limits are process-local, hence one Node replica.

### Python runtime and image settings

| Name | Production handoff |
| --- | --- |
| `ISPEAK_ENV` | `production` |
| `PORT` | `8000` |
| `ISPEAK_PORT` | `8000` fallback |
| `ISPEAK_HOST` | Docker default `0.0.0.0`; does not override Docker CMD bind |
| `ISPEAK_SERVICE_TOKEN` | Same private secret as Node `PYTHON_SERVICE_TOKEN` |
| `ISPEAK_CORS_ORIGINS` | Empty; browsers/mobile do not call Python |
| `ISPEAK_MAX_UPLOAD_MB` | `25` |
| `ISPEAK_MAX_CONCURRENT_INFERENCES` | `1` |
| `ISPEAK_MAX_QUEUED_ANALYSES` | `4` |
| `ISPEAK_QUEUE_TIMEOUT_SECONDS` | `30`; slot wait, not inference execution timeout |
| `ISPEAK_MODEL_PATH` | Default `models/iSpeak_v5` under `/app` |
| `ISPEAK_BASE_MODEL_PATH` | Default `models/iSpeak_v5/base_model` |
| `ISPEAK_FILLER_MODEL_PATH` | Default local `models/filler_classifier` |
| `ISPEAK_DEBUG_SPEECH_LOGS` | `false` |
| `ISPEAK_DEBUG_ERRORS` | `false` |
| `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE` | Image defaults `1`; retain |
| `TMPDIR`, `NUMBA_CACHE_DIR`, `HF_HOME` | Image defaults under `/tmp/ispeak`; retain |
| `PYTHONDONTWRITEBYTECODE`, `PYTHONUNBUFFERED`, `PIP_NO_CACHE_DIR` | Image defaults `1`; retain |

The filler model is provisioned by the current Dockerfile at
`models/filler_classifier`; its implemented override is `ISPEAK_FILLER_MODEL_PATH`.

### Build/client settings, not application runtime variables

| Component | Setting |
| --- | --- |
| Node Railpack | `RAILPACK_NODE_VERSION=24.14.0`; `RAILPACK_INSTALL_CMD=npm ci --omit=dev --ignore-scripts` |
| Admin Flutter | Compile-time `API_BASE_URL=https://<actual-api-domain>/api` |
| Android Flutter | Same compile-time public API URL; production HTTPS required |
| Registry/account settings | Private pull credentials in host settings, never Node/Python env or image |

Node has both npm and Yarn locks; the explicit npm install command prevents an
accidental switch. See [Railpack Node version](https://railpack.com/languages/node/)
and [Railway install override](https://docs.railway.com/builds/build-configuration).

## 7. Railway Node and private Python validation

**TEAM MANUAL ACTION:** create Node service from the reviewed team repo/SHA,
root `/`, Railpack build, npm install override above, start `node server.js`.
One replica; initial Node budget/capacity recommendation 0.5–1 GiB and 1 vCPU,
then measure real load. This Node sizing is a planning estimate, not a benchmark.
Use `/health`, health timeout 300 seconds, bounded `ON_FAILURE` up to 5 retries.
No persistent audio volume is required for R2; scratch uploads remain ephemeral
and require capacity/cleanup monitoring. Configure all variables before starting.

1. Obtain Python's actual private domain and reachable port from the same Railway
   environment. Set `PYTHON_BACKEND_URL` to `http://<actual-private-domain>:8000`
   (private transport only). Do not substitute a guessed internal hostname.
2. **TEAM MANUAL ACTION:** privately inject the same token into both services.
   Never put it in Android/Admin. Python `/health` is minimal and unauthenticated;
   its success does not prove service-token authentication.
3. From Node's running container/private network, resolve DNS and GET Python
   `/health`. Expect model readiness without paths/secrets. Prove authenticated
   analysis using `X-iSpeak-Service-Token`, approved multipart `file` fixture and
   expected results. Wrong/missing token must reject before analysis; private
   Python must have no public ingress. Do not print request auth headers.
4. Verify end-to-end through authenticated Node `/api/upload-audio`, multipart
   field `audio`, without any client connection to Python. Verify reference-audio
   analysis through Node as well. Record latency and memory under bounded load.
5. Verify Node `/health`, Atlas selected database/indexes, R2 read/write/delete,
   and Python independently. Node health is DB-only and does not attest to R2,
   inference, completed indexes, or private token validity.

Node startup may execute retention/cleanup before accepting requests. Do not point
an experimental worker at production credentials to perform destructive tests.
Railway health checks gate deployments, not continuous runtime availability;
add an approved runtime monitor for Node and in-network Python readiness plus
resource/cleanup failures. See [Railway health checks](https://docs.railway.com/deployments/healthchecks).

### Public ingress and participant restriction gate

Expose **Node only** over the actual Railway HTTPS URL. Before access, verify
real proxy peer addresses and how the platform overwrites `X-Forwarded-For`,
`X-Real-IP` and `X-Forwarded-Proto`. Test two separate clients and spoofed headers
through a restricted diagnostic harness; do not publish request-header dumps.
`req.ip` drives the auth limiter; merely receiving `X-Real-IP` does not configure
Express trust. Enter only proven ingress CIDRs; never `true`, arbitrary hop counts
or `/0`. Verify separate client rate-limit buckets and denied spoofing. An empty
trust setting is safe from spoofing but may aggregate all users behind one proxy.

Validate actual host upload/body-size and request-duration limits against the
25 MB Python cap and 300-second Node timeout, including cold inference and queues.
See [Railway public ingress specifications](https://docs.railway.com/networking/public-networking/specs-and-limits).
Do not assume the Node timeout extends the platform's timeout.

**Open signup currently permits arbitrary internet users to obtain analysis
access.** CORS, a private Python URL and an unadvertised Node URL do not enforce
the accepted limited-participant control. Before public ingress/UAT, implement or
configure an approved enrollment/edge restriction that works for native Android
and Admin, including mobile data; prove an unapproved client cannot enroll or
analyze. Browser-only Access flows are not automatically Android-compatible.
No such mechanism is claimed implemented by this documentation task.

## 8. Admin Cloudflare Pages and web origins

Source `Apol-bit/ispeak_admin`, `main`, repository root `/`. Include current
verified changes before building. Pin Flutter 3.41.2 / Dart 3.11.0 used in the
local verification; run from Admin root:

```text
flutter pub get
flutter build web --release --dart-define=API_BASE_URL=https://<actual-api-domain>/api
```

Output: `build/web`. Recommended first handoff: reviewed CI/local build with the
explicit SDK, then **TEAM MANUAL ACTION:** Pages Direct Upload of that directory.
Do not assume Pages' generic builder includes Flutter. If Git-integrated Pages is
chosen, provision the pinned SDK in an approved build workflow and use the same
command/output. Do not silently upload a placeholder-API artifact as production.

**TEAM MUST PROVIDE AFTER DEPLOYMENT URL EXISTS:** actual Admin Pages HTTPS origin,
any approved custom Admin domain, and landing-page origin **only if** it calls
Node. Set exact comma-separated values in Node `CORS_ORIGINS`; omit paths, `/api`,
wildcards and unapproved preview domains. Android native HTTP is not governed by
browser CORS. Test preflight, login and authenticated API calls from the actual
Admin origin; reject an unapproved origin. Production startup rejects empty
`CORS_ORIGINS`. Before Node deployment, reserve/create the team's Pages project
without publishing the Admin build and record its actual assigned HTTPS origin,
or use an already owned and approved Admin domain. Approve and configure that
real origin first; do not invent a placeholder origin to bypass startup. Publish
the Admin build later after the API is verified. Keep access restricted throughout.

Use HTTPS. Verify route refresh/deep links and asset MIME types. Pages supplies
SPA fallback when no top-level `404.html` is present; confirm the final Flutter
artifact follows that convention. See [Pages SPA serving](https://developers.cloudflare.com/pages/configuration/serving-pages/).

Prepare a `_headers` file in the served output (or source copied to output) before
upload. Proposed static-site baseline:

```text
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'
```

Verify actual response headers and Admin operation. This is a preparation snippet,
not a claim the headers are currently installed. Test a fuller script/connect/font/
worker CSP in report-only mode against the actual Flutter renderer/CDNs/API before
enforcement; avoid guessing dependencies or inventing a report endpoint.
`_headers` applies to static Pages output; Functions require their own response
headers. See [Pages headers](https://developers.cloudflare.com/pages/configuration/headers/).
Admin tokens currently use browser storage, with an acknowledged XSS exposure;
do not describe the baseline CSP as eliminating that risk. Named admin bootstrap
requires a separately approved, exact-account role promotion; no public admin
signup or bulk role update.

## 9. Landing page and Android handoff

**LANDING PAGE SOURCE: NOT AVAILABLE IN CURRENT WORKSPACE.** The Flutter web
shell is not a supplied standalone landing page. Do not recreate it or claim its
deployment ready. Teammate must provide source repo/folder, branch/release SHA,
framework/SDK, build command, output directory, current screenshots/content,
approved domain, APK download CTA, and QR destination if used. Review privacy,
download URL, accessibility and headers before its separate Pages deployment.

Android signing is **deferred — team signing setup pending**. After real Node
HTTPS and privately configured team signing exist, follow frontend
`ANDROID_RELEASE.md` and `ANDROID_RELEASE_VERIFICATION.md`:

1. **TEAM MANUAL ACTION:** reuse the team's release key or generate it interactively;
   privately configure ignored `android/key.properties` with the existing template.
   Keep key/password backups private. Do not generate passwords in chat or Git.
2. Confirm `com.ispeak.app`, namespace/MainActivity consistency, version `1.0.0+1`.
   Before building, determine whether versionCode 1 has already been distributed
   under this ID; if so choose a greater code. Record the approved version.
3. From frontend root, build only with the actual approved URL:

   ```text
   flutter build apk --release --dart-define=API_BASE_URL=https://<actual-api-domain>/api
   ```

4. Verify `build/app/outputs/flutter-apk/app-release.apk` with SDK
   `apksigner verify --verbose --print-certs`; compare certificate fingerprint to
   the team's approved release key. Use `aapt dump badging` (or equivalent SDK
   inspection) for package/version, and PowerShell `Get-FileHash -Algorithm SHA256`
   for the artifact. Record SDK tool versions, SHA-256, certificate, API URL and SHA.
   No debug-signed, placeholder-URL or stale APK may be treated as distributable.
5. Upload a **versioned restricted UAT candidate** only, with hash/version metadata;
   install that exact artifact on physical devices. Test Wi-Fi, mobile data,
   microphone permissions/denial/recovery, signup/login, uploads, references,
   scores/history, logout and reconnect. Capture no participant transcripts in
   public test reports. Test reinstall/update with the same signing identity.
6. Complete restart/redeploy survival tests, freeze the verified artifact, then
   authorize distribution of the identical hash. Landing CTA/QR must resolve to
   that approved version. Pages' single-asset limit is 25 MiB; use separate APK
   hosting if exceeded. See [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).

## 10. Live acceptance, persistence and operational checks

Run disposable tests first with isolated DB/bucket/identities and exact-ID/key
cleanup records. Do not blindly run existing mutating integration scripts against
production or perform broad collection/bucket cleanup. Use synthetic/consented
fixtures, no raw SDK errors, auth headers, passwords or audio in shared logs.

| Scenario | Required live evidence |
| --- | --- |
| Auth/ownership | Login, current terms, own history; other-user access, banned/archived users and unapproved participant rejected |
| User recording | Python succeeds -> durable object -> DB session; audio readable after Node restart |
| Python failure | No false Completed session or durable successful-upload claim |
| R2 PUT failure | No Completed session; durable intent retained where necessary; sanitized storage error |
| Mongo save failure after PUT | No false Completed session; ambiguous acknowledgement resolved by reference lookup; unreferenced object cleanup retried |
| References | Create/read/replace/delete; old object remains until DB replacement succeeds; concurrent replacement does not lose winner |
| Reference download failure | Storage failure before Python invocation, distinguish from engine failure |
| Cleanup journal | Unique namespace/key intent before PUT, restart retry, referenced object preserved, repeated failure retained, successful delete resolves intent |
| Retention | Eligible test object deletes and marks session audio absent while history remains; missing object accepted; outage deferred, retry succeeds, second cleanup idempotent |
| Account/resource deletion | Cloud failure retains retryable cleanup; no unrelated or still-referenced object deletion; confirm actual route state and sanitized response |
| Safety | Traversal/wrong ownership/oversized or invalid audio rejected; private bucket inaccessible anonymously; credentials absent in logs/responses/artifacts |
| Survival | Existing session/reference reads after Node/Python restart and reviewed redeploy; journal persisted in Atlas; no reliance on old container filesystem |

The journal has no distributed lease and admission limits are process-local.
One replica is required initially. Rolling deployments can briefly overlap old
and new instances; quiesce uploads/cleanup during the controlled redeploy window
and verify safe completion/retry before reopening. Scaling requires separately
reviewed shared admission and cleanup coordination.

Monitor Node uptime/error rate, Python readiness/inference latency/queue rejection,
CPU/RAM/OOM/restarts, Atlas connections/storage/index status, R2 failures, oldest
cleanup intent/attempt growth, scratch usage and spend. Current DB pool defaults
include max 100 connections; assess live tier limits before considering replicas.
Assign alert recipients and an outage response: close admissions, preserve journal
and objects, restore known source/image/config, recheck dependencies and reopen
only after gate evidence. Do not change bucket/account endpoints casually: journal
namespace includes endpoint/bucket, so old intents require reconciliation.

## 11. Spending decisions — no purchases authorized here

**TEAM MANUAL ACTION:** approve a monthly ceiling, warnings and response owner
before paid creation. Railway usage is not confined to the base subscription.
Current published service rates: RAM $10/GB-month, CPU $20/vCPU-month; Hobby
$5/month and Pro $20/month include matching usage credit. Python's 6–8 GiB/4 vCPU
capacity requires paid resources; actual metered usage determines cost. At full
8 GiB and 4 vCPU continuously, Python alone is roughly $166/month at these rates
(GiB converted to GB), before other usage. Lower average usage reduces cost;
this is a ceiling illustration, not a forecast. Pro is recommended for the private
registry and stable Atlas egress workflow. See [Railway pricing](https://docs.railway.com/pricing/plans).

| Decision | Approval point |
| --- | --- |
| Python resources/private registry | Before Railway plan selection and first running container |
| Node usage/egress | Before Node launch; budget separately from Python |
| Atlas paid tier | Before upgrade if free capacity/backups inadequate |
| R2 usage | Before billing enablement/overage; track audio count, duration and API operations |
| Custom domain | Optional; approve purchase/renewal and DNS ownership separately |
| Backup/monitoring/registry | Check independent storage and service charges |

R2 Standard currently includes 10 GB-month storage, 1 million Class A and
10 million Class B operations free; above that storage is $0.015/GB-month and
operations $4.50/$0.36 per million respectively. R2 internet egress is free;
Railway/provider traffic can still incur costs. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
Recheck rates at approval. Hard spending caps can cause an outage; explicitly
accept that behavior and set alerts before the cap. See
[Railway cost control](https://docs.railway.com/pricing/cost-control).

## 12. Separate GO / NO-GO gates

All required evidence must be recorded with date/owner and exact artifact/config
identity. A missing prerequisite is NO-GO for that gate, not proof setup cannot
start. Current live values, signatures and runtime proofs are absent.

| Gate | Prerequisites and evidence | Current state/blockers |
| --- | --- | --- |
| 1 — READY TO START CLOUD SETUP | Reviewed runbook, correct source remotes, assigned team owners, account/budget approval before paid actions | Preparation READY; team account/budget actions pending; no automation authorized |
| 2 — READY TO DEPLOY PYTHON | Reviewed pushed SHA, trusted hashed models/private artifact workflow, approved 6–8 GiB/4 vCPU capacity, shared secret, private network and all Accelerate controls | NO-GO: models/registry workflow, budget and live service config pending |
| 3 — READY TO DEPLOY NODE | Atlas and R2 disposable tests, indexes, correct URI/token, private Python readiness/authenticated inference, production env including actual approved nonempty CORS origin, restricted ingress/test access | NO-GO: live dependencies, origin, proxy/access restriction and environment pending |
| 4 — READY TO DEPLOY ADMIN | Verified Node HTTPS, approved actual Admin origin/CORS, reviewed current source, pinned build SDK, working SPA and headers, restricted admin access | NO-GO: live URL/origin and runtime verification pending |
| 5 — READY TO BUILD FINAL APK | Real API, private team keystore/key.properties, approved versionCode, reviewed Android source and signing guards | NO-GO: signing deferred and real URL absent |
| 6 — READY TO OPEN CONTROLLED UAT ACCESS | Gates 2–5, restricted signed candidate, enforced participant roster, privacy consent, backup restore, all live failures/persistence tests, owner approval | NO-GO: live evidence and enrollment/edge restriction pending |
| 7 — READY TO DISTRIBUTE APK | Physical Wi-Fi/mobile/microphone UAT, restart/redeploy success, verified cert/hash/version, frozen source/config, final approval, authorized hosting/CTA | NO-GO: UAT and release identity pending |

General unrestricted launch is outside the accepted Accelerate exception. A
missing landing page blocks that page/CTA handoff, not isolated backend setup;
do not mark it deployed or ready without teammate source.

## 13. Exact ordered rollout (future team actions)

1. Review all preserved changes; separately authorize commit/push to team remotes
   (Python `myfork`), record reviewed SHAs. Assign owners and approve budget/access
   restriction/model provisioning plan before paid or exposed workloads.
2. Create/select Atlas, database/user, network policy and backup plan.
3. Create private production R2 bucket and isolated test bucket/scoped credentials.
4. Run live Atlas connectivity/read-only audit/index/restore checks from approved
   access; finalize Railway egress allowlist once assigned before Node launch.
5. Run live disposable R2 upload/read/delete and isolated failure tests.
6. Create Railway project/environment after billing/resource approval; configure
   private model artifact/registry and service settings with no public Python.
7. Deploy Python V2 only after Gate 2 using reviewed model-inclusive image/context.
8. Verify private Python health, token rejection/success and bounded inference.
9. Reserve/create the Admin Pages project or approve an owned Admin domain, obtain
   its actual origin without publishing the build, and enter nonempty exact CORS.
   Deploy Node behind the approved restriction after Gate 3.
10. Verify Node -> Atlas/R2/private Python, full audio lifecycle and independent
    dependency health. Recheck exact Atlas network allowlist.
11. Verify HTTPS API, trusted ingress/spoof resistance, limits, access restrictions
    and sanitized failures; no unrestricted participant access yet.
12. Build/deploy Admin after Gate 4; record actual origin, update exact CORS and
    validate preflight/auth/deep links/headers on the served artifact.
13. Obtain teammate landing-page source and required handoff details.
14. Review/build/deploy that separate page; approve its domain and CTA target.
15. Team creates/reuses Android keystore privately.
16. Team configures ignored signing properties and verifies version policy.
17. Build and inspect signed APK after Gate 5 with real production API URL.
18. Publish versioned **restricted UAT candidate**, hash and release metadata.
19. Open only approved controlled UAT after Gate 6; perform physical production
    Wi-Fi/mobile-data/microphone and lifecycle checks on that exact candidate.
20. Quiesce admissions, perform restart/redeploy survival checks, verify recovery,
    reopen only with recorded passing evidence.
21. Freeze source/image/model/config versions and the exact passing APK hash;
    approve Gate 7, then enable intended distribution/landing CTA/QR. No rebuild
    between verification and distribution without repeating relevant checks.

The plan is ready for controlled setup. Live deployment readiness remains staged;
no live Atlas/R2/Python/Node/Admin/Android success is claimed by this runbook.
