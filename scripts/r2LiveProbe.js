// Isolated probe: no dotenv loading, server startup, Mongo access, or application keys.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

async function main() {
  const envPath = path.resolve(__dirname, '../.env');
  const original = fs.readFileSync(envPath);
  const local = require('dotenv').parse(original);
  const report = { connectivity: 'FAIL (not tested)', upload: 'FAIL (not tested)', read: 'FAIL (not tested)', contentVerification: 'FAIL (not tested)', delete: 'FAIL (not tested)', absence: 'NOT VERIFIED', privacyConfiguration: 'NOT VERIFIED', existingRecordingsModified: 'NO', localDevelopmentConfigurationChanged: 'NO', localDriver: local.STORAGE_DRIVER || 'local (default)', blockers: [] };
  const missing = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter(k => !process.env[k]);
  if (!process.env.R2_ENDPOINT && !process.env.R2_ACCOUNT_ID) missing.push('R2_ACCOUNT_ID or R2_ENDPOINT');
  if (missing.length) {
    report.blockers.push(`Missing process environment: ${missing.join(', ')}`);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  // Prevent the module's singleton from initializing cloud or application upload directories.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-r2-probe-'));
  let client;
  let attempted = false;
  const key = `deployment-tests/${randomUUID()}.txt`;
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(30000) });
  try {
    const savedDriver = process.env.STORAGE_DRIVER;
    const savedRoot = process.env.LOCAL_STORAGE_ROOT;
    let r2Configuration;
    try {
      process.env.STORAGE_DRIVER = 'local';
      process.env.LOCAL_STORAGE_ROOT = scratch;
      ({ r2Configuration } = require('../services/storageService'));
    } finally {
      for (const [name, value] of [['STORAGE_DRIVER', savedDriver], ['LOCAL_STORAGE_ROOT', savedRoot]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    const config = r2Configuration({ ...process.env, R2_BUCKET: 'ispeak-prod-audio' });
    client = new S3Client({ ...config, maxAttempts: 2, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
    const input = { Bucket: config.bucket, Key: key };
    const bytes = Buffer.from(`iSpeak disposable connectivity probe\n${randomUUID()}\n`);
    const digest = b => createHash('sha256').update(b).digest('hex');
    report.testObjectKey = key;
    attempted = true;
    await send(new PutObjectCommand({ ...input, Body: bytes, ContentLength: bytes.length, ContentType: 'text/plain', IfNoneMatch: '*' }));
    report.connectivity = report.upload = 'PASS';
    const object = await send(new GetObjectCommand(input));
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of object.Body) {
        size += chunk.length;
        if (size > 4096) throw new Error('Unexpected size');
        chunks.push(Buffer.from(chunk));
      }
    } finally { object.Body?.destroy(); }
    report.read = 'PASS';
    report.contentVerification = digest(Buffer.concat(chunks)) === digest(bytes) ? 'PASS' : 'FAIL';
    if (report.contentVerification !== 'PASS') report.blockers.push('Content mismatch');
  } catch {
    report.blockers.push('Live operation failed; raw SDK error suppressed to protect credentials.');
  } finally {
    if (attempted && client) {
      try {
        await send(new DeleteObjectCommand({ Bucket: 'ispeak-prod-audio', Key: key }));
        report.delete = 'PASS';
        try {
          await send(new HeadObjectCommand({ Bucket: 'ispeak-prod-audio', Key: key }));
          report.blockers.push('Test object still exists');
        } catch (error) {
          if (error?.$metadata?.httpStatusCode === 404) report.absence = 'VERIFIED';
          else report.blockers.push('Object absence could not be verified');
        }
      } catch { report.blockers.push(`Cleanup failed: remove ONLY ${key}`); }
    }
    client?.destroy();
    fs.rmSync(scratch, { recursive: true, force: true });
    if (!fs.readFileSync(envPath).equals(original)) report.localDevelopmentConfigurationChanged = 'YES';
  }
  report.blockers.push('Bucket privacy requires read-only Cloudflare verification of disabled public development URL and public custom domains.');
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length) process.exitCode = 1;
}
main().catch(() => { console.error('Probe failed; details suppressed.'); process.exitCode = 1; });
