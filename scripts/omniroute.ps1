# PowerShell 7. The gateway key stays in this process and the selected client.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Codex', 'Claude')]
    [string]$Client,
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Model
)

$ErrorActionPreference = 'Stop'
$gateway = 'http://127.0.0.1:20128'
$key = $env:OMNIROUTE_API_KEY
if ([string]::IsNullOrWhiteSpace($key)) {
    $key = Read-Host 'OmniRoute gateway API key' -MaskInput
}
if ([string]::IsNullOrWhiteSpace($key)) { throw 'An OmniRoute gateway API key is required.' }
try {
    Invoke-RestMethod -Uri "$gateway/v1/models" -Headers @{ Authorization = "Bearer $key" } -NoProxy -MaximumRedirection 0 -TimeoutSec 8 | Out-Null
} catch {
    throw "OmniRoute did not respond to the local model-list request. Check its server and gateway key at $gateway."
}

$environment = @{ OMNIROUTE_API_KEY = $key }
if ($Client -eq 'Claude') {
    $environment.ANTHROPIC_BASE_URL = $gateway
    $environment.ANTHROPIC_AUTH_TOKEN = $key
    $environment.ANTHROPIC_API_KEY = $null
}
$previous = @{}
foreach ($name in $environment.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
}

Push-Location -LiteralPath (Join-Path $PSScriptRoot '..')
try {
    if ($Client -eq 'Claude') {
        & claude --model $Model
    } else {
        & codex --model $Model `
            -c 'model_provider="wiremap_omniroute"' `
            -c 'model_providers.wiremap_omniroute.name="OmniRoute"' `
            -c 'model_providers.wiremap_omniroute.base_url="http://127.0.0.1:20128/v1"' `
            -c 'model_providers.wiremap_omniroute.env_key="OMNIROUTE_API_KEY"' `
            -c 'model_providers.wiremap_omniroute.wire_api="responses"'
    }
    $result = $LASTEXITCODE
} finally {
    Pop-Location
    foreach ($name in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
}
exit $result
