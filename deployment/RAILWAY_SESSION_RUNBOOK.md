# Scheduled Railway testing operating plan — 2026-10-15

Planning only. No instructions here have been executed against Railway, GHCR,
Atlas or R2. Existing local demonstration settings remain untouched. Release gates:
[RAILWAY_RELEASE_CHECKLIST.md](RAILWAY_RELEASE_CHECKLIST.md).

## Team and cost ownership

The four PHP 500 contributions fund ONE PHP 2,000 team budget, not four separate
Pro subscriptions. Assign a release/session operator, model/security reviewer,
data/backup owner and budget/test coordinator. Keep a shared nonsecret session log
with release digests, checkpoint IDs, scheduled end, actual usage and stop sign-off.
Use individual accounts/access controls; do not share registry or service secrets in chat.

Pro has a $20 monthly minimum with $20 included usage. At an illustrative PHP 60/USD,
that is PHP 1,200 before tax/card/FX charges. This is a planning conversion, not a
current exchange-rate quote. Subscription minimums persist even when apps are offline.

Proposed controls, to be approved and verified in the actual dashboard:

- Compute alert at $15 measured usage and hard limit at $25; confirm how credits,
  subscription, existing workspace usage and separately metered features appear.
- $25 is PHP 1,500 at the planning rate. A 15% fee buffer makes PHP 1,725, leaving
  PHP 275 only if Atlas/R2/other charges remain within that balance. Do not interpret
  a compute cap as a cap on taxes, registry, other providers or Agent charges.
- Use no paid Railway Agent features. Do not enable preview environments, replicas,
  auto-deploys, image auto-updates or forgotten extra services. Verify no other
  workloads consume this workspace's budget. Confirm actual payment/card rate and
  existing Atlas/R2 costs before approving activation.
- Hard-limit shutdown can interrupt requests. Finish sessions well below it and
  never raise the limit automatically. Stop when the remaining forecast plus fees
  cannot fit PHP 2,000. Log extensions beyond the scheduled end with owner approval.

