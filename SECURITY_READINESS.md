# Production security verification — 2026-10-09

**A. Executive assessment: BLOCKER remains.** Targeted hardening and local
regressions are complete. Accelerate remains an unresolved production dependency
risk; the previous exception authorizes controlled UAT only. Actual proxy/client
identity, private Python exposure, cloud permissions and client release prerequisites
still need verification. No deployment, commit, push, existing-data modification
or broad dependency upgrade occurred. Existing R2/Atlas/Android/Admin/Python V2
changes were preserved; legacy Python was excluded.

**B–C. Exact dependency findings.** Fresh initial npm audit found one critical
advisory; initial pip-audit found seven advisories in four packages.

| Package | Advisory | Issue | Result |
| --- | --- | --- | --- |
| proxy-addr 2.0.7 | CVE-2026-90711 / GHSA-jqcg-44mw-7w3h | IPv4-mapped IPv6 trust-subnet IP spoofing | Patched to 2.0.8 |
| accelerate 1.14.0 | PYSEC-2026-3804 / CVE-2026-69112 / GHSA-4j2p-28q2-5m79 | Sharded checkpoint traversal/file read/DoS | UNRESOLVED |
| anyio 4.13.0 | PYSEC-2026-4025 / CVE-2026-63374 / GHSA-82r6-8w77-94w6 | IDNA TLS hostname verification | Patched to 4.14.2 |
| anyio 4.13.0 | PYSEC-2026-4024 / CVE-2026-64847 / GHSA-5p39-cfhj-2xmp | Process-worker stderr deadlock | Patched to 4.14.2 |
| fsspec 2026.4.0 | CVE-2026-104851 / GHSA-27vj-qcqg-25rc | ReferenceFileSystem template injection/RCE | Patched to 2026.6.0 |
| urllib3 2.7.0 | PYSEC-2026-4177 / CVE-2026-97689 / GHSA-vxq7-64xx-v4gw | Unbounded streaming chunk-size line | Patched to 2.8.0 |
| urllib3 2.7.0 | PYSEC-2026-4176 / CVE-2026-97688 / GHSA-gh4c-6fx4-qh6g | Deflate streaming infinite loop | Patched to 2.8.0 |
| urllib3 2.7.0 | PYSEC-2026-4175 / CVE-2026-97687 / GHSA-8988-9cw3-xx77 | HTTPS proxy TLS policy confusion | Patched to 2.8.0 |

