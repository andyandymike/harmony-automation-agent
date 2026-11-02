[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ToolRoot,
    [string]$NodePath = 'node',
    [string]$SdkRoot,
    [string]$BuildRoot,
    [switch]$SkipBuild,
    [string]$SigningUdidFile,
    [string]$EmulatorTarget,
    [string]$JavaPath = 'java'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$fixtureRoot = Join-Path $projectRoot 'fixture-app'
$resolvedToolRoot = (Resolve-Path -LiteralPath $ToolRoot).Path
if (-not $SdkRoot) { $SdkRoot = Join-Path $resolvedToolRoot 'sdk' }
$resolvedSdkRoot = (Resolve-Path -LiteralPath $SdkRoot).Path
$hvigorWrapper = Join-Path $resolvedToolRoot 'hvigor\bin\hvigorw.js'
if (-not (Test-Path -LiteralPath $hvigorWrapper -PathType Leaf)) {
    throw 'Expected hvigor/bin/hvigorw.js beneath ToolRoot.'
}

# Hvigor rejects Unicode project paths. Use a fresh ASCII workspace, retaining
# it for diagnostics; never delete or reuse someone else's build directory.
if (-not $BuildRoot) {
    $BuildRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'
}
$resolvedBuildRoot = (Resolve-Path -LiteralPath $BuildRoot).Path
if ($resolvedBuildRoot -match '[^\x00-\x7F]') {
    throw 'Hvigor requires an ASCII build path. Pass -BuildRoot with an existing ASCII directory.'
}
if ($SigningUdidFile) {
    $projectPrefix = [IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\'
    $buildPrefix = [IO.Path]::GetFullPath($resolvedBuildRoot).TrimEnd('\') + '\'
    if ($buildPrefix.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Signing workspaces must be outside the project.'
    }
}
$buildWorkspace = Join-Path $resolvedBuildRoot ('harmony-agent-fixture-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $buildWorkspace
$outputDirectory = Join-Path $fixtureRoot 'build\outputs'
$null = New-Item -ItemType Directory -Path $outputDirectory -Force
$outputHap = Join-Path $outputDirectory 'harmony-agent-fixture-v2-unsigned.hap'
if (-not $SkipBuild) {
$sourceFiles = Get-ChildItem -LiteralPath $fixtureRoot -Recurse -File | Where-Object {
    $_.FullName -notmatch '[\\/](build|oh_modules|node_modules|\.hvigor|\.preview)[\\/]'
}
foreach ($sourceFile in $sourceFiles) {
    $relativePath = $sourceFile.FullName.Substring($fixtureRoot.Length + 1)
    $destinationPath = Join-Path $buildWorkspace $relativePath
    $destinationDirectory = Split-Path -Parent $destinationPath
    $null = New-Item -ItemType Directory -Path $destinationDirectory -Force
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $destinationPath
}
Write-Output ('Fixture build workspace: ' + $buildWorkspace)

$previousSdkRoot = $env:OHOS_BASE_SDK_HOME
$previousDevEcoSdkRoot = $env:DEVECO_SDK_HOME
try {
    $env:OHOS_BASE_SDK_HOME = $resolvedSdkRoot
    $env:DEVECO_SDK_HOME = $resolvedSdkRoot
    Push-Location -LiteralPath $buildWorkspace
    try {
        & $NodePath $hvigorWrapper assembleHap --mode module -p product=default -p module=entry@default -p buildMode=debug --no-daemon
        if ($LASTEXITCODE -ne 0) { throw "Fixture build failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
} finally {
    $env:OHOS_BASE_SDK_HOME = $previousSdkRoot
    $env:DEVECO_SDK_HOME = $previousDevEcoSdkRoot
}

$unsignedHap = Join-Path $buildWorkspace 'entry\build\default\outputs\default\entry-default-unsigned.hap'
if (-not (Test-Path -LiteralPath $unsignedHap -PathType Leaf)) {
    throw 'Hvigor completed without the expected unsigned HAP.'
}
Copy-Item -LiteralPath $unsignedHap -Destination $outputHap -Force
} elseif (-not (Test-Path -LiteralPath $outputHap -PathType Leaf)) {
    throw 'SkipBuild requires the previously built unsigned fixture HAP.'
}
Write-Output $outputHap

if ($SigningUdidFile) {
    if ($EmulatorTarget -notmatch '^127\.0\.0\.1:(\d+)$' -or
        [int]$Matches[1] -lt 5555 -or [int]$Matches[1] -gt 15555) {
        throw 'Public test signing requires an explicit local emulator target on ports 5555-15555.'
    }
    $udidPath = (Resolve-Path -LiteralPath $SigningUdidFile).Path
    $fullProjectPath = [IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\'
    if ([IO.Path]::GetFullPath($udidPath).StartsWith($fullProjectPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Signing UDID must be stored outside the project.'
    }
    if ((Get-Item -LiteralPath $udidPath).Length -gt 256) { throw 'Invalid signing UDID file.' }
    $signingUdid = [IO.File]::ReadAllText($udidPath).Trim()
    if ($signingUdid -notmatch '^[0-9A-Fa-f]{64}$') { throw 'Invalid signing UDID file.' }

    $signingLib = Join-Path $resolvedSdkRoot 'default\openharmony\toolchains\lib'
    $signingTool = Join-Path $signingLib 'hap-sign-tool.jar'
    $testKey = Join-Path $signingLib 'OpenHarmony.p12'
    $profileCert = Join-Path $signingLib 'OpenHarmonyProfileDebug.pem'
    $profileTemplate = Join-Path $signingLib 'UnsgnedDebugProfileTemplate.json'
    foreach ($requiredFile in @($signingTool, $testKey, $profileCert, $profileTemplate)) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw 'SDK public emulator signing material is missing.'
        }
    }
    $utf8 = [Text.UTF8Encoding]::new($false)
    $profile = [IO.File]::ReadAllText($profileTemplate) | ConvertFrom-Json
    $profile.uuid = [Guid]::NewGuid().ToString()
    $profile.validity.'not-before' = [DateTimeOffset]::UtcNow.AddMinutes(-5).ToUnixTimeSeconds()
    $profile.validity.'not-after' = [DateTimeOffset]::UtcNow.AddDays(365).ToUnixTimeSeconds()
    $profile.'bundle-info'.'bundle-name' = 'com.andyandymike.harmonyautomation.fixture'
    $profile.'debug-info'.'device-ids' = @($signingUdid.ToLowerInvariant())
    $unsignedProfile = Join-Path $buildWorkspace 'emulator-profile.json'
    [IO.File]::WriteAllText($unsignedProfile, ($profile | ConvertTo-Json -Depth 40), $utf8)
    $certificates = [regex]::Matches([IO.File]::ReadAllText($profileCert), '(?s)-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----')
    if ($certificates.Count -lt 2) { throw 'Invalid SDK public certificate chain.' }
    $appChain = Join-Path $buildWorkspace 'emulator-app-chain.pem'
    $chainText = $certificates[0].Value.Trim() + "`n" + $certificates[1].Value.Trim() + "`n" + $profile.'bundle-info'.'development-certificate'.Trim() + "`n"
    [IO.File]::WriteAllText($appChain, $chainText, $utf8)
    $signedProfile = Join-Path $buildWorkspace 'emulator-profile.p7b'
    $signedHap = Join-Path $outputDirectory 'harmony-agent-fixture-v2-signed.hap'

    function Invoke-PublicTestSigner {
        param([string]$Step, [string[]]$SignerArguments)
        # The password below is the SDK's published test-key password, never a
        # private project credential. Keep tool output in the private workspace.
        $signerOutput = & $JavaPath '-jar' $signingTool @SignerArguments 2>&1
        $signerExitCode = $LASTEXITCODE
        [IO.File]::WriteAllText((Join-Path $buildWorkspace ($Step + '.log')), ($signerOutput -join "`n"), $utf8)
        if ($signerExitCode -ne 0) { throw "SDK public test signing failed at $Step (exit $signerExitCode)." }
    }
    Invoke-PublicTestSigner -Step 'sign-profile' -SignerArguments @(
        'sign-profile','-mode','localSign','-keyAlias','openharmony application profile debug',
        '-keyPwd','123456','-profileCertFile',$profileCert,'-inFile',$unsignedProfile,
        '-signAlg','SHA256withECDSA','-keystoreFile',$testKey,'-keystorePwd','123456','-outFile',$signedProfile)
    Invoke-PublicTestSigner -Step 'verify-profile' -SignerArguments @(
        'verify-profile','-inFile',$signedProfile,'-outFile',(Join-Path $buildWorkspace 'profile-verification.json'))
    Invoke-PublicTestSigner -Step 'sign-app' -SignerArguments @(
        'sign-app','-mode','localSign','-keyAlias','openharmony application release','-keyPwd','123456',
        '-appCertFile',$appChain,'-profileFile',$signedProfile,'-profileSigned','1','-inFile',$outputHap,
        '-signAlg','SHA256withECDSA','-keystoreFile',$testKey,'-keystorePwd','123456',
        '-outFile',$signedHap,'-compatibleVersion','24','-signCode','1')
    Invoke-PublicTestSigner -Step 'verify-app' -SignerArguments @(
        'verify-app','-inFile',$signedHap,'-outCertChain',(Join-Path $buildWorkspace 'verified-chain.cer'),
        '-outProfile',(Join-Path $buildWorkspace 'verified-profile.p7b'))
    if (-not (Test-Path -LiteralPath $signedHap -PathType Leaf)) { throw 'Signed HAP missing.' }
    $hapHash = (Get-FileHash -LiteralPath $signedHap -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(($signedHap + '.sha256'), ($hapHash + '  ' + [IO.Path]::GetFileName($signedHap) + "`n"), $utf8)
    Write-Output 'SDK public test signature verified for the explicitly selected local emulator.'
    Write-Output $signedHap
}
