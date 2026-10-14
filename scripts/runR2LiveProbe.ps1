$ErrorActionPreference = 'Stop'
# Hidden interactive input: values never appear in commands, history, or output.
$names = @('R2_ACCOUNT_ID', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
$previous = @{}
try {
    foreach ($name in $names) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    foreach ($name in $names) {
        if ($previous[$name]) { continue }
        $secret = Read-Host "$name (hidden; endpoint may be blank when account ID supplied)" -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try {
            [Environment]::SetEnvironmentVariable($name, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer), 'Process')
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            $secret.Dispose()
        }
    }
    & node (Join-Path $PSScriptRoot 'r2LiveProbe.js')
} finally {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
}
