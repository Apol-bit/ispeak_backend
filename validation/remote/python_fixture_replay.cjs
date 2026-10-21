#!/usr/local/bin/node
'use strict';
// Test-only replay of one hash-bound fixture, never a general Python interpreter.
const fs = require('node:fs');
const crypto = require('node:crypto');
const expectedPath = '/ispeak_python-backendV2/testing_script/test_assessment_details.py';
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
try {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '-B' || args[1] !== expectedPath || args[2] !== '--fixture') {
    process.exit(64);
  }
  const manifest = JSON.parse(fs.readFileSync('/fixture-data/fixture-manifest.json', 'utf8'));
  if (manifest.python_commit !== 'a76c6f47bde88f39570c99fb1de012cfbda9df72') process.exit(65);
  for (const item of manifest.python_sources) {
    if (!['assessment_details.py', 'testing_script/test_assessment_details.py'].includes(item.source)) process.exit(65);
    if (digest(fs.readFileSync('/ispeak_python-backendV2/' + item.source)) !== item.sha256) process.exit(65);
  }
  if (manifest.python_sources.length !== 2) process.exit(65);
  const bytes = fs.readFileSync('/fixture-data/assessment.json');
  if (digest(bytes) !== manifest.fixture_sha256) process.exit(65);
  process.stdout.write(bytes);
} catch {
  process.exit(65); // Fixed code only; no paths, environment or fixture data in errors.
}
