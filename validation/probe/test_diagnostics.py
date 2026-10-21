"""Offline tests: synthetic limits and mocked Docker metadata only."""
import ast
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from policy import effective_limit_diagnostics, valid_effective_limits
from probe import Probe


class Limits(unittest.TestCase):
    def test_valid(self):
        report = effective_limit_diagnostics('4294967296\n', '0\n', '200000 100000\n')
        self.assertTrue(report['strict_gate_pass'])
        self.assertEqual(report['failed_fields'], [])

    def test_invalid_and_unlimited(self):
        cases = [
            ('max', '0', '200000 100000', 'memory_exact'),
            ('4294967295', '0', '200000 100000', 'memory_exact'),
            ('8589934592', '0', '200000 100000', 'memory_exact'),
            ('4294967296', 'max', '200000 100000', 'swap_disabled'),
            ('4294967296', '4294967296', '200000 100000', 'swap_disabled'),
            ('4294967296', '0', 'max 100000', 'cpu_exact_pair'),
            ('4294967296', '0', '400000 100000', 'cpu_exact_pair'),
            ('4294967296', '0', '100000 100000', 'cpu_exact_pair'),
            ('4294967296', '0', '200000 0', 'cpu_exact_pair'),
            ('4294967296', '0', '-1 100000', 'cpu_exact_pair'),
        ]
        for memory, swap, cpu, field in cases:
            with self.subTest(memory=memory, swap=swap, cpu=cpu):
                report = effective_limit_diagnostics(memory, swap, cpu)
                self.assertFalse(report['strict_gate_pass'])
                self.assertIn(field, report['failed_fields'])

    def test_equivalent_cpu_encoding_still_fails_strict_gate(self):
        report = effective_limit_diagnostics('4294967296', '0', '100000 50000')
        self.assertTrue(report['cpu_ratio_equivalent'])
        self.assertFalse(report['strict_gate_pass'])
        self.assertEqual(report['failed_fields'], ['cpu_exact_pair'])

    def test_malformed_input_is_not_echoed(self):
        private = 'DO_NOT_LOG_PRIVATE_VALUE'
        report = effective_limit_diagnostics(private, private, private + ' ' + private)
        self.assertNotIn(private, json.dumps(report))
        self.assertFalse(report['strict_gate_pass'])
        self.assertEqual(report['actual']['memory_max_bytes'], 'malformed')

    def test_exact_whitespace_and_canonical_evaluation_preserved(self):
        for memory, swap, cpu in [('04294967296', '0', '200000 100000'),
                                  ('4294967296', '00', '200000 100000'),
                                  ('4294967296', '0', '0200000 100000')]:
            report = effective_limit_diagnostics(memory, swap, cpu)
            self.assertFalse(report['strict_gate_pass'])
            self.assertTrue(report['failed_fields'])
            self.assertEqual(report['strict_gate_pass'], valid_effective_limits(memory, swap, cpu))


class Absence(unittest.TestCase):
    def probe(self, responses):
        probe = Probe.__new__(Probe)
        probe.name = 'buildx_buildkit_ispeak-probe-123-10'
        probe.command = Mock(side_effect=responses)
        return probe

    def test_successful_empty_lists_prove_absence(self):
        probe = self.probe([b'', b''])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            probe.verify_owned_absence('after_cleanup')
        report = json.loads(output.getvalue())
        self.assertTrue(report['container_absent'])
        self.assertTrue(report['state_volume_absent'])
        args = [call.args[0] for call in probe.command.call_args_list]
        self.assertIn('name=^/' + probe.name + '$', args[0])
        self.assertIn('name=^' + probe.name + '_state$', args[1])

    def test_remaining_container_or_volume_fails(self):
        for replies in ([b'container-id', b''], [b'', b'owned-state-volume']):
            with self.subTest(replies=replies), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(RuntimeError):
                    self.probe(replies).verify_owned_absence('after_cleanup')

    def test_api_error_is_not_absence(self):
        probe = self.probe([RuntimeError('API failed')])
        with self.assertRaises(RuntimeError):
            probe.verify_owned_absence('after_cleanup')

    def test_cleanup_stops_removes_then_verifies_absence(self):
        probe = self.probe([])
        probe.marker = 'ISPEAK_NODE_PROBE_RUN=123-1'
        probe.builder = 'ispeak-probe-123-1'
        probe.root = Mock()
        probe.root.resolve.return_value.parent = None
        data = {'Id': 'owned-id', 'Name': '/' + probe.name,
                'Config': {'Env': [probe.marker]},
                'Mounts': [{'Type': 'volume', 'Name': probe.name + '_state'}]}
        probe.command.side_effect = [(0, json.dumps([data]).encode()), b'',
                                     json.dumps([{'State': {'Running': False}}]).encode(),
                                     b'', b'', b'']
        with patch.dict(os.environ, {'RUNNER_TEMP': tempfile.gettempdir()}), contextlib.redirect_stdout(io.StringIO()):
            probe.cleanup()
        commands = [call.args[0] for call in probe.command.call_args_list]
        self.assertEqual(commands[1], ['docker', 'stop', '--time=3', 'owned-id'])
        self.assertEqual(commands[3], ['docker', 'buildx', 'rm', probe.builder])
        self.assertEqual(commands[4][:3], ['docker', 'container', 'ls'])
        self.assertEqual(commands[5][:3], ['docker', 'volume', 'ls'])

    def test_cleanup_refuses_unowned_container(self):
        probe = self.probe([(0, json.dumps([{'Name': '/other', 'Config': {'Env': []}}]).encode())])
        probe.marker = 'ISPEAK_NODE_PROBE_RUN=123-1'
        with self.assertRaises(RuntimeError):
            probe.cleanup()
        self.assertEqual(probe.command.call_count, 1)

    def test_no_new_docker_workload_operations(self):
        source = Path(__file__).with_name('probe.py').read_text()
        literals = {n.value for n in ast.walk(ast.parse(source))
                    if isinstance(n, ast.Constant) and isinstance(n.value, str)}
        self.assertFalse(literals.intersection({'build', 'load', 'push', 'login', 'run', 'pull', 'prune'}))


if __name__ == '__main__':
    unittest.main()
