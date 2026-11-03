[CmdletBinding()]
param(
    [string]$WasiSdk = $env:WASI_SDK
)

$ErrorActionPreference = 'Stop'

if (-not $WasiSdk) {
    $WasiSdk = Join-Path $env:LOCALAPPDATA 'OpenBW\tools\wasi-sdk-33.0-x86_64-windows'
}

$compiler = Join-Path $WasiSdk 'bin\clang++.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw "WASI SDK compiler not found at '$compiler'. Extract WASI SDK 33 there or set WASI_SDK to its directory."
}

$root = Split-Path -Parent $PSScriptRoot
$outputFile = Join-Path $PSScriptRoot 'openbw.wasm'
$temporaryFile = "$outputFile.tmp"
$compilerArguments = @(
    '-std=c++14'
    '-O2'
    '-fno-exceptions'
    '-mexec-model=reactor'
    '-DOPENBW_NO_EXCEPTIONS'
    '-DOPENBW_ENABLE_UI'
    '-DOPENBW_NO_SDL_IMAGE'
    '-DOPENBW_NO_SDL_MIXER'
    '-I', $root
    '-I', (Join-Path $root 'ui')
    '-Wl,-z,stack-size=8388608'
    (Join-Path $PSScriptRoot 'wasm_main.cpp')
    (Join-Path $PSScriptRoot 'wasm_backend.cpp')
    '-o', $temporaryFile
)

Write-Host 'Compiling browser WebAssembly module...'
& $compiler @compilerArguments
if ($LASTEXITCODE -ne 0) {
    throw "WebAssembly compilation failed with exit code $LASTEXITCODE."
}

Move-Item -LiteralPath $temporaryFile -Destination $outputFile -Force
Write-Host ("Built {0} ({1:N0} bytes)" -f $outputFile, (Get-Item -LiteralPath $outputFile).Length)