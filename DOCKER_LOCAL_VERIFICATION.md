# Node Docker local verification — 2026-10-14

**Node packaging: IMPLEMENTED — CLOUD DEPLOYMENT VERIFICATION PENDING.**
The production image built and passed local startup, TLS MongoDB, private Python,
configuration, health/outage/recovery, authentication and shutdown checks. This
does not establish live Atlas/R2 or Railway readiness. No deployment, commit,
push, image publication, existing-data modification or Python V2 production
change occurred. Legacy Python was excluded.

## Exact files added

- `Dockerfile`
- `.dockerignore`
- `.gitattributes` (Docker shell LF endings on Windows checkouts)
- `docker/entrypoint.sh`
- `docker/validateConfiguration.js`
- `scripts/verifyNodeDocker.py`
- `testing/nodeDockerChecks.js`
- `DOCKER.md`
- `DOCKER_LOCAL_VERIFICATION.md`

The initial Node working tree was clean at
`53c5edcb9fe252a01b1b937a02ff404768e9c718`; this HEAD remains unchanged. No existing
application files, dependency manifests/lockfiles, auth/scoring/storage behavior,
MongoDB schemas or API contracts were modified. The local Windows `.env` retained
its original SHA-256 and default local driver. Python V2's working tree remains
clean. All nine new files are left uncommitted for review in this historical
local verification report. Subsequent authorized publication is recorded below.

## Build and image

| Item | Result |
| --- | --- |
| Local host Node | v24.14.0 |
| Container runtime | v24.21.0, Node 24 LTS, Debian Bookworm slim |
| Base digest resolved by build | sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 |
| Build | docker build -t ispeak-node:local . — PASS |
| Configuration check | docker build --check . — PASS, no warnings |
| Final image ID | sha256:cdf92edb724a9c8868e64e654c6f014cae7e1c9d1ae2c8ea651020c062cf37fb |
| Docker inspect Size | 86,421,945 bytes, approximately 86.4 MB / 82.4 MiB |
| Architecture | linux/amd64 |
| Dependency installation | npm ci --omit=dev from existing package-lock; 150 production packages |
| Runtime identity | node, verified UID 1000 |
| Image exclusions | No .env, Git, uploads, host scripts/tests/testing or ESLint |

The size is Docker's reported image Size, not a claim about total Docker Desktop
disk use or all expanded/shared filesystem layers. The default-deny
`.dockerignore` and explicit COPY operations include every required runtime file
and exclude development secrets, recordings, credentials, caches and outputs.
The existing SDK, bcryptjs, Express, Mongoose and runtime modules worked on Linux;
no production Linux incompatibility required an application change.

## Final disposable-container checks

The final run used an internal Docker network, no published host ports, a fresh
MongoDB 8 TLS database, the existing verified private Python image, and production
Node with synthetic R2 configuration. All credentials were generated only in
process memory. The test CA/key were temporary, not committed or retained in
reports. Windows text-to-speech generated the harmless WAV; no user audio was used.

| Check | Result |
| --- | --- |
| Production Node startup | PASS, 3.67 seconds including Docker run and readiness sampling |
| Dynamic PORT and 0.0.0.0 listener | PASS, port 5087 reached from another private container |
| Read-only application root / writable scratch | PASS, 128 MiB test-only /tmp tmpfs |
| /health with connected database | 200, connected |
| Database stop/outage | /health 503, disconnected |
| Database restart/recovery | /health 200, connected |
| Invalid bearer authentication | 401 |
| Allowed / rejected CORS origins | Allowed exact HTTPS origin; unapproved origin 403 |
| Private Python service authentication | Missing token 401, matching generated token metrics 200 |
| Node Docker -> Python Docker real analysis | 200 using generated speech, actual axios/form-data transport |
| Existing analysis-response validator | usableAnalysis=true for the real returned response |
| Actual Node upload -> Python invalid-audio response | 400 with the exact short-recording message; correct Node multipart audio field |
| Failed upload persistence | Zero SpeechSession documents in disposable database |
| R2 cleanup-journal initialization | Unique namespace/key index created in disposable MongoDB |
| Missing MONGO_URI | Clear Docker preflight failure, exit 1 |
| Missing JWT_SECRET | Clear Docker preflight failure, exit 1 |
| Missing PYTHON_SERVICE_TOKEN | Clear Docker preflight failure, exit 1 |
| Missing CORS_ORIGINS | Clear Docker preflight failure, exit 1 |
| Missing R2_SECRET_ACCESS_KEY | Clear Docker preflight failure, exit 1 |
| Log secrets | Generated JWT/Python/R2 credential values absent |
| Idle SIGTERM shutdown | PASS, exit 0, 0.38 seconds |
| Disposable test containers/network/anonymous DB volumes | Removed; existing local containers/images preserved |

Health is database-only readiness, not an independent R2/Python probe. MongoDB
compatibility is demonstrated against disposable TLS MongoDB, not live Atlas
roles/network/backup. R2 configuration and provider regressions pass, but no live
R2 requests or full successful Node-to-R2 persistence occurred. The synthetic
endpoint could not be contacted from the internal network. No existing bucket,
recording, resource or normal database was accessed.

