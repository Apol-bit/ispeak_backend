"""Offline tooling safety regressions; Docker and network calls are mocked."""
import contextlib
import copy
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import materialize
import preflight
import runner


class Safeguards(unittest.TestCase):
    def sample(self, ram=8, disk=50):
        return {'available_ram_bytes': ram * preflight.GIB,
                'docker_memory_bytes': 16 * preflight.GIB,
                'docker_free_bytes': disk * preflight.GIB,
                'system_free_bytes': 15 * preflight.GIB}

    def test_role_specific_resource_boundaries(self):
        for role, ram, start_disk, continuous_disk in [('node', 5, 20, 15), ('python', 8, 50, 50)]:
            with self.subTest(role=role):
                self.assertFalse(preflight.problems(role, self.sample(ram, start_disk), start=True))
                self.assertIn('RAM', preflight.problems(role, self.sample(ram - 1, start_disk), start=True))
                self.assertIn('DOCKER_DISK', preflight.problems(role, self.sample(ram, start_disk - 1), start=True))
                self.assertFalse(preflight.problems(role, self.sample(5, continuous_disk), start=False))
                self.assertIn('DOCKER_DISK', preflight.problems(role, self.sample(5, continuous_disk - 1), start=False))
                self.assertIn('RAM', preflight.problems(role, self.sample(4, continuous_disk), start=False))

    def test_system_and_docker_memory_floors(self):
        data = self.sample()
        data['system_free_bytes'] -= 1
        data['docker_memory_bytes'] = 4 * preflight.GIB
        self.assertIn('SYSTEM_DISK', preflight.problems('node', data, start=True))
        self.assertIn('RAM', preflight.problems('node', data, start=True))

    def test_frozen_identities(self):
        self.assertEqual(materialize.COMMITS['node'], 'dfa3138f76bb25fa83d0ca61adf4cc256b53fa6c')
        self.assertEqual(materialize.COMMITS['python'], 'a76c6f47bde88f39570c99fb1de012cfbda9df72')
        self.assertEqual(materialize.BASE, 'ghcr.io/apol-bit/ispeak-python@sha256:a938fb342d2ef69ad0e6110b4031d41b7ddc9628311f2f50788922a2c034c05e')

    def test_disabled_execution_does_no_work(self):
        v = runner.Validation.__new__(runner.Validation)
        v.role = 'node'
        with patch.dict(os.environ, {'AUTOMATION_REVIEW_APPROVED': 'false'}, clear=False), patch.object(runner, 'enforce') as enforce:
            with self.assertRaises(RuntimeError):
                v.execute()
            enforce.assert_not_called()

    def test_testing_policy_is_required(self):
        v = runner.Validation.__new__(runner.Validation)
        v.role = 'node'
        with patch.dict(os.environ, {'AUTOMATION_REVIEW_APPROVED': 'true', 'TESTING_CONTAINMENT_ACCEPTED': 'false'}), patch.object(runner, 'enforce') as enforce:
            with self.assertRaises(RuntimeError):
                v.execute()
            enforce.assert_not_called()

    def test_private_access_stops_before_pull(self):
        v = runner.Validation.__new__(runner.Validation)
        v.command = Mock()
        v.token = 'synthetic-not-a-credential'
        with patch.dict(os.environ, {'PRIVATE_BASE_ACCESS_APPROVED': 'false'}):
            with self.assertRaises(RuntimeError):
                v.login()
            v.command.assert_not_called()

    def test_no_cancellation_fixture_method(self):
        self.assertFalse(hasattr(runner.Validation, 'cancel_probe'))

    def test_owned_absence_requires_successful_queries(self):
        v = runner.Validation.__new__(runner.Validation)
        v.builder = 'owned'
        v.evidence = Mock()
        v.docker = Mock(side_effect=[b'', b''])
        v.assert_builder_absent('after_cleanup')
        v.docker = Mock(side_effect=[b'', b'leftover'])
        with self.assertRaises(RuntimeError):
            v.assert_builder_absent('after_cleanup')
        v.docker = Mock(side_effect=RuntimeError('API failure'))
        with self.assertRaises(RuntimeError):
            v.assert_builder_absent('after_cleanup')

    def test_unowned_builder_is_never_stopped(self):
        v = runner.Validation.__new__(runner.Validation)
        v.builder, v.key = 'owned', '123-1'
        data = {'Name': '/some-other-container', 'Config': {'Env': []}}
        v.docker = Mock(side_effect=[b'id', json.dumps([data]).encode()])
        with self.assertRaises(RuntimeError):
            v.stop_builder()
        self.assertEqual(v.docker.call_count, 2)

    def test_node_gate_rejects_unreviewed_run_identity(self):
        from node_gate import require_node_success
        with patch.dict(os.environ, {'NODE_VALIDATION_RUN_ID': 'REVIEW_REQUIRED', 'NODE_AUTOMATION_SHA': 'REVIEW_REQUIRED'}):
            with self.assertRaises(RuntimeError):
                require_node_success()

    def test_builder_caps_and_live_parallelism(self):
        image = 'moby/buildkit@sha256:' + 'a' * 64
        valid = {'Id': 'owned-id', 'Image': 'image-id', 'RestartCount': 0,
                 'State': {'Running': True, 'OOMKilled': False},
                 'HostConfig': {'Memory': 4 * preflight.GIB, 'MemorySwap': 4 * preflight.GIB,
                                'CpuQuota': 200000, 'CpuPeriod': 100000, 'RestartPolicy': {'Name': 'no'}},
                 'Config': {'Env': ['ISPEAK_RELEASE_RUN=123-1'], 'Image': image}}
        for mutation in (None, 'Memory', 'MemorySwap', 'CpuQuota', 'restart', 'parallelism'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                metadata = copy.deepcopy(valid)
                if mutation in ('Memory', 'MemorySwap', 'CpuQuota'):
                    metadata['HostConfig'][mutation] = 0
                if mutation == 'restart':
                    metadata['HostConfig']['RestartPolicy']['Name'] = 'unless-stopped'
                parallelism = 2 if mutation == 'parallelism' else 1
                config = ('[worker.oci]\nenabled=true\nmax-parallelism=' + str(parallelism)
                          + '\n[worker.containerd]\nenabled=false\n').encode()
                v = runner.Validation.__new__(runner.Validation)
                v.root, v.builder, v.key = Path(temp), 'owned', '123-1'
                v.assert_builder_absent, v.evidence = Mock(), Mock()
                def docker(*args, **_kwargs):
                    if args[:2] == ('buildx', 'version'):
                        return b'github.com/docker/buildx v0.28.0 test'
                    if args[0] == 'version':
                        return b'28.0.4'
                    if args[0] == 'inspect':
                        return json.dumps([metadata]).encode()
                    if args[:2] == ('image', 'inspect'):
                        return json.dumps([{'Id': 'image-id'}]).encode()
                    if args[0] == 'exec':
                        return config
                    return b''
                v.docker = Mock(side_effect=docker)
                with patch.dict(os.environ, {'BUILDKIT_IMAGE': image}):
                    if mutation is None:
                        v.builder_start()
                    else:
                        with self.assertRaises(RuntimeError):
                            v.builder_start()


class ReportingTests(unittest.TestCase):
    def validator(self, temp):
        with patch.dict(os.environ, {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'RUNNER_TEMP': temp}):
            return runner.Validation('node')

    def test_successful_subprocess_preserves_return_contract(self):
        import sys
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            v = self.validator(temp)
            self.assertEqual(v.command([sys.executable, '-c', 'print("success")']), b'success\r\n' if os.name == 'nt' else b'success\n')
            self.assertIsNone(v.failure)
            self.assertEqual(v.last_command['exit_code'], 0)

    def test_failed_subprocess_reports_sanitized_streams(self):
        import sys
        hidden = 'PRIVATE_SENTINEL_123456789'
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(output):
            v = self.validator(temp)
            v.set_stage('node_image_tests')
            code = 'import sys; print(' + repr(hidden) + '); print("MODULE_NOT_FOUND audioInventory.test.js",file=sys.stderr); sys.exit(7)'
            with self.assertRaises(RuntimeError):
                v.command([sys.executable, '-c', code])
            self.assertEqual(v.failure['exit_code'], 7)
            self.assertEqual(v.failure['stage'], 'node_image_tests')
            self.assertIn('MODULE_NOT_FOUND', v.failure['stderr']['error_codes'])
            self.assertIn('audioInventory.test.js', v.failure['stderr']['test_files'])
        self.assertNotIn(hidden, output.getvalue())
        self.assertNotIn(code, output.getvalue())

    def test_expected_nonzero_is_not_a_validation_failure(self):
        import sys
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            v = self.validator(temp)
            status, raw = v.command([sys.executable, '-c', 'import sys; print("ENOENT",file=sys.stderr);sys.exit(3)'], check=False)
            self.assertEqual(status, 3)
            self.assertIn(b'ENOENT', raw)
            self.assertIsNone(v.failure)
            self.assertEqual(v.last_command['stderr']['error_codes'], ['ENOENT'])

    def test_unstructured_secrets_are_never_projected(self):
        from reporting import command_label, project_output
        private = b'JWT_SECRET=opaque-private-value\nAuthorization: Bearer fake-token\nMONGO_URI=mongodb://user:password@host/private\nunknown_setting=unrecognized-private-value\n'
        projected = json.dumps(project_output(private + b'# fail 2\nMODULE_NOT_FOUND\n'))
        for value in ('opaque-private-value', 'fake-token', 'password', 'unrecognized-private-value'):
            self.assertNotIn(value, projected)
            self.assertNotIn(value, command_label(['docker', 'run', '-e', value]))
        self.assertEqual(project_output(private + b'# fail 2\n')['tap_counts']['fail'], 2)

    def test_metadata_and_minima_survive_later_failure(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()) as output:
            v = self.validator(temp)
            v.record_image({'Id': 'sha256:' + 'a' * 64, 'Size': 12345,
                'Config': {'Labels': {'org.opencontainers.image.revision': materialize.COMMITS['node']}}})
            v.observe({'available_ram_bytes': 9, 'docker_free_bytes': 30})
            v.observe({'available_ram_bytes': 7, 'docker_free_bytes': 35})
            v.stage = 'node_image_tests'
            v.final_summary(1)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(events[0]['check'], 'image_built')
            summary = events[-1]
            self.assertEqual(summary['image']['image_size_bytes'], 12345)
            self.assertEqual(summary['resource_minima'], {'available_ram_bytes': 7, 'docker_free_bytes': 30})
            self.assertTrue(summary['cleanup_pending'])
            self.assertTrue(v.root.exists())

    def test_preflight_failure_is_observed_before_gate_exception(self):
        first = Safeguards().sample(ram=5, disk=20)
        low = {**first, 'available_ram_bytes': 1}
        observer = Mock()
        with patch.object(preflight, 'measure', side_effect=[first, low]), patch.object(preflight.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                preflight.enforce('node', stable=True, observer=observer)
        self.assertEqual(observer.call_count, 2)
        self.assertEqual(observer.call_args.args[0]['available_ram_bytes'], 1)

    def test_main_summarizes_before_cleanup_on_failure(self):
        import sys
        events = []
        v = Mock()
        v.execute.side_effect = RuntimeError('controlled failure')
        v.final_summary.side_effect = lambda result: events.append(('summary', result))
        v.cleanup.side_effect = lambda: events.append(('cleanup', None))
        env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'ROLE': 'node',
               'GITHUB_REPOSITORY': 'Apol-bit/ispeak_backend', 'GITHUB_ACTOR': 'Apol-bit',
               'GITHUB_EVENT_NAME': 'push', 'GITHUB_REF': 'refs/heads/ci/validate-node-dfa3138f-20261021'}
        with patch.dict(os.environ, env), patch.object(runner.os, 'name', 'posix'), patch.object(runner, 'Validation', return_value=v), patch.object(runner.signal, 'signal'), patch.object(sys, 'argv', ['runner.py', 'node']), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.main(), 1)
        self.assertEqual(events, [('summary', 1), ('cleanup', None)])

    def test_reporting_failure_does_not_skip_cleanup(self):
        import sys
        v = Mock()
        v.final_summary.side_effect = OSError('closed log stream')
        env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'ROLE': 'node',
               'GITHUB_REPOSITORY': 'Apol-bit/ispeak_backend', 'GITHUB_ACTOR': 'Apol-bit',
               'GITHUB_EVENT_NAME': 'push', 'GITHUB_REF': 'refs/heads/ci/validate-node-dfa3138f-20261021'}
        with patch.dict(os.environ, env), patch.object(runner.os, 'name', 'posix'), patch.object(runner, 'Validation', return_value=v), patch.object(runner.signal, 'signal'), patch.object(sys, 'argv', ['runner.py', 'node']):
            self.assertEqual(runner.main(), 1)
        v.cleanup.assert_called_once()


