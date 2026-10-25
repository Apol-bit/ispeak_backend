"""Regression checks for the exact frozen secure recipe and dependency lock."""
import hashlib
import json
import re
import unittest
import tempfile
import shutil
from unittest.mock import Mock, patch
from pathlib import Path
from materialize import security_recipe_delta, dependency_lock_delta
import validate_security_update as runtime


class SecurityDelta(unittest.TestCase):
    def secure_lock(self):
        root = Path(__file__).resolve().parents[2]
        data = json.loads(root.joinpath('package-lock.json').read_bytes())
        manifest = json.loads(Path(__file__).with_name('dependency-security-patch.json').read_text())
        data['packages'][manifest['path']].update(manifest['after'])
        content = (json.dumps(data, indent=2) + '\n').encode()
        manifest['source_sha256'] = hashlib.sha256(content).hexdigest()
        return content, manifest

    def test_secure_lockfile_is_verified_without_mutation(self):
        original, manifest = self.secure_lock()
        updated = dependency_lock_delta(original, manifest)
        data = json.loads(updated)
        self.assertEqual(updated, original)
        self.assertEqual(data['packages']['node_modules/follow-redirects']['version'], '1.16.1')
        self.assertEqual(data['packages']['node_modules/axios']['dependencies']['follow-redirects'], '^1.16.0')

    def test_lockfile_rejects_unrelated_content_change(self):
        original, manifest = self.secure_lock()
        with self.assertRaises(RuntimeError):
            dependency_lock_delta(original + b' ', manifest)

    def test_secure_base_line_is_verified_without_mutation(self):
        original = b'FROM node:24.22.1-bookworm-slim\n\nRUN unchanged\n'
        updated = security_recipe_delta(original)
        self.assertEqual(updated, original)

    def test_rejects_unexpected_recipe(self):
        for original in (b'FROM node:latest\n', b'FROM node:24.22.1-bookworm-slim\r\n',
                         b'FROM node:24.22.1-bookworm-slim\nFROM node:24.22.1-bookworm-slim\n'):
            with self.assertRaises(RuntimeError):
                security_recipe_delta(original)

    def test_adapter_assets_are_bound(self):
        root = Path(__file__).with_name('gcp_adapter')
        manifest = json.loads((root / 'manifest.json').read_text())
        for name, digest in manifest.items():
            self.assertEqual(hashlib.sha256((root / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(manifest['preload.cjs'],
                         '186dd06c8a3d90849ea57d8cac7f7f1b11ed5237b29abb2a9339161f24fe4fb6')

    def test_adapter_file_guards_match_frozen_node_context(self):
        here = Path(__file__).resolve().parent
        preload = here.joinpath('gcp_adapter/preload.cjs').read_text()
        match = re.search(r'^const EXPECTED = (\{.*\}); //', preload, re.MULTILINE)
        self.assertIsNotNone(match)
        guarded = json.loads(match.group(1))
        context = json.loads(here.joinpath('context-manifest.json').read_text())['contexts']['node']
        approved = {entry['path']: entry['sha256'] for entry in context['files']}
        self.assertEqual(len(guarded), 8)
        self.assertEqual(guarded, {path: approved[path] for path in guarded})


class AuditGate(unittest.TestCase):
    def validator(self, version='1.16.1', total=0):
        v = Mock()
        v.key = '123-1'
        v.image = 'tested-candidate'
        v.run_args.side_effect = lambda name, **kwargs: ['run', '--network', kwargs.get('network', 'none')]
        report = {'metadata': {'vulnerabilities': {'info': 0, 'low': 0, 'moderate': 0,
            'high': total, 'critical': 0, 'total': total}}, 'vulnerabilities': {}}
        v.docker.side_effect = [version.encode(), (1 if total else 0, json.dumps(report).encode()), b'OVERALL PASS: synthetic']
        return v

    def test_wrong_runtime_version_stops_before_audit(self):
        v = self.validator(version='1.16.0')
        with self.assertRaises(RuntimeError):
            runtime.validate_security_update(v)
        self.assertEqual(v.docker.call_count, 1)

    def test_high_audit_finding_blocks_before_adapter_and_publication(self):
        v = self.validator(total=1)
        with self.assertRaises(RuntimeError):
            runtime.validate_security_update(v)
        self.assertEqual(v.docker.call_count, 2)

    def test_clean_audit_runs_isolated_hash_bound_adapter(self):
        v = self.validator()
        with tempfile.TemporaryDirectory() as temp:
            location = Path(temp)
            shutil.copytree(Path(__file__).with_name('gcp_adapter'), location / 'gcp_adapter')
            with patch.object(runtime, '__file__', str(location / 'validate_security_update.py')):
                runtime.validate_security_update(v)
        self.assertEqual(v.docker.call_count, 3)
        audit_args = v.docker.call_args_list[1].args
        adapter_args = v.docker.call_args_list[2].args
        self.assertIn('bridge', audit_args)
        self.assertIn('none', adapter_args)
        self.assertIn('--read-only', adapter_args)
        self.assertEqual(v.evidence.call_args.args[0], 'gcp_runtime_adapter')


if __name__ == '__main__':
    unittest.main()
