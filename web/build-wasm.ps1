[CmdletBinding()]
param(
    [string]$WasiSdk = $env:WASI_SDK,
    [switch]$CampaignPack,
    [switch]$SimulationTest
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
if ($CampaignPack -and $SimulationTest) { throw 'Choose either CampaignPack or SimulationTest.' }
$outputName = if ($CampaignPack) { 'campaign-pack.wasm' } elseif ($SimulationTest) { 'sim.wasm' } else { 'openbw.wasm' }
$outputFile = Join-Path $PSScriptRoot $outputName
$temporaryFile = "$outputFile.tmp"
$compilerArguments = @(
    '-std=c++14'
    '-O2'
    '-fno-exceptions'
    '-DOPENBW_NO_EXCEPTIONS'
    '-DOPENBW_ENABLE_UI'
    '-DOPENBW_NO_SDL_IMAGE'
    '-DOPENBW_NO_SDL_MIXER'
    '-I', $root
    '-I', (Join-Path $root 'ui')
    '-Wl,-z,stack-size=8388608'
    '-o', $temporaryFile
)
if ($CampaignPack) {
    $compilerArguments += Join-Path $PSScriptRoot 'campaign_pack.cpp'
} elseif ($SimulationTest) {
    $compilerArguments += Join-Path $PSScriptRoot 'wasm_sim_test.cpp'
} else {
    $compilerArguments += '-mexec-model=reactor'
    $compilerArguments += Join-Path $PSScriptRoot 'wasm_main.cpp'
    $compilerArguments += Join-Path $PSScriptRoot 'wasm_backend.cpp'
}

Write-Host "Compiling $outputName..."
& $compiler @compilerArguments
if ($LASTEXITCODE -ne 0) {
    throw "WebAssembly compilation failed with exit code $LASTEXITCODE."
}

Move-Item -LiteralPath $temporaryFile -Destination $outputFile -Force
Write-Host ("Built {0} ({1:N0} bytes)" -f $outputFile, (Get-Item -LiteralPath $outputFile).Length)