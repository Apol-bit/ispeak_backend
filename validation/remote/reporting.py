"""Public diagnostics by allowlisted projection, never by echoing raw text/argv."""
import re

STAGES = frozenset(('initialization', 'preflight', 'source_export', 'private_base',
    'builder_setup', 'post_builder_preflight', 'build_load', 'image_metadata',
    'image_validation', 'builder_stop', 'node_version', 'node_dependencies',
    'node_test_export', 'node_image_tests', 'node_configuration', 'node_health',
    'node_shutdown', 'node_source_integrity', 'complete', 'cleanup'))
ERROR_CODES = frozenset(('MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_ASSERTION',
    'ERR_TEST_FAILURE', 'EACCES', 'ENOENT', 'EADDRINUSE', 'ENOMEM', 'ENOSPC', 'EPERM'))
# Reviewed public test filenames, not arbitrary text parsed from subprocess output.
TEST_FILES = frozenset(('analysisAdmission.test.js', 'analysisGateway.test.js',
    'analysisResponse.test.js', 'assessmentDetails.test.js', 'audioInventory.test.js',
    'authorization.test.js', 'containerConfiguration.test.js', 'databaseReadiness.test.js',
    'fillerAnalysis.test.js', 'history.test.js', 'integrationIsolation.test.js',
    'localAudioUat.test.js', 'performanceStatistics.test.js', 'r2Flows.test.js',
    'readOnlyStartup.test.js', 'recordingDuration.test.js', 'registration.test.js',
    'registrationPolicy.test.js', 'resources.test.js', 'securityHardening.test.js',
    'storageCleanup.test.js', 'storageEnvironment.test.js', 'storageProvider.test.js',
    'transcriptValidation.test.js'))


def command_label(args):
    """Return a command shape; argument values, paths and inline code are omitted."""
    if args and args[0] == 'git':
        operation = next((word for word in ('show', 'fetch', 'rev-parse', 'ls-tree', 'init', 'remote')
                          if word in args[1:]), 'other')
        name = args[-1].split('/')[-1] if operation == 'show' else None
        reviewed_file = ' test/' + name if name in TEST_FILES else ''
        return 'git ' + operation + reviewed_file + ' [arguments withheld]'
    if args and args[0] == 'docker':
        allowed = {'run', 'exec', 'inspect', 'stop', 'version', 'pull', 'login',
                   'container', 'volume', 'image', 'buildx'}
        operation = args[1] if len(args) > 1 and args[1] in allowed else 'other'
        if operation == 'buildx' and len(args) > 2 and args[2] in ('build', 'create', 'inspect', 'ls', 'rm', 'version'):
            operation += ' ' + args[2]
        return 'docker ' + operation + ' [arguments withheld]'
    return 'other subprocess [arguments withheld]'


def project_output(data):
    """Keep fixed error categories, reviewed filenames and bounded TAP counts only."""
    text = data.decode('utf-8', errors='replace')
    codes = sorted(code for code in ERROR_CODES if re.search(r'\b' + code + r'\b', text))
    counts = {}
    for name, value in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d{1,6})\s*$', text, re.M):
        counts[name] = int(value)
    messages = []
    for pattern, label in ((r'Cannot find module|Cannot find package', 'module_unavailable'),
                           (r'Permission denied', 'permission_denied'),
                           (r'No such file or directory', 'file_unavailable'),
                           (r'Invalid container production configuration', 'production_configuration_rejected')):
        if re.search(pattern, text, re.I):
            messages.append(label)
    return {'error_codes': codes, 'test_files': sorted(name for name in TEST_FILES if name in text),
            'tap_counts': counts, 'recognized_messages': messages,
            'raw_output_withheld': True, 'diagnostic_bytes_scanned': len(data)}


def project_file(path):
    try:
        with path.open('rb') as source:
            size = path.stat().st_size
            head = source.read(32768)
            tail = b''
            if size > 32768:
                source.seek(max(32768, size - 32768))
                tail = source.read(32768)
        result = project_output(head + b'\n' + tail)
        result['scan_truncated'] = size > 65536
        return result
    except OSError:
        return {'diagnostics_unavailable': True, 'raw_output_withheld': True}


def image_record(image, source):
    image_id, size = image.get('Id'), image.get('Size')
    if not isinstance(image_id, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
        raise RuntimeError('Invalid image identity metadata')
    if type(size) is not int or size < 0:
        raise RuntimeError('Invalid image size metadata')
    return {'source_commit': source, 'image_id': image_id, 'image_size_bytes': size,
            'revision_label_matches': image.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == source}
