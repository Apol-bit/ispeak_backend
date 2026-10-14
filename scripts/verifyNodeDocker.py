"""Opt-in disposable Docker verification; no local .env or user database access.
Usage: python scripts/verifyNodeDocker.py --speech-file <generated-speech.wav>
Requires existing ispeak-node:local, mongo:8.0 and verified Python image.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import threading
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--speech-file', required=True, help='Generated synthetic WAV only; never user audio')
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
speech = Path(args.speech_file).resolve()
if not speech.is_file():
    raise SystemExit('Generated speech file is required')
run_id = uuid.uuid4().hex[:12]
network = 'ispeak-node-check-' + run_id
node, mongo, python = [network + '-' + name for name in ['node', 'mongo', 'python']]
environment = dict(os.environ)
environment.update(JWT_SECRET=secrets.token_hex(32), PYTHON_SERVICE_TOKEN=secrets.token_hex(32), R2_ACCESS_KEY_ID=secrets.token_hex(16), R2_SECRET_ACCESS_KEY=secrets.token_hex(32))
environment['ISPEAK_SERVICE_TOKEN'] = environment['PYTHON_SERVICE_TOKEN']
original_env = hashlib.sha256((repo / '.env').read_bytes()).hexdigest() if (repo / '.env').exists() else None
report = {'checks': {}, 'resources': [], 'liveAtlas': 'NOT TESTED', 'liveR2': 'NOT TESTED', 'userDataModified': False}
created = []

def docker(*command, timeout=60, required=True):
    result = subprocess.run(['docker', *command], env=environment, text=True, encoding='utf-8', errors='replace', capture_output=True, timeout=timeout)
    if required and result.returncode:
        raise RuntimeError('Docker operation failed: ' + command[0])
    return result

def ready(container, port):
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        if docker('inspect', '--format', '{{.State.Running}}', container).stdout.strip() != 'true':
            raise RuntimeError('Container exited before readiness')
        code = "import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:" + str(port) + "/health',timeout=3).status==200"
        if container == node:
            command = ['node', '-e', "fetch('http://127.0.0.1:5087/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
        else:
            command = ['python', '-c', code]
        if docker('exec', container, *command, timeout=10, required=False).returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError('Readiness timeout')

def sample(label):
    result = docker('stats', '--no-stream', '--format', '{{json .}}', node)
    value = json.loads(result.stdout)
    report['resources'].append({'phase': label, 'cpu': value['CPUPerc'], 'memory': value['MemUsage']})

def checks(phase):
    result = docker('exec', node, 'node', '/verification/nodeDockerChecks.js', phase, timeout=360)
    report['checks'].update(json.loads(result.stdout.strip().splitlines()[-1]))

try:
    with tempfile.TemporaryDirectory(prefix='ispeak-node-docker-') as directory:
        cert = Path(directory)
        # Only disposable self-signed TLS material. No existing CA or key is read.
        generate = "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout /cert/server.key -out /cert/ca.crt -subj /CN=mongo -addext subjectAltName=DNS:mongo >/dev/null 2>&1 && cat /cert/server.key /cert/ca.crt >/cert/server.pem && chmod 644 /cert/*"
        docker('run', '--rm', '--network', 'none', '--mount', f'type=bind,source={cert},target=/cert', 'mongo:8.0', 'sh', '-c', generate)
        docker('network', 'create', '--internal', network)
        try:
            docker('run', '-d', '--name', mongo, '--network', network, '--network-alias', 'mongo', '--memory', '1g', '--cpus', '1', '--mount', f'type=bind,source={cert},target=/cert,readonly', 'mongo:8.0', 'mongod', '--wiredTigerCacheSizeGB', '0.25', '--bind_ip_all', '--tlsMode', 'requireTLS', '--tlsCertificateKeyFile', '/cert/server.pem', '--tlsCAFile', '/cert/ca.crt', '--tlsAllowConnectionsWithoutCertificates')
            created.append(mongo)
            docker('run', '-d', '--name', python, '--network', network, '--network-alias', 'python', '--memory', '6g', '--cpus', '4', '--read-only', '--tmpfs', '/tmp/ispeak:rw,noexec,nosuid,size=512m,uid=10001,gid=10001', '-e', 'ISPEAK_SERVICE_TOKEN', '-e', 'PORT=8080', '-e', 'OMP_NUM_THREADS=4', '-e', 'MKL_NUM_THREADS=4', 'ispeak-python-v2:security-verification')
            created.append(python)
            ready(python, 8080)
            configuration = ['-e', 'PORT=5087', '-e', 'MONGO_URI=mongodb://mongo:27017/disposable_' + run_id + '?tls=true', '-e', 'NODE_EXTRA_CA_CERTS=/cert/ca.crt', '-e', 'CORS_ORIGINS=https://admin.example.invalid', '-e', 'PYTHON_BACKEND_URL=http://python:8080', '-e', 'STORAGE_DRIVER=r2', '-e', 'R2_ACCOUNT_ID=' + 'a' * 32, '-e', 'R2_BUCKET=disposable-audio']
            for name in ['JWT_SECRET', 'PYTHON_SERVICE_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']:
                configuration += ['-e', name]
            mount = ['--mount', f'type=bind,source={cert},target=/cert,readonly', '--mount', f'type=bind,source={repo / "testing" / "nodeDockerChecks.js"},target=/verification/nodeDockerChecks.js,readonly', '--mount', f'type=bind,source={speech},target=/verification/generated-speech.wav,readonly']
            start = time.monotonic()
            docker('run', '-d', '--name', node, '--network', network, '--network-alias', 'node', '--memory', '512m', '--cpus', '1', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000', *mount, *configuration, 'ispeak-node:local')
            created.append(node)
            ready(node, 5087)
            report['startupSeconds'] = round(time.monotonic() - start, 2)
            report['checks']['nonRoot'] = docker('exec', node, 'id', '-u').stdout.strip() == '1000'
            report['checks']['imageExclusions'] = docker('exec', node, 'node', '-e', "const fs=require('fs'); for(const p of ['.env','.git','uploads','scripts','test','testing','node_modules/eslint']) if(fs.existsSync('/app/'+p))process.exit(1)").returncode == 0
            # Reach the listener over the private network, rather than loopback alone.
            docker('exec', python, 'python', '-c', "import urllib.request; assert urllib.request.urlopen('http://node:5087/health').status==200")
            report['checks']['bindAllInterfacesDynamicPort'] = True
            sample('idle')
            sampling_stop = threading.Event()
            def monitor():
                while not sampling_stop.is_set():
                    sample('during-network-checks')
                    sampling_stop.wait(2)
            sampler = threading.Thread(target=monitor)
            sampler.start()
            try:
                checks('smoke')
            finally:
                sampling_stop.set()
                sampler.join()
            sample('after-synthetic-inference')
            docker('stop', '-t', '10', mongo)
            time.sleep(12)
            checks('health-down')
            docker('start', mongo)
            ready(node, 5087)
            checks('health-up')
            for missing in ['MONGO_URI', 'JWT_SECRET', 'PYTHON_SERVICE_TOKEN', 'CORS_ORIGINS', 'R2_SECRET_ACCESS_KEY']:
                invalid_configuration = configuration + ['-e', missing + '=']
                result = docker('run', '--rm', '--network', 'none', *invalid_configuration, 'ispeak-node:local', required=False)
                assert result.returncode == 1 and missing in result.stdout + result.stderr
                assert not any(environment[name] in result.stdout + result.stderr for name in ['JWT_SECRET', 'PYTHON_SERVICE_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
                report['checks']['missing_' + missing] = 'PASS'
            logs = docker('logs', node).stdout + docker('logs', node).stderr
            assert not any(environment[name] in logs for name in ['JWT_SECRET', 'PYTHON_SERVICE_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
            report['checks']['secretsAbsentFromLogs'] = 'PASS'
            stop = time.monotonic()
            docker('stop', '-t', '15', node)
            report['shutdownSeconds'] = round(time.monotonic() - stop, 2)
            assert docker('inspect', '--format', '{{.State.ExitCode}}', node).stdout.strip() == '0'
            report['checks']['cleanShutdown'] = 'PASS'
            # Mongo entrypoint creates anonymous volumes; -v removes ONLY these disposable volumes.
        finally:
            for container in reversed(created):
                docker('rm', '-f', '-v', container, required=False)
            docker('network', 'rm', network, required=False)
except Exception as error:
    report['failureCategory'] = type(error).__name__
finally:
    report['localEnvUnchanged'] = original_env == (hashlib.sha256((repo / '.env').read_bytes()).hexdigest() if (repo / '.env').exists() else None)
    report['image'] = json.loads(docker('image', 'inspect', 'ispeak-node:local', '--format', '{{json .}}').stdout)
    # Select metadata only; never retain full image/container environment output.
    report['image'] = {key: report['image'][key] for key in ['Id', 'Size']}
    output = repo / 'node-docker-verification.local.log'
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))
if 'failureCategory' in report:
    raise SystemExit(1)