The real generated-speech check exercises Node's installed transport and
production analysis validator; it is not a scoring-accuracy benchmark or a
successful full session/R2 lifecycle. The invalid-audio check exercises the real
authenticated Node route and Python error mapping without cloud persistence.

## Resource measurements and initial limits

Final run Docker stats samples: 49.79 MiB immediately after startup, sampled peak
71.32 MiB during private networking/inference/account checks, and 52.88 MiB after
the checks. Most networking samples used 0.17–0.66% CPU (100%=one CPU), with a
20.43% post-start sample, a 19.73% networking sample, and a 5.59% later sample.
An earlier passing networking run sampled up to 79.32 MiB and 65.72% CPU. These
are periodic Docker samples, not guaranteed instantaneous peaks or a sustained
load benchmark. Resource sampling itself launches short-lived Docker exec Node
processes, so measurements include that testing overhead.

**Initial controlled Node limit: 512 MiB RAM and 1 vCPU**, the limits under which
the full smoke checks passed, with one Node replica while rate/admission state
is in memory. This provides measured baseline headroom; it does not prove
capacity for many simultaneous 25 MiB uploads, R2 buffer copies, reference reads,
or long requests. Repeat representative concurrency/max-size tests before
widening access, and monitor memory, scratch capacity, CPU and latency. There is
no global Node transfer-memory/admission bound in the preserved application.

Keep Python separate: **6 GiB minimum RAM, 8 GiB safer RAM, one inference worker**.
No new Python sizing or model/scoring change is inferred from Node measurements.

## Regression and security results

- Complete Windows Node suite: **109 passed, 0 failed**.
- Complete Linux Node suite in the production image: **109 passed, 0 failed**.
- npm audit: **0 vulnerabilities**, exit 0.
- git diff --check: passed; new scripts also passed syntax checks.
- Docker configuration and final-image focused checks: passed.
- No generated production-like secret values appeared in startup/test logs.
- Docker app/configuration code has no hardcoded real credentials, no copied
  local secret file or recording, and no development dependency tree.
- The npm audit does not constitute an OS/base-image vulnerability scan.
- Python's separate unresolved Accelerate advisory retains only its existing
  controlled-thesis accepted-risk disposition; nothing in this task fixes it.

Initial verification issues were corrected in test infrastructure, never by
weakening application tests: the disposable MongoDB 256 MiB scratch allocation
prevented index creation (OutOfDiskSpace); the Windows harness needed explicit
UTF-8 decoding; local-provider Linux regressions needed writable disposable local
scratch. The focused upload check was tightened to use the actual Node audio
field and assert Python's short-recording response. Final checks above passed
after these corrections.

## Remaining deployment blockers

1. Live Atlas connectivity, service roles, egress/network policy, required indexes,
   backup/restore and approved data/cutover plan remain unverified.
2. Live private R2 upload/read/checksum/delete/privacy verification remains pending;
   real credentials/account endpoint were absent from this test environment.
3. Configure actual production secrets, nonempty approved CORS origins, ingress
   trust/client-IP rules and the private Python URL/token on the host.
4. Provision trusted Python models/private image before deployment; weights remain
   absent from Git. Verify cloud private-only access and uphold scoped risk controls.
5. Test cloud cold starts, networking, graceful drain of active analyses, resource
   limits and realistic concurrent large uploads before wider use.

The Node Docker packaging gate can move to **IMPLEMENTED — CLOUD DEPLOYMENT
VERIFICATION PENDING**. No Railway connection, deployment, paid resource,
commit or push was performed. See DOCKER.md for repeatable commands and actual
environment-variable names. Ignored detailed evidence:
`node-docker-verification.local.log`.

## Authorized publication review — 2026-10-14

The follow-up task authorizes a Node-only GitHub commit/push after checks pass;
Python provisioning changes remain uncommitted. The exact reviewed Node set is
the nine Docker/configuration/verification/documentation files listed above.
`.gitattributes` prevents core.autocrlf=true on Windows from converting the Linux
shell entrypoint to CRLF; it changes no application behavior.

Fresh npm audit: zero vulnerabilities. An initial full Node run under concurrent
Python build/test load had 108 passes and one timing-sensitive R2 test failure:
the timeout test received 429 immediately after the disconnected-client test.
The complete unchanged suite passed **109/109** in isolation using
`npm.cmd test -- --test-concurrency=1`. No application code or test assertion was
altered to make this pass. The preceding local Windows/Linux 109/109 and Docker
smoke evidence remains applicable to the unchanged application/image.
A final ordinary `npm.cmd test` run after the Python build/load completed also
passed **109/109**, with default test concurrency. The earlier timing-sensitive
failure is disclosed rather than represented as an initially clean run.

Exact publication SHA and synchronization are recorded in the task's final
report, without editing this document after commit. No deployment or cloud
resource action is authorized by source publication.
