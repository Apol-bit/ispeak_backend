"""Regression checks for the exact, one-line frozen-recipe security delta."""
import hashlib
import json
import unittest
from pathlib import Path
from materialize import security_recipe_delta


class SecurityDelta(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