Sources: [proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h),
[Accelerate](https://github.com/advisories/GHSA-4j2p-28q2-5m79),
[AnyIO TLS](https://github.com/advisories/GHSA-82r6-8w77-94w6),
[AnyIO process workers](https://github.com/advisories/GHSA-5p39-cfhj-2xmp),
[fsspec](https://github.com/advisories/GHSA-27vj-qcqg-25rc),
[urllib3 chunk lines](https://github.com/advisories/GHSA-vxq7-64xx-v4gw),
[urllib3 deflate](https://github.com/advisories/GHSA-gh4c-6fx4-qh6g),
[urllib3 proxy TLS](https://github.com/advisories/GHSA-8988-9cw3-xx77).

Other confirmed findings: raw Node database logs, Python transcript/word logs,
unauthenticated Python analysis, detailed Python health errors/paths, a post-Mongo
startup cleanup gap, production proxy identity uncertainty, Admin browser token
exposure to XSS, and Admin acceptance of private HTTPS API addresses. The concrete
code fixes below address the first six and the Admin URL gap. Cloud/network and
browser-storage findings remain operational/design limitations.

**D–E. Node changes/dependencies.** Express remains 5.2.1. It depends on
proxy-addr through `^2.0.7`, which accepts 2.0.8. A targeted
`npm update proxy-addr --ignore-scripts --no-fund --no-audit` changed only that
installed/lockfile package when compared to the pre-update package inventory.
Both npm/yarn lock entries now resolve 2.0.8. No new dependency or override was
added and no force/broad audit fix was run. Final npm audit reports zero known
vulnerabilities across 216 dependencies. `npm ci --dry-run --ignore-scripts
--no-audit --no-fund` succeeded without replacing node_modules.

**F. Python dependencies.** Only AnyIO, fsspec and urllib3 changed versions.
They passed tests, pip check, model startup and a real inference in an isolated
image derived from the previously verified local image before applying them to
the Windows venv and requirements. Final native pip-audit reports exactly one
advisory in Accelerate; it is not suppressed. Native and isolated-image pip check
passed. Shared requirements now explicitly pin Accelerate 1.14.0 and psutil 7.2.2
at their existing versions so clean Windows and Linux installs cannot silently
select a different PEFT dependency. Linux includes those shared pins; Torch's
existing CPU-index installation remains unchanged.

PEFT 0.19.1 requires/imports Accelerate at runtime; removing it is unsafe.
Transformers 5.10.1 does not list Accelerate as a mandatory distribution dependency,
although some optional loading paths use it. Application code does not call
load_checkpoint_in_model/load_checkpoint_and_dispatch or use device_map dispatch.
It loads existing local unsharded safetensors with local_files_only and offline
container settings. Uploaded audio cannot select a model/checkpoint/index.

**PRODUCTION SECURITY RISK — UNRESOLVED:** Accelerate's advisory lists affected
versions through 1.14.0 and no patched version. PyPI's latest checked release is
1.15.0, but its inspected loader still joins index weight_map values without
confinement. Being outside the advisory's stated range is not verified remediation.
No Accelerate upgrade was attempted. Exploitation requires attacker-controlled
model/checkpoint metadata reaching the affected loader; trusted immutable models,
read-only runtime code/models and private networking reduce exposure but do not
remove the dependency flaw. The UAT exception has not been extended to production.
[Inspected 1.15.0 loader](https://raw.githubusercontent.com/huggingface/accelerate/v1.15.0/src/accelerate/utils/modeling.py).

Requirements are exact version pins, not a hash-locked artifact manifest. The
base Docker tag and apt packages are not digest/version pinned. Those are bounded
reproducibility limitations; no dependency-strategy redesign or OS audit was done.

**G. Python exposure/authentication.** Recommend Option B: private networking
PLUS a shared service token. Option A relies only on trust in every workload on
the private network; the token adds a practical independent check. Clients call
Node; Node calls Python over the host's private network. Do not create a Python
public domain/TCP proxy. Actual Railway service/network configuration is unverified.

Node production requires private `PYTHON_SERVICE_TOKEN` (minimum 32 characters),
Python production requires matching `ISPEAK_SERVICE_TOKEN`. Provision a random,
high-entropy value through the host secret manager; no production value was
generated. Node forwards it as `X-iSpeak-Service-Token` to the configured Python
endpoint and disables redirects. Python compares in constant time before upload
parsing/admission. Analysis and metrics require it; minimal live/ready/health
probes remain available without it. Production API docs are disabled. Development
without a configured token keeps the local workflow. An HTTP internal hop relies
on private-network isolation; any public Python hop must use verified HTTPS.
Rotate both sides together; this is a shared-token mechanism, not replay-proof HMAC.

**H. Speech logging/privacy.** Full transcript and per-word text/timing/confidence
logs were removed from normal analysis logs. Production cannot enable them.
Development details require ISPEAK_DEBUG_SPEECH_LOGS=true and a DEBUG logger.
Detailed exception traces require ISPEAK_DEBUG_ERRORS=true in development only.
Production failure logs contain fixed events and exception classes, not filenames,
speech, paths or traces. Model startup omits private artifact paths in production.
Production health returns availability only, and unavailable analysis masks internal
model reasons. Inference still returns its intended transcript/timestamps to Node
for session storage; scoring/response metrics were not changed.

The real isolated inference logged only `words=18`, returned a valid result for
16.765 seconds of audio and left zero temporary audio copies. Upload files/spools
are normally closed/deleted, including error/cancellation paths. Forced process
kill can still leave temporary files until ephemeral storage is discarded; private
tmpfs/disk limits and restart cleanup remain operational responsibilities.

No audio file candidates were found in the four current Git candidate lists.
Read-only model-directory inspection found 27 files, zero audio assets and zero
sharded-checkpoint index files. Runtime models are trusted tensor/tokenizer
artifacts; weights were not changed. This is not a
training-data/memorization privacy audit. Existing benchmark outputs use controlled
local samples and remain ignored, separate from production operation.

**Privacy review required:** preexisting tracked Python `evaluation_results.json`
contains transcription, word-derived results and path fields. No contents were
printed or changed. Verify provenance/consent before source publication. It is
excluded by the production Docker allowlist, so it is not a runtime image asset.

**I. Mongo logging/security.** All identified raw database error logs in production
handlers, auth middleware, retention and server startup/shutdown now use safeLogger.
It emits fixed operation names, allowlisted error classes and known codes such as
11000; no message, stack, cause, duplicate values, URI or topology is serialized.
Unknown names/codes fall back safely. Controlled error bodies remain generic.
Production Mongo config rejects TLS/certificate-validation bypass options;
standard mongodb URIs require explicit TLS, while SRV retains its TLS default.
MONGO_URI remains a private server environment variable, never a client define.
Actual Atlas least-privilege roles, network access, indexes and backups remain
unverified as documented in ATLAS_READINESS.md.

**J. R2/storage.** Existing StorageError discards raw SDK errors/causes; responses
and fixed cleanup logs contain no SDK headers, signed requests or credentials.
Regression tests inject credential-bearing SDK errors and pass. Cloud object
keys remain internal and authenticated reference streaming remains private.
Neither credentials nor object endpoints were added to clients. Actual live
bucket privacy, credential scope and R2 integration remain NOT VERIFIED; code
tests are not a substitute for checking public access and API-token permissions.

**K. CORS.** Node production requires an exact HTTPS origin list, rejecting
wildcards, paths and credentialed origins; unknown origins receive controlled
403 responses. Origin-less native/server requests still depend on authentication.
Development behavior is preserved. Python production defaults to no browser
origins; both a standalone wildcard and a mixed wildcard list are rejected.
Any explicit production Python origins must be exact HTTPS origins. CORS does
not restrict non-browser attackers and does not replace service authentication.

**L. Proxy/rate limiting.** Express previously used default trust=false, so
forwarded headers could not spoof req.ip, but all users behind a proxy could
share one authentication limit. TRUST_PROXY_CIDRS now accepts explicit IP/CIDR
entries only; empty stays false. Blanket true, numeric hop counts, aliases and
zero-prefix networks are rejected. Do not guess Railway ingress CIDRs or set a
fixed hop count. Patched proxy-addr tests cover the IPv6 trust-subnet advisory.

Tests verify changed spoofed X-Forwarded-For headers cannot evade a limit with
trust disabled, and a configured test proxy chain stops at the nearest untrusted
address rather than accepting the leftmost spoofed entry. Railway documents
X-Real-IP, not a complete Express X-Forwarded-For trust contract. Before deployment,
verify actual peer addresses, header overwrite behavior and direct/private ingress
paths, then approve the corresponding trusted configuration. No arbitrary X-Real-IP
header is trusted by this implementation. Live ingress identity remains a blocker
for claiming correct per-client authentication limiting behind Railway.
[Express proxy trust](https://expressjs.com/en/guide/behind-proxies/),
[Railway headers](https://docs.railway.com/networking/public-networking/specs-and-limits).

Login/signup share a 15-minute process-local IP limiter (default 20). Invalid
configured counts now fall back to 20. Analysis uses authenticated user ID,
default 10 submissions/minute and one active analysis per user. A disconnected
client cannot prematurely release a running inference slot. One Node replica
is the documented initial limit: restarts reset counters; multiple replicas
multiply limits and can admit simultaneous work for the same user. Add shared
coordination before scaling. No Redis redesign was introduced.

**M. JWT/auth.** Existing HS256-only verification, required JWT_SECRET with
32-character minimum, issuer ispeak-api, audience ispeak-clients and default 7d
expiry are preserved. A random secret is still an operational requirement;
length alone does not prove entropy. Every protected request checks current
database account status/role; banned/archived users are rejected. Server role and
ownership checks remain authoritative, and existing auth/RBAC/IDOR tests pass.
No auth semantics, scoring or session completion rules were redesigned.

**N. Admin token storage.** Actual implementation is SharedPreferences, using
browser localStorage for token and user display fields. JavaScript injected into
the origin can steal the bearer token; CSP reduces risk but cannot make storage
HttpOnly. Logout clears local storage and backend /auth/me revalidates accounts.
Android uses FlutterSecureStorage, which protects stored tokens at rest.

An HttpOnly/Secure/SameSite-cookie model would require coordinated backend/client
changes, CSRF protections and origin decisions, so it was not introduced in this
focused audit. For controlled initial use, restrict Admin access/users, retain
server authorization, use CSP/XSS controls and avoid shared devices. Reassess JWT
lifetime and cookie architecture before wider use. No direct HTML/eval rendering
sink was found in the searched Admin lib/web source; this is not proof of no XSS.

**O. Cloudflare Pages web headers.** Recommended baseline `_headers` file in the
final Admin/landing static output (not deployed by this task):

```text
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'
```

Admin currently uploads files rather than recording microphone audio. Revisit
Permissions-Policy if that changes. Add HSTS only after the actual domain and
HTTPS behavior are verified; do not blindly apply includeSubDomains/preload.

For Flutter's full policy, begin with this REPORT-ONLY candidate, replace the
synthetic API host with the approved API, and inspect browser violations on the
actual release artifact before enforcing it:

```text
/*
  Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://www.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://api.example.invalid https://www.gstatic.com https://fonts.googleapis.com https://fonts.gstatic.com; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'
```

This is not a tested enforced Flutter CSP. Self-host renderer/fonts where practical,
then narrow external sources. Do not add script unsafe-inline/unsafe-eval by
default to silence warnings. Landing-page dependencies must be inventoried
separately; no active landing deployment was inspected. Place `_headers` in the
actual published build directory; Cloudflare Pages Functions responses require
headers in function code rather than relying on static-file rules.
[Cloudflare Pages headers](https://developers.cloudflare.com/pages/configuration/headers/).

**P. Secret scan/release configuration.** Current tracked plus nonignored
untracked candidates were enumerated for all four repositories. Pattern scans
covered 49 Node, 61 Python, 246 frontend and 168 Admin files at scan time.
Missing/deleted files and files larger than 3 MB were excluded from text scanning.
Key/audio filename checks also ran.
Credentialed Mongo URIs, private-key blocks, AWS/Google key patterns, JWT literals
and credential assignment patterns produced no unclassified credential findings.
The final current-candidate rescan covered 525 files and likewise found no
unclassified credential/private-key/audio-file candidates.
Known placeholders/test values were classified separately; no value was printed.
This is a bounded heuristic current-candidate scan, not a history/binary/secret
manager audit. `.env`, private signing formats and generated artifacts remain
ignored. No real credentials were written to examples, tracked files or this report.

Android Gradle release guards reject absent/HTTP/credentialed/local/private API
URLs, debug signing and missing private configuration. Native release cleartext
is disabled. No Android files were changed or release built here; team signing
remains deferred and production API unavailable. Admin keeps its local loopback
release-test exception only on a local HTTP page; deployed releases now reject
private/local HTTPS literals, including mapped IPv6 forms, as well as HTTP and
credentialed URLs. Guards do not resolve DNS: real HTTPS/API ownership still
requires deployment verification. No client distributable production artifact
was certified. Public Node/Pages traffic must use HTTPS; internal HTTP is confined
to the approved private Python hop.

**Q. Startup/shutdown.** Node startServer now unwinds timers/listener and
disconnects Mongo on startup failure, including failure after Mongo connects.
It awaits listener binding and handles bind errors. Shutdown disconnects Mongo
in finally even if HTTP close fails. Regression injects StorageCleanup.init
failure after successful mocked connect and verifies disconnect/no listener.
Initial invalid/unavailable database tests still pass. Graceful HTTP close waits
for active requests; the host's termination deadline must accommodate or terminate
long inference requests. Actual host stop/restart behavior was not tested.

Python distinguishes /live from /ready and /health, preserves failure-safe model
startup and bounded inference admission, and uses Uvicorn exec/one-worker startup.
Production rejects missing service auth or unsafe CORS at import. Health probes
do not expose model paths/errors. Private token provisioning is now required
before starting the existing production Docker workflow. The local verification
harness forwards the token without placing its value in command arguments;
its syntax was checked, but expensive benchmark runs were not repeated.

**R. Verification results.**

| Check | Final result |
| --- | --- |
| Complete Node tests | 109 passed; 0 failed/cancelled/skipped/todo |
| npm audit | 0 vulnerabilities |
| npm clean-install dry run | Passed |
| Native Python relevant suite | 33 passed |
| Isolated patched Linux suite | 33 passed |
| Native/image pip check | No broken requirements |
| Native pip-audit | 1 advisory: Accelerate; unresolved, exit 1 |
| Real isolated startup/inference | Ready; tokenless 401; authenticated 200; valid 18-word/16.765-second result; no temp audio |
| Admin full tests | 93 passed |
| Admin final analyzer | No issues |
| Admin focused URL tests after style cleanup | 8 passed |
| Frontend analyzer/tests | Not rerun; frontend source unchanged |
| git diff --check | Passed in all four repositories |

No live Atlas/R2, public proxy, physical Android or deployed Pages verification
was performed. The initial focused Node/Python audit failures and Admin style
findings were corrected before the reported final checks. An isolated Docker
build initially tried to include excluded tests, then mounted tests read-only;
the first inference harness import path was corrected. No application failure
was represented as a successful live check. Audit containers were removed by
--rm; no new audit container remained running.

**S. Exact files changed by this security task.** Preexisting diffs are not
attributed to this task:

- Node: `.env.example`, `ATLAS_READINESS.md`, `SECURITY_READINESS.md`,
  `package-lock.json`, `yarn.lock`, `server.js`, `controllers/authController.js`,
  `controllers/resourceController.js`, `controllers/sessionController.js`,
  `controllers/userController.js`, `middleware/auth.js`, `routes/authRoutes.js`,
  `services/retentionService.js`, `services/safeLogger.js`,
  `services/securityConfiguration.js`, `test/analysisGateway.test.js`,
  `test/securityHardening.test.js`, `test/storageEnvironment.test.js`.
- Python V2: `.env.example`, `DOCKER.md`, `fastapi_backend.py`, `model.py`,
  `whisper_service.py`, `requirements.txt`, `requirements-linux.txt`,
  `testing_script/test_security_hardening.py`, `testing_script/verify_docker_local.py`.
- Admin: `lib/config/api_config.dart`, `test/api_config_test.dart`.
- Frontend/Android: no files changed by this task.

Ignored evidence: Node `security-*.local.log`, Admin security analyzer/test logs,
Python `benchmark-results/security/` plus its initial audit JSON. The only model.py
change is startup output; weights, loading parameters and scoring are unchanged.

**T–U. Remaining risks and security gate.**

Publication review, 2026-10-14: the later Python V2
`ACCELERATE_PRODUCTION_DISPOSITION.md` supersedes the historical Accelerate-only
blocker and UAT-only exception statements below. Accelerate remains unresolved;
its risk is accepted solely for controlled thesis deployment under that document's
controls and review deadline. Ingress, privacy, live storage/database and client
release gates remain open. No deployment approval is implied.

| Gate | Classification | Remaining condition |
| --- | --- | --- |
| A. Secrets | READY for current candidates | Privately provision/rotate real runtime secrets; scan limits above |
| B. Auth/authorization | ACCEPTABLE WITH DOCUMENTED LIMITATION | Shared-token rotation/private exposure and Admin bearer storage |
| C. Dependencies | BLOCKER | Accelerate unresolved; UAT exception does not authorize production |
| D. Service exposure | ACCEPTABLE WITH DOCUMENTED LIMITATION | Verify host private-only Python and HTTPS public ingress |
| E. Logging/privacy | ACCEPTABLE WITH DOCUMENTED LIMITATION | Review tracked evaluation-result provenance before publication |
| F. CORS/proxy/rate limits | BLOCKER for verified cloud ingress | Confirm actual ingress trust/client IP; one replica only |
| G. Storage/database | ACCEPTABLE WITH DOCUMENTED LIMITATION | Live Atlas least privilege/TLS/indexes/backup and private R2 bucket/token checks |
| H. Client release | BLOCKER for production distribution | Android signing deferred; real API/physical UAT and deployed web headers pending |

**Final Security Gate: BLOCKER remains.** The task does not extend the earlier
Accelerate UAT exception or approve an unknown ingress trust configuration.
Security cannot yet be labeled ACCEPTABLE FOR CONTROLLED INITIAL DEPLOYMENT or
READY FOR INITIAL DEPLOYMENT. The concrete fixes above are ready for review;
remaining gates require an established upstream fix or explicit production risk
decision plus deployment-specific verification. No deployment was attempted.
