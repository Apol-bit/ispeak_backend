"""Validate the runtime-only security delta before the existing private publisher."""
import hashlib
import json
import re
from pathlib import Path


def validate_security_update(v):
    v.set_stage('node_dependencies')
    installed = v.docker(*v.run_args('node-follow-version-' + v.key, memory='256m'),
        '--entrypoint=node', v.image, '-p', "require('follow-redirects/package.json').version",
        seconds=30).decode().strip()
    if installed != '1.16.1':
        raise RuntimeError('Patched follow-redirects runtime resolution not established')
    v.evidence('follow_redirects_runtime', result='PASS', version=installed)
    # The audit is the sole networked test: registry.npmjs.org, no cloud credentials,
    # no application startup and no database/object-storage mounts.
    status, output = v.docker(*v.run_args('node-audit-' + v.key, memory='512m', network='bridge'),
        '--entrypoint=npm', v.image, 'audit', '--omit=dev', '--json', '--loglevel=error',
        '--registry=https://registry.npmjs.org', seconds=120, check=False)
    try:
        report, _ = json.JSONDecoder().raw_decode(output.decode().lstrip())
        counts = report['metadata']['vulnerabilities']
        if status not in (0, 1) or report.get('error'):
            raise ValueError()
        findings = []
        for name, finding in report.get('vulnerabilities', {}).items():
            if not re.fullmatch(r'[@A-Za-z0-9_./-]{1,120}', name):
                raise ValueError()
            findings.append({'package': name, 'severity': finding['severity'],
                             'direct': bool(finding.get('isDirect')),
                             'fix_available': bool(finding.get('fixAvailable'))})
    except Exception:
        raise RuntimeError('Production dependency audit unavailable or malformed') from None
    v.evidence('node_dependency_audit', result='FINDINGS' if counts.get('total') else 'PASS',
               production_only=True, counts=counts, findings=findings,
               dependency_files_changed=True)
    if status != 0 or counts.get('total') != 0:
        raise RuntimeError('Clean production dependency audit required before publication')
    v.set_stage('node_configuration')
    here = Path(__file__).with_name('gcp_adapter').resolve()
    manifest = json.loads((here / 'manifest.json').read_text())
    if set(manifest) != {'preload.cjs', 'harness.cjs', 'synthetic.env'}:
        raise RuntimeError('Unexpected adapter verification assets')
    for filename, expected in manifest.items():
        path = here / filename
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Adapter test asset hash mismatch')
        path.chmod(0o444)
    result = v.docker(*v.run_args('node-gcp-adapter-' + v.key, memory='512m'),
        '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,mode=1777',
        '--mount', f'type=bind,src={here / "preload.cjs"},dst=/etc/ispeak-runtime/preload.cjs,readonly',
        '--mount', f'type=bind,src={here},dst=/verification,readonly',
        '--env-file', str(here / 'synthetic.env'), '--entrypoint=/bin/sh', v.image,
        '/app/docker/entrypoint.sh', 'node', '--require=/etc/ispeak-runtime/preload.cjs',
        '/app/server.js', seconds=45)
    if b'OVERALL PASS:' not in result or b'FAIL:' in result:
        raise RuntimeError('Exact candidate adapter verification failed')
    v.evidence('gcp_runtime_adapter', result='PASS', candidate=v.image,
        adapter_sha256=manifest['preload.cjs'], eight_application_hashes='PASS',
        node_version='v24.22.1', original_entrypoint=True, nonroot_readonly_mount=True,
        headers_preserved=True, token_cache_mocked=True, both_cleanup_jobs_suppressed=True,
        external_network=False, real_iam_tested=False, atlas_r2_tested=False)
