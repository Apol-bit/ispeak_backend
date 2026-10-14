# Node production container

The Docker path preserves the existing `node server.js` / `npm start` Windows
development flow. No local `.env` change or switch to R2 is required for local
development. See `DOCKER_LOCAL_VERIFICATION.md` for measured local evidence and
the remaining cloud gates.
The Docker shell entrypoint has a narrow `.gitattributes` LF rule so Windows
checkouts do not introduce CRLF startup failures.

## Build and runtime

```powershell
docker build --check .
docker build -t ispeak-node:local .
```

The base is `node:24.21.0-bookworm-slim` (Node 24 LTS), Linux/amd64 in the verified
build. The build uses the existing package-lock with `npm ci --omit=dev`, cleans
the npm cache, copies only runtime source, and runs as UID 1000 (`node`). No
dependency versions, application handlers, database schemas, or storage behavior
were changed. Base release policy: https://github.com/nodejs/Release.

The Docker-only entrypoint validates the existing production configuration and
prints variable names, never configured values or raw exceptions. It then uses
`exec node server.js`, so SIGTERM reaches the application's existing shutdown
handler. `PORT` defaults to 5000; the existing server listens on `0.0.0.0`.
`EXPOSE 5000` is metadata and does not override a host-assigned PORT.

Supply production values through the host secret environment, not Docker build
arguments or source. Keep the root filesystem read-only where supported and
provide writable `/tmp` for private R2 processing scratch. The verified smoke
test used a 128 MiB tmpfs, not a demonstrated capacity limit for concurrent
25 MiB recordings; tmpfs allocations count toward container RAM. Plan scratch
quota/monitoring and concurrency before a wider launch.

The default-deny `.dockerignore` includes only Dockerfile, package manifests,
server.js, controllers, middleware, models, routes, services, and the Docker
entrypoint/preflight. It excludes local env/secrets, Git, host node_modules,
recordings, model weights, scripts/tests/docs, caches, build output and logs.
Additional nested exclusions protect against accidentally misplaced artifacts.

## Actual application configuration

| Variable | Production purpose |
| --- | --- |
| `NODE_ENV` | Set to `production` by the image |
| `PORT` | Hosting HTTP port; defaults to 5000 |
| `MONGO_URI` | Required; production validates TLS and certificate verification |
| `JWT_SECRET` | Required, at least 32 characters |
| `JWT_EXPIRES_IN`, `JWT_ISSUER`, `JWT_AUDIENCE` | Existing defaults: 7d, ispeak-api, ispeak-clients |
| `CORS_ORIGINS` | Required nonempty comma-separated exact HTTPS origins |
| `TRUST_PROXY_CIDRS` | Optional explicit trusted ingress IPs/nonzero CIDRs; empty ignores forwarded headers |
| `PYTHON_BACKEND_URL` | Required actual private Python service URL |
| `PYTHON_SERVICE_TOKEN` | Required, at least 32 characters; matches Python `ISPEAK_SERVICE_TOKEN` |
| `PYTHON_TIMEOUT_MS` | Defaults to 300000 |
| `STORAGE_DRIVER` | Use r2 for ephemeral production hosting |
| `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Required R2 configuration, host secrets only |
| `R2_ACCOUNT_ID` or `R2_ENDPOINT` | Required account/validated HTTPS Cloudflare S3 endpoint |
| `R2_REGION` | Defaults to auto |
| `ALLOW_LOCAL_STORAGE_IN_PRODUCTION` | Leave false; local bypass is not normal cloud configuration |
| `LOCAL_STORAGE_ROOT` | Local development storage only; defaults to uploads |
| `AUTH_RATE_LIMIT_MAX` | Defaults to 20 attempts per 15 minutes per limiter key |
| `ANALYSIS_RATE_LIMIT_MAX` | Defaults to 10 submissions per minute per authenticated user |
| `RECORDING_RETENTION_DAYS` | Defaults to 30; nonpositive disables retention |
| `TERMS_VERSION` | Existing default 1.0 |

Upload size is an existing code limit of 25 MiB, not a new configurable variable.
Node admits one analysis at a time per user; there is no aggregate user/transfer
memory limit. Cleanup retries run every minute with batches of at most 100;
uncertain intents have the existing 24-hour recovery delay. Retention runs on
startup and daily. These timings are existing code constants, not invented env
settings. Startup and cleanup can create indexes/read/delete referenced data:
never smoke-test against the normal user database or live bucket without a
separate reviewed disposable-data plan.

Production safe logging omits SDK errors, secret-bearing exception payloads and
request URLs. `/health` returns 200 only while Mongoose is connected, otherwise
503. HTTP starts after Mongo connection and R2 cleanup-model index initialization.
The Docker healthcheck probes `/health` on the actual PORT every 15 seconds with
a 60-second initial grace period. It does not independently probe R2, Python,
Atlas roles/backups, or every model index. Startup without Mongo never opens HTTP.

The existing shutdown closes HTTP and disconnects Mongo. The idle SIGTERM path
was verified; an active analysis can take up to the existing Python timeout.
Configure host drain/grace time appropriately before testing cancellation of
long requests. No new forced-shutdown behavior was introduced.

## Repeat local verification

Requires Python 3 for the stdlib-only host harness, Docker, `mongo:8.0`, the built
Node image, and existing `ispeak-python-v2:security-verification`. Generate a
harmless synthetic spoken WAV with an approved local synthesizer; never use user
audio. Then run:

```powershell
python scripts/verifyNodeDocker.py --speech-file <generated-speech.wav>
```

The harness generates ephemeral credentials and a self-signed disposable CA,
uses an internal Docker network with no host ports, starts a fresh TLS MongoDB
and private Python, and starts Node in production R2 mode with synthetic keys.
No real R2 endpoint is contacted. It verifies private Python authentication,
real generated-speech inference through Node's actual axios/form-data transport
and existing analysis validator, actual Node invalid-audio handling, disposable
account CRUD, cleanup index initialization, database outage/recovery health,
configuration rejection, log redaction, resource samples and idle shutdown.
It removes only its UUID-named containers, anonymous database volumes and network.
Its JSON results are written to ignored `node-docker-verification.local.log`.

Full valid-audio Node-to-R2 persistence is not covered by this test. Real Atlas
and R2 verification, ingress/CORS/secret setup, resource/load testing and private
Python/model provisioning remain cloud deployment gates. Keep Python's separate
established sizing: 6 GiB minimum, 8 GiB safer, one inference worker. No image
publication or cloud deployment is performed by these commands.
