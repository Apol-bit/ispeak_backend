"""Export only reviewed Git blobs, and independently compare the recorded hashes."""
import hashlib
import copy
import json
import subprocess
from pathlib import Path

COMMITS = {'node': 'dfa3138f76bb25fa83d0ca61adf4cc256b53fa6c',
           'python': 'a76c6f47bde88f39570c99fb1de012cfbda9df72'}
REPOS = {'node': 'ispeak_backend', 'python': 'ispeak_python-backendV2'}
BASE = 'ghcr.io/apol-bit/ispeak-python@sha256:a938fb342d2ef69ad0e6110b4031d41b7ddc9628311f2f50788922a2c034c05e'


def security_recipe_delta(content):
    old = b'FROM node:24.21.0-bookworm-slim\n'
    new = b'FROM node:24.22.1-bookworm-slim\n'
    if not content.startswith(old) or content.count(old) != 1:
        raise RuntimeError('Unexpected frozen Node recipe; refuse security delta')
    return new + content[len(old):]


def dependency_lock_delta(content):
    patch = json.loads(Path(__file__).with_name('dependency-security-patch.json').read_text())
    if (patch['package'] != 'follow-redirects' or patch['path'] != 'node_modules/follow-redirects'
            or patch['before']['version'] != '1.16.0' or patch['after']['version'] != '1.16.1'
            or patch['changed_fields'] != ['version', 'resolved', 'integrity']
            or hashlib.sha256(content).hexdigest() != patch['original_sha256']):
        raise RuntimeError('Frozen dependency lock identity mismatch')
    before = json.loads(content)
    expected = copy.deepcopy(before)
    entry = expected['packages'][patch['path']]
    if any(entry[key] != value for key, value in patch['before'].items()):
        raise RuntimeError('Unexpected original follow-redirects entry')
    text = content.decode('utf-8')
    start = text.index('    "node_modules/follow-redirects": {')
    end = text.index('\n    },', start) + len('\n    },')
    block = text[start:end]
    for key in patch['changed_fields']:
        old = json.dumps(key) + ': ' + json.dumps(patch['before'][key])
        new = json.dumps(key) + ': ' + json.dumps(patch['after'][key])
        if block.count(old) != 1:
            raise RuntimeError('Unexpected lockfile formatting; refuse broad rewrite')
        block = block.replace(old, new)
    updated = (text[:start] + block + text[end:]).encode('utf-8')
    entry.update(patch['after'])
    if (json.loads(updated) != expected
            or hashlib.sha256(updated).hexdigest() != patch['patched_sha256']):
        raise RuntimeError('Dependency delta changed unapproved lockfile content')
    return updated


def export(role, root, command):
    repo, output = root / 'source', root / 'context'
    repo.mkdir()
    command(['git', 'init', str(repo)])
    command(['git', '-C', str(repo), 'remote', 'add', 'origin',
             f'https://github.com/Apol-bit/{REPOS[role]}.git'])
    command(['git', '-C', str(repo), 'fetch', '--depth=1', 'origin', COMMITS[role]], seconds=120)
    sha = command(['git', '-C', str(repo), 'rev-parse', 'FETCH_HEAD']).decode().strip()
    if sha != COMMITS[role]:
        raise RuntimeError('Frozen source identity mismatch')
    manifest = json.loads(Path(__file__).with_name('context-manifest.json').read_text())['contexts'][role]
    if manifest['commit'] != sha:
        raise RuntimeError('Manifest source identity mismatch')
    for entry in manifest['files']:
        name = entry['path']
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise RuntimeError('Unsafe context path')
        content = command(['git', '-C', str(repo), 'show', f'{sha}:{name}'])
        if len(content) != entry['bytes'] or hashlib.sha256(content).hexdigest() != entry['sha256']:
            raise RuntimeError('Approved context hash mismatch')
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    if role == 'node':
        lockfile = output / 'package-lock.json'
        updated_lock = dependency_lock_delta(lockfile.read_bytes())
        lockfile.write_bytes(updated_lock)
        print(json.dumps({'check': 'node_dependency_security_delta',
            'package': 'follow-redirects', 'from': '1.16.0', 'to': '1.16.1',
            'changed_fields': ['version', 'resolved', 'integrity'],
            'lockfile_sha256': hashlib.sha256(updated_lock).hexdigest(),
            'package_json_changed': False, 'application_files_changed': False}), flush=True)
        recipe = output / 'Dockerfile'
        original = recipe.read_bytes()
        updated = security_recipe_delta(original)
        recipe.write_bytes(updated)
        print(json.dumps({'check': 'node_security_recipe_delta',
            'frozen_source': sha, 'from': '24.21.0', 'to': '24.22.1',
            'original_recipe_sha256': hashlib.sha256(original).hexdigest(),
            'security_recipe_sha256': hashlib.sha256(updated).hexdigest(),
            'application_files_changed': False}), flush=True)
    if role == 'python':
        recipe = (output / 'docker/Dockerfile.v6-overlay').read_text()
        instructions = [line.strip() for line in recipe.splitlines() if line.strip() and not line.startswith('#')]
        if instructions[0] != 'FROM ' + BASE or any(line.split()[0] not in ('FROM', 'WORKDIR', 'COPY') for line in instructions):
            raise RuntimeError('Python source-only recipe or immutable base changed')
    print(json.dumps({'source_commit': sha, 'context_files': len(manifest['files']),
                      'context_bytes': manifest['bytes']}), flush=True)
    return repo, output


def export_tests(repo, root, command):
    """Tests are read-only mounts, never part of the production image context."""
    sha = COMMITS['node']
    names = command(['git', '-C', str(repo), 'ls-tree', '-r', '--name-only', sha, 'test']).decode().splitlines()
    destination = root / 'tests'
    destination.mkdir()
    for name in names:
        relative = Path(name).relative_to('test')
        if '..' in relative.parts:
            raise RuntimeError('Unsafe test path')
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(command(['git', '-C', str(repo), 'show', f'{sha}:{name}']))
    return destination
