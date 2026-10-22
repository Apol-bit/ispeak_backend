"""Regression checks for the exact, one-line frozen-recipe security delta."""
import hashlib
import json
import unittest
import copy
import tempfile
import shutil
from unittest.mock import Mock, patch
from pathlib import Path
from materialize import security_recipe_delta, dependency_lock_delta
import validate_security_update as runtime


class SecurityDelta(unittest.TestCase):
    def original_lock(self):
        return Path(__file__).resolve().parents[2].joinpath('package-lock.json').read_bytes()

    def test_lockfile_delta_changes_only_three_fields(self):
        original = self.original_lock()
        updated = dependency_lock_delta(original)
        before = json.loads(original)
        after = json.loads(updated)
        old_entry = before['packages']['node_modules/follow-redirects']
        new_entry = after['packages']['node_modules/follow-redirects']
        changed = {key for key in old_entry if old_entry[key] != new_entry[key]}
        self.assertEqual(changed, {'version', 'resolved', 'integrity'})
        self.assertEqual(new_entry['version'], '1.16.1')
        restored = copy.deepcopy(after)
        restored['packages']['node_modules/follow-redirects'] = old_entry
        self.assertEqual(restored, before)
        self.assertEqual(before['packages']['node_modules/axios']['dependencies']['follow-redirects'], '^1.16.0')

    def test_lockfile_rejects_unrelated_content_change(self):
        with self.assertRaises(RuntimeError):
            dependency_lock_delta(self.original_lock() + b' ')

    def test_only_first_base_line_changes(self):
        original = b'FROM node:24.21.0-bookworm-slim\n\nRUN unchanged\n'
        updated = security_recipe_delta(original)
        self.assertEqual(updated, b'FROM node:24.22.1-bookworm-slim\n\nRUN unchanged\n')

    def test_rejects_unexpected_recipe(self):
        for original in (b'FROM node:latest\n', b'FROM node:24.21.0-bookworm-slim\r\n',
                         b'FROM node:24.21.0-bookworm-slim\nFROM node:24.21.0-bookworm-slim\n'):
            with self.assertRaises(RuntimeError):
                security_recipe_delta(original)

    def test_adapter_assets_are_bound(self):
        root = Path(__file__).with_name('gcp_adapter')
        manifest = json.loads((root / 'manifest.json').read_text())
        for name, digest in manifest.items():
            self.assertEqual(hashlib.sha256((root / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(manifest['preload.cjs'],
                         'f6e31d381183e33fa3054bf79ab3f55744fc4a7d8026380dde586bada0ba3815')


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
