"""Local draft: no image solve/export/import, inference, registry login or deployment.

Runs only on a GitHub-hosted Linux job after separate activation approval.
The optional builder bootstrap can pull the pinned public BuildKit image, but
never builds an application or fixture image. Default is measurements only.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import tomllib
from pathlib import Path

from policy import failures, owns_builder, valid_builder, valid_effective_limits, effective_limit_diagnostics


def emit(kind, **fields):
    print(json.dumps({'probe': kind, **fields}), flush=True)


def filesystem(path):
    path = Path(path).resolve(strict=True)
    stats = os.statvfs(path)
    return {'path': str(path), 'device_id': os.stat(path).st_dev,
            'capacity_bytes': stats.f_blocks * stats.f_frsize,
            'available_bytes': stats.f_bavail * stats.f_frsize,
            'free_inodes': stats.f_favail, 'total_inodes': stats.f_files,
            'readonly': bool(stats.f_flag & os.ST_RDONLY)}


class Probe:
    def __init__(self):
        key = os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
        if not re.fullmatch(r'\d+-1', key):
            raise RuntimeError('First workflow attempt required')
        self.root = Path(os.environ['RUNNER_TEMP']).resolve() / ('ispeak-node-probe-' + key)
        if self.root.is_symlink():
            raise RuntimeError('Probe directory must not be a symbolic link')
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.name = 'buildx_buildkit_ispeak-probe-' + key + '0'
        self.builder = 'ispeak-probe-' + key
        self.marker = 'ISPEAK_NODE_PROBE_RUN=' + key
        self.deadline = time.monotonic() + 480  # below independent 10-minute job limit
        self.counter = 0
        self.roots = []
        self.mapping_confirmed = False
        self.info = {}
        self.monitor = False

    def command(self, args, seconds=15, check=True):
        self.counter += 1
        path = self.root / ('private-output-' + str(self.counter))
        env = {key: value for key, value in os.environ.items()
               if key not in ('GITHUB_TOKEN', 'GHCR_READ_TOKEN')}
        with path.open('wb') as output:
            child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True, env=env)
            end = min(self.deadline, time.monotonic() + seconds)
            try:
                while child.poll() is None:
                    if time.monotonic() > end:
                        raise RuntimeError('Probe command timeout; no retry')
                    if self.monitor:
                        sample = self.sample()
                        problems = failures(sample, start=False)
                        if problems:
                            emit('resource_stop', measurements=sample, failed_gates=problems)
                            raise RuntimeError('Continuous resource floor failed')
                    time.sleep(1)
                if check and child.returncode != 0:
                    raise RuntimeError('Probe command failed; raw output withheld')
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
        output = path.read_bytes()
        if len(output) > 1024 * 1024:
            raise RuntimeError('Unexpected metadata volume; withheld')
        return output if check else (child.returncode, output)

    def discover(self):
        if os.environ.get('DOCKER_HOST') not in (None, '', 'unix:///var/run/docker.sock'):
            raise RuntimeError('Unreviewed remote Docker endpoint')
        context = json.loads(self.command(['docker', 'context', 'inspect']))[0]
        if context['Endpoints']['docker']['Host'] != 'unix:///var/run/docker.sock':
            raise RuntimeError('Local standard-runner Docker endpoint required')
        self.info = json.loads(self.command(['docker', 'info', '--format', '{{json .}}']))
        if self.info['OSType'] != 'linux' or self.info['Architecture'] not in ('x86_64', 'amd64'):
            raise RuntimeError('Linux amd64 engine required')
        # The default/rootful standard-runner mapping is the supported initial case.
        # Do not silently substitute workspace free space for inaccessible daemon paths.
        daemon_root = Path(self.info['DockerRootDir'])
        self.roots = [daemon_root]
        self.mapping_confirmed = daemon_root.is_dir()
        docker_config = Path('/etc/docker/daemon.json')
        if docker_config.exists():
            config = json.loads(docker_config.read_text())
            if config.get('data-root') and Path(config['data-root']).resolve() != daemon_root.resolve():
                self.mapping_confirmed = False
            if config.get('containerd') not in (None, '/run/containerd/containerd.sock', '/var/run/containerd/containerd.sock'):
                self.mapping_confirmed = False
        containerd_root = Path('/var/lib/containerd')
        containerd_config = Path('/etc/containerd/config.toml')
        if containerd_config.exists():
            containerd_root = Path(tomllib.loads(containerd_config.read_text()).get('root', str(containerd_root)))
        uses_containerd = any('containerd' in str(row) for row in self.info.get('DriverStatus', []))
        if containerd_root.is_dir():
            self.roots.append(containerd_root)
        elif uses_containerd:
            self.mapping_confirmed = False
        # Custom process/daemon flags can select other config/store paths. Report
        # them as unconfirmed instead of certifying only conventional directories.
        try:
            for proc in Path('/proc').iterdir():
                if not proc.name.isdigit():
                    continue
                try:
                    comm = (proc / 'comm').read_text().strip()
                    if comm not in ('dockerd', 'containerd'):
                        continue
                    args = (proc / 'cmdline').read_bytes().split(b'\0')
                    expected = ({'--config-file': '/etc/docker/daemon.json',
                                 '--data-root': str(daemon_root),
                                 '--containerd': '/run/containerd/containerd.sock'} if comm == 'dockerd' else
                                {'--config': '/etc/containerd/config.toml', '-c': '/etc/containerd/config.toml',
                                 '--root': str(containerd_root)})
                    for index, raw in enumerate(args):
                        arg = raw.decode(errors='replace')
                        option, _, inline_value = arg.partition('=')
                        if option in expected:
                            value = inline_value if '=' in arg else args[index + 1].decode()
                            if Path(value).resolve() != Path(expected[option]).resolve():
                                self.mapping_confirmed = False
                except FileNotFoundError:
                    continue  # A process exited during enumeration, not a fallback.
        except PermissionError:
            self.mapping_confirmed = False
        emit('engine', version=self.info['ServerVersion'], architecture=self.info['Architecture'],
             cpus=self.info['NCPU'], memory_ceiling_bytes=self.info['MemTotal'],
             storage_driver=self.info['Driver'], storage_mapping_confirmed=self.mapping_confirmed,
             runner_image=os.environ.get('ImageOS'), runner_image_version=os.environ.get('ImageVersion'))

    def sample(self):
        values = dict(row.split(':', 1) for row in Path('/proc/meminfo').read_text().splitlines())
        stores = [filesystem(path) for path in self.roots]
        if any(row['readonly'] for row in stores):
            raise RuntimeError('Docker backing filesystem is read-only')
        return {'monotonic_seconds': time.monotonic(),
                'available_ram_bytes': int(values['MemAvailable'].split()[0]) * 1024,
                'total_ram_bytes': int(values['MemTotal'].split()[0]) * 1024,
                'docker_memory_bytes': self.info['MemTotal'],
                'docker_filesystems': stores, 'system_filesystem': filesystem('/'),
                'workspace_filesystem': filesystem(os.environ['GITHUB_WORKSPACE']),
                'temp_filesystem': filesystem(os.environ['RUNNER_TEMP']),
                'storage_mapping_confirmed': self.mapping_confirmed}

    def stable_gate(self, phase):
        for sample_number in range(13):
            if time.monotonic() >= self.deadline:
                raise RuntimeError('Probe deadline reached')
            sample = self.sample()
            problems = failures(sample, start=True)
            # Measurements precede failure reporting, unlike the earlier draft.
            emit(phase, sample_number=sample_number, measurements=sample, failed_gates=problems)
            if problems:
                raise RuntimeError('Node pre-start resource gate failed')
            if sample_number != 12:
                time.sleep(5)

    def bootstrap(self):
        image = os.environ.get('BUILDKIT_IMAGE', '')
        if not re.fullmatch(r'moby/buildkit@sha256:[a-f0-9]{64}', image):
            raise RuntimeError('Immutable reviewed builder image required')
        config = self.root / 'buildkitd.toml'
        config.write_text('[worker.oci]\n  enabled = true\n  max-parallelism = 1\n[worker.containerd]\n  enabled = false\n')
        # Refuse collisions rather than taking over any existing builder/container.
        status, _ = self.command(['docker', 'inspect', self.name], check=False)
        if status == 0:
            raise RuntimeError('Probe builder name collision')
        self.verify_owned_absence('before_create')
        self.monitor = True
        self.command(['docker', 'buildx', 'create', '--name', self.builder, '--driver', 'docker-container',
                      '--driver-opt', 'image=' + image, '--driver-opt', 'memory=4g',
                      '--driver-opt', 'memory-swap=4g', '--driver-opt', 'cpu-period=100000',
                      '--driver-opt', 'cpu-quota=200000', '--driver-opt', 'restart-policy=no',
                      '--driver-opt', 'env.' + self.marker, '--buildkitd-config', str(config)])
        (self.root / 'created-registration').write_text(self.builder)
        self.command(['docker', 'buildx', 'inspect', '--bootstrap', self.builder], seconds=120)
        data = json.loads(self.command(['docker', 'inspect', self.name]))[0]
        if not owns_builder(data, self.name, self.marker) or not valid_builder(data, self.marker):
            raise RuntimeError('Builder identity/cap verification failed')
        # Verify that the exact bytes handed to BuildKit are present in the live config.
        live = self.command(['docker', 'exec', data['Id'], 'cat', '/etc/buildkit/buildkitd.toml'])
        worker = tomllib.loads(live.decode()).get('worker', {})
        if (worker.get('oci', {}).get('max-parallelism') != 1
                or worker.get('oci', {}).get('enabled') is not True
                or worker.get('containerd', {}).get('enabled') is not False):
            raise RuntimeError('Live single-worker parallelism setting unverified')
        self.verify_effective_builder(data, image)
        emit('builder_caps', id=data['Id'], memory_bytes=data['HostConfig']['Memory'],
             memory_swap_bytes=data['HostConfig']['MemorySwap'], cpus=2, parallelism=1,
             restart_policy='no', solve_performed=False)
        self.stable_gate('after_builder')

    def verify_effective_builder(self, data, image):
        state = data['State']
        if (not state['Running'] or state.get('OOMKilled')
                or data.get('RestartCount') != 0 or state.get('Pid', 0) <= 0):
            raise RuntimeError('Builder is not continuously healthy')
        pinned = json.loads(self.command(['docker', 'image', 'inspect', image]))[0]
        if data['Image'] != pinned['Id'] or data['Config']['Image'] != image:
            raise RuntimeError('Running builder image identity mismatch')
        # Host PID binds the kernel accounting to this exact inspected container.
        pid_root = Path('/proc') / str(state['Pid'])
        membership = (pid_root / 'cgroup').read_text().splitlines()
        unified = len(membership) == 1 and membership[0].startswith('0::/')
        emit('cgroup_layout', cgroup_version=2 if unified else 'unsupported',
             docker_reported_version=self.info.get('CgroupVersion')
             if self.info.get('CgroupVersion') in ('1', '2') else 'unknown')
        if not unified:
            raise RuntimeError('Reviewed cgroup-v2 layout required; no fallback')
        relative = membership[0][3:].lstrip('/')
        cgroup = (Path('/sys/fs/cgroup') / relative).resolve(strict=True)
        if (not cgroup.is_relative_to(Path('/sys/fs/cgroup').resolve())
                or data['Id'] not in str(cgroup)):
            raise RuntimeError('Builder cgroup identity not established')
        limits = {}
        for filename in ('memory.max', 'memory.swap.max', 'cpu.max'):
            try:
                # Fixed-size read: only these three identity-bound kernel files.
                with (cgroup / filename).open() as source:
                    limits[filename] = source.read(128)
            except OSError:
                emit('cgroup_read_failure', field=filename, cgroup_version=2)
                raise RuntimeError('Effective cgroup metadata unreadable') from None
        memory, swap, cpu = (limits[key] for key in ('memory.max', 'memory.swap.max', 'cpu.max'))
        emit('effective_limit_diagnostics', **effective_limit_diagnostics(memory, swap, cpu))
        if not valid_effective_limits(memory, swap, cpu):
            raise RuntimeError('Effective kernel builder limits mismatch')
        # Confirm the daemon uses the file inspected above, with no alternate
        # worker/config overrides. Unknown flag spelling fails closed.
        args = (pid_root / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
        if not args or Path(args[0]).name != 'buildkitd':
            raise RuntimeError('Live BuildKit daemon command unverified')
        for index, arg in enumerate(args[1:], 1):
            if arg == '--config':
                if index + 1 >= len(args) or args[index + 1] != '/etc/buildkit/buildkitd.toml':
                    raise RuntimeError('Alternate BuildKit config selected')
            elif arg.startswith('--config='):
                if arg != '--config=/etc/buildkit/buildkitd.toml':
                    raise RuntimeError('Alternate BuildKit config selected')
            elif arg.startswith(('--oci-worker', '--containerd-worker', '-config')):
                raise RuntimeError('Unreviewed BuildKit worker/config override')
        for entry in data['Config'].get('Env', []):
            if entry.startswith('BUILDKITD_CONFIG=') and entry != 'BUILDKITD_CONFIG=/etc/buildkit/buildkitd.toml':
                raise RuntimeError('Alternate BuildKit config environment')
        again = json.loads(self.command(['docker', 'inspect', data['Id']]))[0]
        if (again['State']['Pid'] != state['Pid'] or not again['State']['Running']
                or again.get('RestartCount') != 0):
            raise RuntimeError('Builder changed during verification')
        emit('effective_builder_limits', memory_max_bytes=int(memory),
             memory_swap_max_bytes=int(swap), cpu_max=cpu.strip(),
             cgroup_version=2, pinned_image_verified=True,
             live_config_verified=True, candidate_validated=False)

    def verify_owned_absence(self, phase):
        # Successful scoped list calls distinguish absence from inspect/API errors.
        containers = self.command(['docker', 'container', 'ls', '--all', '--quiet',
                                   '--no-trunc', '--filter', 'name=^/' + self.name + '$'])
        volumes = self.command(['docker', 'volume', 'ls', '--quiet', '--filter',
                                'name=^' + self.name + '_state$'])
        emit('owned_resource_absence', phase=phase,
             container_absent=not bool(containers.strip()),
             state_volume_absent=not bool(volumes.strip()))
        if containers.strip() or volumes.strip():
            raise RuntimeError('Run-scoped container or state volume remains; no blanket removal')

    def cleanup(self):
        self.monitor = False
        # A failed workload deadline must not prevent its separate bounded cleanup.
        self.deadline = time.monotonic() + 45
        status, raw = self.command(['docker', 'inspect', self.name], check=False)
        if status == 0:
            data = json.loads(raw)[0]
            if not owns_builder(data, self.name, self.marker):
                raise RuntimeError('Cleanup refuses unowned builder')
            self.command(['docker', 'stop', '--time=3', data['Id']])
            stopped = json.loads(self.command(['docker', 'inspect', data['Id']]))[0]
            if stopped['State']['Running']:
                raise RuntimeError('Builder remains running after cleanup')
            mounted = [row.get('Name') for row in data.get('Mounts', []) if row.get('Type') == 'volume']
            if mounted != [self.name + '_state']:
                raise RuntimeError('Unexpected builder volume; refuse unreviewed removal')
            self.command(['docker', 'buildx', 'rm', self.builder])
        elif (self.root / 'created-registration').exists():
            if (self.root / 'created-registration').read_text() != self.builder:
                raise RuntimeError('Unrecognized probe registration marker')
            self.command(['docker', 'buildx', 'rm', self.builder])
        self.verify_owned_absence('after_cleanup')
        # No host daemon stop, image/cache prune or historical state changes.
        # buildx rm may remove only this newly created builder's own state volume.
        if self.root.resolve().parent == Path(os.environ['RUNNER_TEMP']).resolve() and self.root.name.startswith('ispeak-node-probe-') and not self.root.is_symlink():
            shutil.rmtree(self.root)


def main():
    if os.name != 'posix' or os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise SystemExit('SAFETY STOP: GitHub-hosted Linux runner required')
    if os.environ.get('GITHUB_REPOSITORY') != 'Apol-bit/ispeak_backend':
        raise SystemExit('Unexpected repository')
    if os.environ.get('GITHUB_REF') != 'refs/heads/ci/node-resource-probe-20261021':
        raise SystemExit('Unexpected probe branch')
    probe = Probe()
    def interrupt(_number, _frame):
        raise RuntimeError('Probe interrupted')
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    result = 0
    try:
        cleanup_only = sys.argv[1:] == ['cleanup']
        if sys.argv[1:] and not cleanup_only:
            raise RuntimeError('No other execution modes are supported')
        if not cleanup_only and os.environ.get('PROBE_EXECUTION_APPROVED') != 'true':
            raise RuntimeError('Probe execution not approved')
        if not cleanup_only:
            probe.discover()
            probe.stable_gate('before_builder')
            bootstrapped = os.environ.get('BUILDER_BOOTSTRAP_APPROVED') == 'true'
            if bootstrapped:
                probe.bootstrap()
            emit('result', resource_measurements_pass=True, bounded_idle_builder_checked=bootstrapped,
                 active_export_tested=False, active_import_tested=False,
                 candidate_validated=False, export_load_gate_satisfied=False,
                 python_storage_gate_changed=False, images_built=False)
    except Exception as error:
        emit('STOP', reason=str(error) if type(error) is RuntimeError else type(error).__name__,
             candidate_validated=False, export_load_gate_satisfied=False)
        result = 1
    finally:
        try:
            probe.cleanup()
        except Exception:
            emit('cleanup', verified=False, action='STOP; inspect run-owned resources; do not retry')
            result = 1
    return result


if __name__ == '__main__':
    sys.exit(main())
