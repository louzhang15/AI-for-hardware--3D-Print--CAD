param(
    [switch]$List,
    [ValidatePattern('^COM[1-9][0-9]{0,4}$')]
    [string]$Port,
    [ValidateRange(300, 4000000)]
    [int]$Baud = 115200,
    [ValidateRange(1, 30)]
    [int]$Seconds = 5
)

$ErrorActionPreference = 'Stop'
if ($List) {
    [IO.Ports.SerialPort]::GetPortNames() |
        Where-Object { $_ -match '^COM[1-9][0-9]{0,4}$' } |
        Sort-Object { [int]($_ -replace '^COM', '') } -Unique
    exit 0
}

if (-not $Port) { throw 'Specify a COM port or use -List.' }
$serial = [IO.Ports.SerialPort]::new($Port, $Baud, [IO.Ports.Parity]::None, 8, [IO.Ports.StopBits]::One)
try {
    $serial.Handshake = [IO.Ports.Handshake]::None
    $serial.DtrEnable = $false
    $serial.RtsEnable = $false
    $serial.ReadTimeout = 80
    $serial.Open()

    $output = [Console]::OpenStandardOutput()
    $buffer = [byte[]]::new(4096)
    $remaining = 256KB
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $Seconds -and $remaining -gt 0) {
        $count = [Math]::Min([Math]::Min($serial.BytesToRead, $buffer.Length), $remaining)
        if ($count -eq 0) {
            Start-Sleep -Milliseconds 20
            continue
        }
        try {
            $bytes = $serial.Read($buffer, 0, $count)
        } catch [TimeoutException] {
            continue
        }
        $output.Write($buffer, 0, $bytes)
        $remaining -= $bytes
    }
    $output.Flush()
    if ($remaining -eq 0) { [Console]::Error.WriteLine('Capture reached the 256 KiB limit.') }
} finally {
    $serial.Dispose()
}
