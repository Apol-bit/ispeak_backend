"""Probe-only policy. Does not import or modify either approved candidate policy."""
GIB = 1024 ** 3
NODE_START_RAM = 5 * GIB
NODE_START_DOCKER_FREE = 20 * GIB
CONTINUOUS_RAM = 5 * GIB
CONTINUOUS_DOCKER_FREE = 15 * GIB
SYSTEM_FREE = 15 * GIB
STABLE_SECONDS = 60
BUILDER_RAM = 4 * GIB
BUILDER_MEMORY_SWAP = 4 * GIB
BUILDER_CPU_PERIOD = 100000
BUILDER_CPU_QUOTA = 200000
# A guard against accidentally generalizing this Node-only approval.
PYTHON_DOCKER_FREE_UNCHANGED = 50 * GIB


def failures(sample, *, start):
    errors = []
    if sample['available_ram_bytes'] < NODE_START_RAM or sample['docker_memory_bytes'] < NODE_START_RAM:
        errors.append('RAM')
    floor = NODE_START_DOCKER_FREE if start else CONTINUOUS_DOCKER_FREE
    if not sample['storage_mapping_confirmed']:
        errors.append('UNCONFIRMED_STORAGE_MAPPING')
    if not sample['docker_filesystems'] or any(row['available_bytes'] < floor for row in sample['docker_filesystems']):
        errors.append('DOCKER_DISK')
    if sample['system_filesystem']['available_bytes'] < SYSTEM_FREE:
        errors.append('SYSTEM_DISK')
    if any(row['free_inodes'] <= 0 for row in sample['docker_filesystems'] + [sample['system_filesystem']]):
        errors.append('INODES')
    return errors


def valid_builder(data, marker):
    config = data['HostConfig']
    return (config['Memory'] == BUILDER_RAM and config['MemorySwap'] == BUILDER_MEMORY_SWAP
            and config['CpuPeriod'] == BUILDER_CPU_PERIOD and config['CpuQuota'] == BUILDER_CPU_QUOTA
            and config['RestartPolicy']['Name'] == 'no'
            and marker in data['Config'].get('Env', []))


def owns_builder(data, name, marker):
    return data.get('Name') == '/' + name and marker in data.get('Config', {}).get('Env', [])


def valid_effective_limits(memory_max, swap_max, cpu_max):
    """Actual cgroup-v2 limits, not merely requested Docker settings."""
    return (memory_max.strip() == str(BUILDER_RAM)
            and swap_max.strip() == '0'
            and cpu_max.split() == [str(BUILDER_CPU_QUOTA), str(BUILDER_CPU_PERIOD)])


def effective_limit_diagnostics(memory_max, swap_max, cpu_max):
    """Allowlisted numeric/max metadata only; never echo unexpected file text."""
    def scalar(text):
        value = text.strip()
        if value == 'max':
            return 'max'
        if value.isascii() and value.isdecimal() and len(value) <= 20:
            return int(value)
        return 'malformed'

    memory, swap = scalar(memory_max), scalar(swap_max)
    fields = cpu_max.split()
    quota, period = (map(scalar, fields) if len(fields) == 2 else ('malformed', 'malformed'))
    checks = {
        'memory_exact': memory_max.strip() == str(BUILDER_RAM),
        'swap_disabled': swap_max.strip() == '0',
        'cpu_exact_pair': fields == [str(BUILDER_CPU_QUOTA), str(BUILDER_CPU_PERIOD)],
    }
    equivalent_cpu = (type(quota) is int and type(period) is int and period > 0
                      and quota * BUILDER_CPU_PERIOD == BUILDER_CPU_QUOTA * period)
    return {'cgroup_version': 2,
            'actual': {'memory_max_bytes': memory, 'swap_max_bytes': swap,
                       'cpu_quota_us': quota, 'cpu_period_us': period},
            'expected': {'memory_max_bytes': BUILDER_RAM, 'swap_max_bytes': 0,
                         'cpu_quota_us': BUILDER_CPU_QUOTA, 'cpu_period_us': BUILDER_CPU_PERIOD},
            'checks': checks, 'cpu_ratio_equivalent': equivalent_cpu,
            'failed_fields': [key for key, passed in checks.items() if not passed],
            'strict_gate_pass': valid_effective_limits(memory_max, swap_max, cpu_max)}
