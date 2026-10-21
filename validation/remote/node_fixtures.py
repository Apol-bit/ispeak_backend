"""Hash-bound test-only mounts; never add inputs to the production build context."""
import hashlib
import json
import sys
from pathlib import Path

from materialize import COMMITS


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical_fixture(raw):
    value = json.loads(raw)
    if (value.get('scores', {}).get('overall') != 96.8
            or value.get('assessment_details', {}).get('completeness') != 'complete'):
        raise RuntimeError('Frozen fixture producer returned unexpected evidence')
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def checked_source(entry, data):
    if len(data) != entry['bytes'] or digest(data) != entry['sha256']:
        raise RuntimeError('Test-only fixture source hash mismatch')
    return data


def prepare(v, repo):
    here = Path(__file__).resolve().parent
    manifest = json.loads((here / 'fixture-manifest.json').read_text())
    if (manifest['node_commit'] != COMMITS['node']
            or manifest['python_commit'] != COMMITS['python']):
        raise RuntimeError('Frozen fixture source identity mismatch')
    root = v.root / 'test-support'
    root.mkdir()
    for entry in manifest['node_helpers']:
        if entry['source'] not in ('scripts/audioInventory.js', 'testing/storageFixtures.js'):
            raise RuntimeError('Unexpected Node test-only helper')
        data = v.command(['git', '-C', str(repo), 'show', COMMITS['node'] + ':' + entry['source']])
        destination = root / entry['source']
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(checked_source(entry, data))
    if len(manifest['node_helpers']) != 2:
        raise RuntimeError('Incomplete Node test-only helper set')
    python_root = root / 'python-source'
    for entry in manifest['python_sources']:
        if entry['source'] not in ('assessment_details.py', 'testing_script/test_assessment_details.py'):
            raise RuntimeError('Unexpected Python fixture input')
        source = here / 'fixtures/python' / entry['source']
        destination = python_root / entry['source']
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(checked_source(entry, source.read_bytes()))
    if len(manifest['python_sources']) != 2:
        raise RuntimeError('Incomplete Python fixture source set')
    # -I -S: stdlib and the producer's explicit frozen source directory only.
    # --fixture executes deterministic evidence generation, not unittest/model code.
    raw = v.command([sys.executable, '-I', '-S', '-B',
        str(python_root / 'testing_script/test_assessment_details.py'), '--fixture'], seconds=20)
    fixture = canonical_fixture(raw)
    if digest(fixture) != manifest['fixture_sha256']:
        raise RuntimeError('Frozen fixture output hash mismatch')
    data_root = root / 'data'
    data_root.mkdir()
    (data_root / 'assessment.json').write_bytes(fixture)
    (data_root / 'fixture-manifest.json').write_bytes((here / 'fixture-manifest.json').read_bytes())
    wrapper = (here / 'python_fixture_replay.cjs').read_bytes()
    if digest(wrapper) != manifest['replay_sha256']:
        raise RuntimeError('Test fixture replay hash mismatch')
    bin_root = root / 'bin'
    bin_root.mkdir()
    (bin_root / 'python').write_bytes(wrapper)
    (bin_root / 'python').chmod(0o755)
    v.evidence('node_test_fixtures', result='PASS', node_commit=manifest['node_commit'],
        python_fixture_commit=manifest['python_commit'], fixture_sha256=manifest['fixture_sha256'],
        model_imports=False, python_service_started=False, production_image_modified=False)
    mounts = []
    for source, target in ((root / 'scripts', '/app/scripts'), (root / 'testing', '/app/testing'),
                           (python_root, '/ispeak_python-backendV2'), (data_root, '/fixture-data'),
                           (bin_root, '/fixture-bin')):
        mounts.extend(['--mount', f'type=bind,src={source},dst={target},readonly'])
    return mounts + ['--env', 'PATH=/fixture-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']
