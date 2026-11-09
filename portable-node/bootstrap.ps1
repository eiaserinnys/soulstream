param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$SelfTest = $Rest -contains "--self-test"

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$PortableDir = $PSScriptRoot
$StateDir = Join-Path $PortableDir ".state"
$BootDir = Join-Path $StateDir "boot"
$LockFile = Join-Path $PortableDir "runtime-lock.json"
$env:PORTABLE_NODE_DIR = $PortableDir

function Fail([string]$Message) {
    Write-Error "[portable-node] 중단: $Message"
    exit 1
}

function Get-PlatformKey {
    if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "x86")) {
        Fail "지원하지 않는 아키텍처입니다: $env:PROCESSOR_ARCHITECTURE (지원: win-x64)"
    }
    if ([Environment]::Is64BitOperatingSystem -eq $false) {
        Fail "지원하지 않는 운영체제입니다: 32비트 Windows (지원: win-x64)"
    }
    return "win-x64"
}

function Get-Lock {
    return Get-Content -LiteralPath $LockFile -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-NodeLock($Lock, [string]$Platform) {
    $entry = $Lock.runtimes.node.platforms.$Platform
    if ($null -eq $entry) {
        Fail "runtime-lock.json에 이 플랫폼($Platform)용 Node 정보가 없습니다."
    }
    return [pscustomobject]@{
        Version    = $Lock.runtimes.node.version
        Url        = $entry.url
        Sha256     = $entry.sha256
        Archive    = $entry.archive
        Executable = $entry.executable
    }
}

function Get-RuntimeMarkerSha([string]$Directory) {
    $markerPath = Join-Path $Directory ".portable-runtime.json"
    if (-not (Test-Path -LiteralPath $markerPath)) { return $null }
    try {
        $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        return $marker.sha256
    }
    catch {
        return $null
    }
}

function Write-RuntimeMarker([string]$Directory, [string]$Version, [string]$Sha256) {
    $marker = [ordered]@{
        kind         = "node"
        version      = $Version
        sha256       = $Sha256
        installed_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $json = (ConvertTo-Json $marker) + "`n"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path $Directory ".portable-runtime.json"), $json, $utf8)
}

function Install-Node($NodeLock, [string]$Platform) {
    $installDir = Join-Path $StateDir "runtimes\node\$($NodeLock.Version)\$Platform"
    $nodeExe = Join-Path $installDir $NodeLock.Executable
    if ((Test-Path -LiteralPath $nodeExe) -and ((Get-RuntimeMarkerSha $installDir) -eq $NodeLock.Sha256)) {
        return $nodeExe
    }
    $downloadDir = Join-Path $StateDir "cache\downloads"
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    $archiveName = [System.IO.Path]::GetFileName([Uri]::UnescapeDataString($NodeLock.Url))
    $archivePath = Join-Path $downloadDir $archiveName
    $verified = $false
    if (Test-Path -LiteralPath $archivePath) {
        $existingHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLower()
        $verified = ($existingHash -eq $NodeLock.Sha256.ToLower())
    }
    if (-not $verified) {
        Write-Host "[portable-node] Node $($NodeLock.Version) 내려받는 중…"
        Invoke-WebRequest -UseBasicParsing -Uri $NodeLock.Url -OutFile "$archivePath.part"
        $hash = (Get-FileHash -LiteralPath "$archivePath.part" -Algorithm SHA256).Hash.ToLower()
        if ($hash -ne $NodeLock.Sha256.ToLower()) {
            Remove-Item -LiteralPath "$archivePath.part" -Force
            Fail "Node checksum이 맞지 않습니다."
        }
        Move-Item -LiteralPath "$archivePath.part" -Destination $archivePath -Force
    }
    $tempDir = Join-Path $StateDir "tmp\node-$($NodeLock.Version)-$PID"
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $tempDir -Force
    $children = @(Get-ChildItem -LiteralPath $tempDir -Force)
    $inner = $tempDir
    if ($children.Count -eq 1 -and $children[0].PSIsContainer) {
        $inner = $children[0].FullName
    }
    if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $installDir) | Out-Null
    Move-Item -LiteralPath $inner -Destination $installDir
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $nodeExe)) {
        Fail "Node 실행 파일을 찾지 못했습니다: $nodeExe"
    }
    Write-RuntimeMarker $installDir $NodeLock.Version $NodeLock.Sha256
    return $nodeExe
}

function Sync-Boot {
    if (Test-Path -LiteralPath $BootDir) { Remove-Item -LiteralPath $BootDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $BootDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $PortableDir "launcher.mjs") -Destination $BootDir
    Copy-Item -LiteralPath (Join-Path $PortableDir "defaults.json") -Destination $BootDir
    Copy-Item -LiteralPath (Join-Path $PortableDir "lib") -Destination $BootDir -Recurse
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$platform = Get-PlatformKey
# 종료 코드 75는 계획된 재진입이다. 반복 방지는 launcher의 reentry.json이 맡는다.
while ($true) {
    $lock = Get-Lock
    $nodeLock = Get-NodeLock $lock $platform
    Sync-Boot
    $nodeExe = Install-Node $nodeLock $platform
    if ($SelfTest) {
        & $nodeExe --version
        if ($LASTEXITCODE -ne 0) { Fail "Node 실행 확인에 실패했습니다." }
        $installDir = Join-Path $StateDir "runtimes\node\$($nodeLock.Version)\$platform"
        if ((Get-RuntimeMarkerSha $installDir) -ne $nodeLock.Sha256) {
            Fail "Node 설치 기록이 없거나 잠금 파일과 다릅니다."
        }
        Write-Host "[portable-node] Node 준비 확인 완료: $nodeExe"
        exit 0
    }
    $launcher = Join-Path $BootDir "launcher.mjs"
    if ($Rest.Count -gt 0) {
        & $nodeExe $launcher @Rest
    }
    else {
        & $nodeExe $launcher
    }
    $code = $LASTEXITCODE
    if ($code -eq 75) {
        continue
    }
    exit $code
}