class FixtureTests(unittest.TestCase):
    def setUp(self):
        import node_fixtures
        self.module = node_fixtures
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.here = self.base / 'tooling'
        self.here.mkdir()
        actual = Path(node_fixtures.__file__).resolve().parent
        self.manifest = json.loads((actual / 'fixture-manifest.json').read_text())
        for entry in self.manifest['python_sources']:
            target = self.here / 'fixtures/python' / entry['source']
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((actual / 'fixtures/python' / entry['source']).read_bytes())
        (self.here / 'python_fixture_replay.cjs').write_bytes((actual / 'python_fixture_replay.cjs').read_bytes())
        self.helpers = {entry['source']: ('// synthetic helper ' + entry['source']).encode()
                        for entry in self.manifest['node_helpers']}
        for entry in self.manifest['node_helpers']:
            entry['bytes'] = len(self.helpers[entry['source']])
            entry['sha256'] = node_fixtures.digest(self.helpers[entry['source']])
        self.save_manifest()
        self.v = Mock()
        self.v.root = self.base / 'run'
        self.v.root.mkdir()
        self.python_commands = 0
        def command(args, **kwargs):
            import subprocess
            if args[0] == 'git':
                return self.helpers[args[-1].split(':', 1)[1]]
            self.python_commands += 1
            return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=kwargs['seconds'])
        self.v.command = command

    def save_manifest(self):
        (self.here / 'fixture-manifest.json').write_text(json.dumps(self.manifest))

    def prepare(self):
        with patch.object(self.module, '__file__', str(self.here / 'node_fixtures.py')):
            return self.module.prepare(self.v, self.base / 'source')

    def replay(self, args):
        import shutil
        import subprocess
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Host Node is required for offline fixture replay checks')
        support = self.v.root / 'test-support'
        mappings = {'/fixture-data/fixture-manifest.json': str(support / 'data/fixture-manifest.json'),
                    '/fixture-data/assessment.json': str(support / 'data/assessment.json')}
        for entry in self.manifest['python_sources']:
            mappings['/ispeak_python-backendV2/' + entry['source']] = str(support / 'python-source' / entry['source'])
        loader = r'''const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const code=fs.readFileSync(input.script,'utf8');
process.argv=[process.execPath,'fixture-python',...input.args];
vm.runInNewContext(code,{process,require(name){
 if(name==='node:crypto')return crypto;
 if(name==='node:fs')return {readFileSync(p,options){if(!Object.hasOwn(input.mappings,p))throw Error('unmapped');return fs.readFileSync(input.mappings[p],options);}};
 throw Error('unexpected module');
}});'''
        return subprocess.run([node, '-e', loader], input=json.dumps({'script': str(support / 'bin/python'),
            'args': args, 'mappings': mappings}).encode(), stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=10, check=False)

    def test_exact_producer_generates_hash_bound_readonly_mounts(self):
        args = self.prepare()
        self.assertEqual(self.python_commands, 1)
        mounts = [args[i + 1] for i, item in enumerate(args) if item == '--mount']
        self.assertEqual(len(mounts), 5)
        self.assertTrue(all(item.endswith(',readonly') for item in mounts))
        self.assertTrue(all('docker.sock' not in item and '.env' not in item for item in mounts))
        data = (self.v.root / 'test-support/data/assessment.json').read_bytes()
        self.assertEqual(self.module.digest(data), self.manifest['fixture_sha256'])
        self.assertEqual(json.loads(data)['scores']['overall'], 96.8)

    def test_hash_mismatch_stops_before_producer(self):
        self.manifest['node_helpers'][0]['sha256'] = '0' * 64
        self.save_manifest()
        with self.assertRaises(RuntimeError):
            self.prepare()
        self.assertEqual(self.python_commands, 0)

    def test_changed_output_is_rejected(self):
        self.manifest['fixture_sha256'] = '0' * 64
        self.save_manifest()
        with self.assertRaises(RuntimeError):
            self.prepare()

    def test_replay_matches_original_request_and_bytes(self):
        self.prepare()
        result = self.replay(['-B', '/ispeak_python-backendV2/testing_script/test_assessment_details.py', '--fixture'])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, (self.v.root / 'test-support/data/assessment.json').read_bytes())
        self.assertEqual(result.stderr, b'')

    def test_replay_rejects_arbitrary_python_and_tampering(self):
        self.prepare()
        result = self.replay(['-c', 'print("PRIVATE_VALUE")'])
        self.assertEqual(result.returncode, 64)
        self.assertEqual(result.stdout + result.stderr, b'')
        (self.v.root / 'test-support/data/assessment.json').write_bytes(b'{}')
        result = self.replay(['-B', '/ispeak_python-backendV2/testing_script/test_assessment_details.py', '--fixture'])
        self.assertEqual(result.returncode, 65)
        self.assertEqual(result.stdout + result.stderr, b'')

    def test_test_container_remains_network_isolated(self):
        v = runner.Validation.__new__(runner.Validation)
        v.label = 'ispeak.validation.run=123-1'
        args = v.run_args('test')
        self.assertEqual(args[args.index('--network') + 1], 'none')
        self.assertIn('--cap-drop=ALL', args)


if __name__ == '__main__':
    unittest.main()