Sources: [pricing](https://railway.com/pricing),
[cost controls](https://docs.railway.com/pricing/cost-control).

## Monthly schedule examples

Assume a 30-day month, BOTH services stopped outside sessions, average combined
memory 4–5.5 GB and average combined CPU 0.1–0.5 vCPU during uptime. Node's roughly
0.1–0.2 GB is included. The four-vCPU cap is not four continuously billed CPUs.
Cold-start time and inference bursts contribute to usage; these estimates are not
ceilings or proven Railway measurements.

| Schedule | Online hours | Estimated compute | Pro total before extras | PHP at 60/USD |
| --- | ---: | ---: | ---: | ---: |
| 10 x 2-hour sessions | 20 | $1.17–$1.81 | $20 | 1,200 |
| 10 x 4-hour sessions | 40 | $2.33–$3.61 | $20 | 1,200 |
| 20 x 4-hour sessions | 80 | $4.67–$7.23 | $20 | 1,200 |
| 8 hours/day | 240 | $14.01–$21.68 | $20–$21.68 | 1,200–1,301 |
| 24/7, comparison only | 720 | $42.02–$65.03 | $42.02–$65.03 | 2,521–3,902 |

Rates used: RAM about $10/GB-month, CPU $20/vCPU-month; Pro total is the greater
of $20 and metered usage. Railway currently charges no service-build/image-storage
fee; service egress adds $0.05/GB. No Railway volume is proposed; if added later,
volume storage is $0.15/GB-month and can persist as a charge after compute stops.
Registry/CI, Atlas, R2, tax and card charges remain separate. Confirm current GHCR
storage policy and existing free allowances instead of assuming a zero total bill.

Sources: [resource pricing](https://docs.railway.com/pricing/plans),
[GHCR billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages).

Scheduled 2–4-hour operation is the recommended budget model. 24/7 is outside this
budget under these assumptions. Recalculate from the first measured session and
include any longer sessions; automatic sleep is not the stop/billing control.

## Proposed Railway services — not active configuration

Create a new isolated project environment after approval. Map Compose into separate
services; Railway does not inherit Compose health, limits or hardening automatically.
Use Railway's HTTPS edge for Node; do not add a Caddy service or deploy the local
test CA. Static admin assets remain on Cloudflare Pages and call Node's HTTPS API.

| Setting | python | node |
| --- | --- | --- |
| Source | approved private v6 image digest | approved writable Node image digest |
| Replicas | 1 | 1 |
| Memory limit | at least 8 GiB equivalent; confirm dashboard units | 512 MiB equivalent |
| CPU cap | 4 vCPU | 1 vCPU initially |
| Worker/concurrency | one Uvicorn worker; ISPEAK_MAX_CONCURRENT_INFERENCES=1 | one Express process |
| Listening | 0.0.0.0; explicitly set PORT=8000 | platform PORT; binds 0.0.0.0 |
| Public domain | NONE; no public TCP proxy | Railway HTTPS domain |
| Health path | /ready | /health |
| Startup health timeout | 300 seconds initially | 300 seconds initially |
| Draining proposal | 45 seconds, verify platform behavior | 45 seconds, verify platform behavior |
| Persistent storage | model in immutable image; writable ephemeral /tmp/ispeak | ephemeral scratch only; recordings in R2 |

Set OMP_NUM_THREADS=4 and MKL_NUM_THREADS=4 for Python. Retain its image integrity
entrypoint, offline model settings and ISPEAK_ENV=production. Keep speech/error debug
flags false, browser Python CORS origins empty, and the strong private service token.
Never override just one model path; model and manifest selection must stay paired.

Node requires NODE_ENV=production, JWT_SECRET of at least 32 characters, explicit
verified-TLS MONGO_URI, R2 credentials scoped to the approved bucket, STORAGE_DRIVER=r2,
exact HTTPS CORS_ORIGINS, and matching PYTHON_SERVICE_TOKEN. Python needs neither
Mongo nor R2 credentials. Do not reuse Windows demo secrets. Review JWT expiry and
proxy trust/rate limiting; do not set blanket forwarded-header trust.

For a service named python, set its explicit PORT=8000 and propose this Node value:

```text
PYTHON_BACKEND_URL=http://${{python.RAILWAY_PRIVATE_DOMAIN}}:8000
```

Both services must share the same project/environment. New Railway environments
support private IPv4/IPv6; current listeners support IPv4. Verify DNS and token-auth
traffic after deployment. No public Python domain is needed. Private HTTP uses
Railway's encrypted network; public requests and Atlas/R2 keep verified TLS.

Enable Node static outbound IPs after approval, record ALL assigned IPv4 addresses
(currently normally three) and allowlist each exact /32 in Atlas. Do not use
0.0.0.0/0, a laptop IP, or the Node public domain as the cloud outbound allowlist.
Addresses may be shared; keep database-scoped credentials. Reverify after region
changes. Keep the region stable and near Atlas/testers; no region change is automatic.

For the first acceptance pilot, use the authorized disposable DB and exact approved
test prefix. For persistent UAT, obtain a distinct approved environment/data policy
and keep its prefix stable between sessions. Proposed RECORDING_RETENTION_DAYS=0
preserves old UAT recordings from automatic expiry; it needs approval before setting.
Normal journal recovery still runs. API user deletion remains destructive by design.
Read-only startup flags and overlay must be absent for writable workflow sessions.

Do not assume Compose cap_drop, read_only, tmpfs, stop_grace_period or healthchecks
are Railway controls. Verify equivalent supported settings and scratch permissions.
Proposed Railway draining variable is RAILWAY_DEPLOYMENT_DRAINING_SECONDS=45;
default platform draining is zero. Keep automatic updates off and drain/remove an
old Node deployment before manual replacement to avoid overlapping cleanup workers.

Sources: [private networking](https://docs.railway.com/networking/private-networking/how-it-works),
[static egress](https://docs.railway.com/networking/static-outbound-ips),
[healthchecks](https://docs.railway.com/deployments/healthchecks),
[teardown](https://docs.railway.com/deployments/deployment-teardown).

## First deployment approval boundary

Complete source review and private-artifact provenance first. Obtain separate
approval for GHCR upload, Pro activation/spend cap, Railway service creation,
secret entry and Atlas allowlisting. Before testers begin, complete the missing
Phase 2B acceptance on disposable identities, run a paired data restore drill, and
prove safe stop/resume. Only an explicitly approved pilot may carry these open tests;
real beta/UAT is not yet signed off. Never use real production data to debug setup.

## Manual start for each session

1. Operator records start/end times, immutable release digests, environment, database,
   stable prefix, backup checkpoint, current invoice and remaining budget. Announce
   the planned 2–4-hour window and an operator-owned end reminder. No silent extension.
2. Check current provider status, account limits, registry access, Atlas /32 addresses,
   retention policy and pending journals. Stop on unknown scope or suspicious pending
   deletion jobs. Checkpoints and release/rollback artifacts must be recoverable.
3. From the configured PRIVATE IMAGE source, manually redeploy Python's pinned
   release. Do not use a source-upload/build command or mutable latest tag. A stopped
   deployment's old image may age out of Railway retention; repull the registry-pinned
   release rather than rebuilding or rolling forward to an unreviewed source.
4. Wait for /ready=200; verify model integrity and v6 startup evidence. Measure RAM,
   CPU, startup time, restart count and OOM state. Node must still be offline.
5. Manually redeploy Node's pinned release. Confirm /health=200, exact database,
   approved indexing effects, stable prefix and private Python connection. Review
   startup logs privately for secrets and unexpected mutation/error events.
6. Through HTTPS, verify valid certificate, public health, rejected unauthenticated
   API requests, ownership controls with designated test accounts, exact CORS, and
   private Python token enforcement (401 missing token, 200 authenticated metrics).
   Never expose service tokens to browsers or print them in diagnostic commands.
7. As a separate authorized workflow check, run one synthetic smoke analysis; verify
   timestamps/scores, Atlas persistence, exact-prefix R2 storage and expected cleanup.
   Keep one inference at a time. Do not delete persistent UAT data as test cleanup.
8. Open testing only after the operator records PASS. Announce that cold starts may
   take minutes, first-use inference can be slower, and the API is offline outside
   the window. Keep a planned rollback/shutdown operator available throughout.

Health alone is insufficient: Node health proves Mongo connectivity, not inference
or R2 access. Python readiness checks both speech and filler models, not accuracy.
Railway deployment healthchecks are not continuous runtime monitoring.

## Monitoring while testers are active

Record service memory/current peaks, CPU, request latency/5xx/timeouts, private
Python metrics and workspace cost every 15 minutes; use dashboard alerts/metrics
continuously. Record actual sampling resolution and distinguish sampled from kernel
or provider-reported peaks. Check budget at start, hourly, before extensions and end.

Proposed operational stop rules: any OOM/unexpected restart, isolation or secret
disclosure, sustained Python memory above 85% of cap, repeated inference failures,
or remaining budget unable to cover the window. Stop intake and investigate; never
raise limits or rotate dataset scope automatically. A brief high CPU reading alone
is expected during inference and is not a four-vCPU monthly-average assumption.

The edge closes idle HTTP requests after five minutes; current Node waits up to
300 seconds for Python. Validate end-to-end deadlines with approved short samples
before admitting longer audio. No timeout increase or new queue is authorized here.

## Safe session shutdown and data preservation

1. Announce the end, stop new submissions, and wait for every client response.
   Through an authorized private operator path, require Python /metrics active=0,
   waiting=0 and admitted=0. Check no Node request/upload remains in progress.
2. Record completed-test IDs and any pending journal intents; do not delete the
   prefix, user collection or database. Investigate ambiguous uploads before cleanup.
3. Remove the active NODE deployment first, then Python, using Railway's deployment
   actions. Verify draining/SIGTERM behavior and no remaining running replicas.
   If in-flight work cannot drain safely, abort shutdown and keep an operator until
   it completes; do not intentionally force-kill a recording save to meet a schedule.
4. Verify the intended services are offline and no preview/old/replica deployment
   remains billable. Disable no account settings without authorization. Do not remove
   Atlas databases, R2 objects, secrets, static domains or release packages to stop compute.
5. With the application quiesced, the backup owner takes the approved paired
   Atlas/R2 checkpoint and verifies it. Preserve app IDs, prefixes, JWT secret,
   service tokens and DB credentials across sessions unless a rotation is planned.
6. Record duration, bill forecast, artifacts/checkpoint status and stop sign-off.
   Verify the next session resumes prior users/sessions/recordings. Pro subscription
   charges continue while compute is stopped; volumes/other providers may still bill.

REGISTRATION_MODE=closed stops new registrations only; it does not stop existing
testers from logging in or submitting audio. The API has no general maintenance or
intake-stop switch. Drain existing work before shutdown; announcement alone is
insufficient for an unattended public beta.

Source: [deployment actions](https://docs.railway.com/deployments/deployment-actions).

## Rollback and defense rehearsal

Stop intake and drain first. Preserve a checkpoint and release-variable record.
Keep Node offline while replacing Python with the privately published HARDENED v5
digest. Do not use ispeak-python-v2:local. Let the image select its own v5 model and
manifest; do not retain v6 model-path overrides. Verify readiness, private service
auth, resource usage and a designated synthetic smoke workflow before resuming Node
and reopening testing. Restore v6 by the same procedure with its pinned digest.

An application rollback is not a database/object rollback. Existing data should
remain intact; schema/object changes need a separately approved recovery plan.
Never replay old cleanup journals against live prefixes as a rollback shortcut.
Keep at least the approved v6 and hardened v5 images in GHCR and locally, independent
of Railway history expiration. Rehearse restore and stop/resume before beta/UAT and
again before defense. Freeze the release before final defense; retain the untouched
local demonstration setup as fallback. Shutdown/cancel billing decisions after the
last scheduled event require the owner; removing compute does not cancel Pro.

## Invitation-only registration in Railway Testing

Apply these settings only to the separate Railway **Testing** environment. Do not
copy Windows demo secrets or edit local .env files. Use a dedicated testing database
with only reviewed accounts and separate JWT credentials. Preserve existing Atlas
TLS, R2 storage, proxy trust and rate-limit configuration described above.

Node variables:

- NODE_ENV=production
- REGISTRATION_MODE=invite (open, invite and closed are the only valid values)
- REGISTRATION_INVITES_JSON: JSON object mapping each approved email to its code's
  64-character SHA-256 hex hash; at least one entry is required in invite mode.
- MONGO_URI: dedicated Testing database URI, supplied privately.
- JWT_SECRET: separate Testing secret, at least 32 characters.
- CORS_ORIGINS: exact HTTPS origin of the Testing Flutter Web admin panel.
- PYTHON_BACKEND_URL=http://${{python.RAILWAY_PRIVATE_DOMAIN}}:8000
- PYTHON_SERVICE_TOKEN: private token matching Python ISPEAK_SERVICE_TOKEN.

Production startup rejects missing/invalid modes, malformed invitation JSON,
invalid hashes, duplicate normalized emails and empty invite configuration before
connecting to MongoDB or listening. An unset mode retains open local development
signup outside production. Set closed and remove REGISTRATION_INVITES_JSON when no
further invitations are needed. A malformed supplied JSON value fails validation
even in open or closed mode. Configuration changes require a new process/restart.

Generate each invitation on a trusted operator machine with the following command.
It prints the plaintext code ONCE for private delivery and the JSON hash entry for
Railway. Do not run it in CI, captured terminals, shared sessions or deployment logs.
The email is a placeholder; replace it with the approved tester email. No secrets
are passed on the command line or written to a file.

Use this stdin form in Windows PowerShell 5.1 or PowerShell 7:

```powershell
@'
const c = require('node:crypto');
const email = 'tester@example.invalid'; // Replace with the approved email.
const code = c.randomBytes(32).toString('base64url');
console.log('Deliver privately: ' + code);
console.log('Railway hash entry: ' + JSON.stringify({
  [email.trim().toLowerCase()]: c.createHash('sha256').update(code).digest('hex')
}));
'@ | node
```

Merge hash entries into one JSON object in REGISTRATION_INVITES_JSON. Store only
hashes there, never plaintext codes or tester passwords. Deliver the code directly
to its approved email over a trusted private channel, along with the Testing app
and instructions to register using that email and choose their own password.
Treat codes as bearer secrets: possessing the code and knowing its email permits
registration; this is not an independent email-verification service.

Build the Flutter Android testing client with:

```powershell
flutter build apk --dart-define=API_BASE_URL=https://<testing-node-host>/api --dart-define=REGISTRATION_INVITE_REQUIRED=true
```

The flag enables the signup field only, not backend enforcement. No invitation
codes or server tokens belong in dart-defines. Local flutter run remains unchanged.
The Web admin panel uses its existing HTTPS API_BASE_URL, login and role checks;
it has no signup flow. Provision/review admin and validator accounts separately;
signup always retains the default user role.

Python v6 stays private in the same Testing environment: no public domain or TCP
proxy, ISPEAK_ENV=production, empty browser CORS origins, and a strong matching
ISPEAK_SERVICE_TOKEN. Flutter calls only Node, never Python.

Before opening testing, review all existing accounts. Ban/archive unapproved ones:
the signup gate alone does not revoke existing JWTs or restrict existing accounts.
The existing middleware rechecks account status per request, including uploads.
Remove an invitation after onboarding; deleting an account while its invitation
remains configured permits registration again. This minimal configuration-backed
design has no durable consumption tracking, expiry or email delivery automation.
Existing unique email/username indexes prevent concurrent duplicate accounts.
Rotating/removing codes does not revoke registered accounts; use ban/archive.

Local verification (no cloud services required):

```powershell
# In ispeak_backend
npm.cmd test
# In ispeak_frontend
flutter test
```
