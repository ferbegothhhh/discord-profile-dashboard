Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-Base64Url([byte[]] $Bytes) {
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RestrictedToken([string] $Secret, [long] $IssuedAt) {
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $header = ConvertTo-Base64Url $utf8.GetBytes('{"alg":"HS256","typ":"JWT"}')
    $payload = ConvertTo-Base64Url $utf8.GetBytes(('{"role":"profile_dashboard","iat":' + $IssuedAt.ToString([Globalization.CultureInfo]::InvariantCulture) + ',"exp":' + ($IssuedAt + 31536000).ToString([Globalization.CultureInfo]::InvariantCulture) + '}'))
    $keyBytes = $utf8.GetBytes($Secret)
    $hmac = [Security.Cryptography.HMACSHA256]::new()
    try {
        $hmac.Key = $keyBytes
        $message = $header + '.' + $payload
        return $message + '.' + (ConvertTo-Base64Url $hmac.ComputeHash($utf8.GetBytes($message)))
    } finally {
        $hmac.Dispose()
        [Array]::Clear($keyBytes, 0, $keyBytes.Length)
    }
}

function Read-HiddenValue([string] $Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
        $secure.Dispose()
    }
}

function Get-SupabaseOrigin([string] $Content) {
    $matches = [regex]::Matches($Content, '(?m)^[ \t]*(?:export[ \t]+)?SUPABASE_URL[ \t]*=[ \t]*([^\r\n]*)')
    if ($matches.Count -ne 1) { throw 'Expected exactly one SUPABASE_URL assignment.' }
    $value = $matches[0].Groups[1].Value.Trim()
    if ($value.StartsWith('"') -or $value.StartsWith("'")) {
        $quote = $value.Substring(0, 1)
        $end = $value.IndexOf($quote, 1)
        if ($end -lt 1 -or $value.Substring($end + 1) -notmatch '^\s*(?:#.*)?$') { throw 'Invalid URL assignment.' }
        $value = $value.Substring(1, $end - 1)
    } else {
        $value = ($value -split '\s+#', 2)[0].Trim()
    }
    $uri = $null
    if ($value -match '[\s\\?#]' -or -not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref] $uri)) { throw 'Invalid URL.' }
    if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw 'Expected an HTTPS origin.' }
    if ($value -notmatch '^https://[^/]+/?$') { throw 'Expected an HTTPS origin.' }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Update-EnvironmentContent([string] $Content, [System.Collections.IDictionary] $Values) {
    $newlineMatch = [regex]::Match($Content, '\r\n|\n|\r')
    $newline = if ($newlineMatch.Success) { $newlineMatch.Value } else { "`r`n" }
    $result = $Content
    foreach ($name in $Values.Keys) {
        $pattern = '(?m)^[ \t]*(?:export[ \t]+)?' + [regex]::Escape($name) + '[ \t]*=[^\r\n]*'
        $replacement = $name + '=' + $Values[$name]
        if ([regex]::IsMatch($result, $pattern)) {
            $result = [regex]::Replace($result, $pattern, [Text.RegularExpressions.MatchEvaluator] { param($match) $replacement })
        } else {
            if ($result.Length -gt 0 -and -not $result.EndsWith("`n") -and -not $result.EndsWith("`r")) { $result += $newline }
            $result += $replacement + $newline
        }
    }
    return $result
}

function Assert-PrivateEnvironment([string] $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked environment files are not supported.' }
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    $acl = Get-Acl -LiteralPath $Path
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $allowed) {
            throw 'Environment file permissions are not private.'
        }
    }
}

function Test-RestrictedAccess([string] $Origin, [string] $PublishableKey, [string] $Token) {
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(10)
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Origin + '/rest/v1/profile_preferences?select=background_id&limit=0')
    $response = $null
    try {
        $request.Headers.Add('apikey', $PublishableKey)
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Token)
        $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if ([int] $response.StatusCode -ne 200) { throw 'Read-only access probe failed.' }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $request.Dispose()
        $client.Dispose()
    }
}

function Save-EnvironmentAtomically([string] $Path, [byte[]] $OriginalBytes, [string] $Content) {
    $tempPath = $null
    $stage = 'validate'
    try {
        Assert-PrivateEnvironment $Path
        $security = [Security.AccessControl.FileSecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
            $security.AddAccessRule($rule)
        }
        $stage = 'create-temp'
        $tempPath = Join-Path (Split-Path -Parent $Path) ([IO.Path]::GetRandomFileName() + '.tmp')
        $stream = [IO.FileStream]::new($tempPath, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $security)
        try {
            $stage = 'write-temp'
            $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Content)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        $stage = 'check-unchanged'
        Assert-PrivateEnvironment $Path
        $currentBytes = [IO.File]::ReadAllBytes($Path)
        if ([Convert]::ToBase64String($currentBytes) -cne [Convert]::ToBase64String($OriginalBytes)) { throw [InvalidOperationException]::new('ENV_CHANGED') }
        $stage = 'replace'
        [IO.File]::Replace($tempPath, $Path, [System.Management.Automation.Language.NullString]::Value)
        $tempPath = $null
    } catch {
        $failure = [InvalidOperationException]::new('ENV_SAVE_FAILED')
        $failure.Data['SaveStage'] = $stage
        $failure.Data['FailureType'] = $_.Exception.GetBaseException().GetType().Name
        throw $failure
    } finally {
        if ($null -ne $tempPath -and [IO.File]::Exists($tempPath)) {
            try {
                [IO.File]::Delete($tempPath)
            } catch {
                $failure = [InvalidOperationException]::new('ENV_SAVE_FAILED')
                $failure.Data['SaveStage'] = 'cleanup-temp'
                $failure.Data['FailureType'] = $_.Exception.GetBaseException().GetType().Name
                throw $failure
            }
        }
    }
}

function Invoke-RestrictedDatabaseSetup {
    $secret = $null
    $publishableKey = $null
    $token = $null
    try {
        if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected -or $Host.Name -ne 'ConsoleHost' -or [Environment]::CommandLine -match '(?i)-(?:NonInteractive|noni)(?:\s|$)') {
            throw 'An interactive Windows PowerShell console is required.'
        }
        $path = Join-Path (Split-Path -Parent $PSScriptRoot) '.env.local'
        Assert-PrivateEnvironment $path
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $originalBytes = [IO.File]::ReadAllBytes($path)
        $content = $utf8.GetString($originalBytes).TrimStart([char] 0xFEFF)
        $origin = Get-SupabaseOrigin $content
        Write-Host 'This checks read access only. It does not verify writes or the shared limiter RPC, and does not apply migrations.'
        Write-Host 'Only enter a legacy HS256 signing secret for the configured project. Previous-key acceptance will be checked by the GET.'
        $secret = Read-HiddenValue 'Legacy JWT signing secret (hidden)'
        if ([string]::IsNullOrWhiteSpace($secret) -or $secret -match '[\r\n]') { throw 'Invalid secret input.' }
        $publishableKey = Read-HiddenValue 'Supabase publishable key (hidden)'
        if ($publishableKey -cnotmatch '^sb_publishable_[A-Za-z0-9_-]{6,8177}$') { throw 'Invalid publishable key input.' }
        $issuedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $token = New-RestrictedToken $secret $issuedAt
        $secret = $null
        Test-RestrictedAccess $origin $publishableKey $token
        $expiry = [DateTimeOffset]::FromUnixTimeSeconds($issuedAt + 31536000).UtcDateTime.ToString('yyyy-MM-dd HH:mm:ss')
        Write-Host "Read-only probe succeeded. Token expires $expiry UTC; rerun this tool before then to renew. Key rotation can invalidate it earlier."
        Write-Host 'Update .env.local: PROFILE_DATABASE_MODE=restricted, PROFILE_RATE_LIMIT_BACKEND=database, SUPABASE_PUBLISHABLE_KEY and PROFILE_DATABASE_KEY.'
        if ((Read-Host 'Type UPDATE to save these settings (anything else cancels)') -cne 'UPDATE') {
            Write-Host 'Cancelled. No environment changes.'
            return
        }
        $updated = Update-EnvironmentContent $content ([ordered]@{
            PROFILE_DATABASE_MODE = 'restricted'
            PROFILE_RATE_LIMIT_BACKEND = 'database'
            SUPABASE_PUBLISHABLE_KEY = $publishableKey
            PROFILE_DATABASE_KEY = $token
        })
        Save-EnvironmentAtomically $path $originalBytes $updated
        Write-Host 'Saved atomically without a backup. Existing private file permissions retained. Restart the dashboard to load the settings.'
    } catch {
        if ($_.Exception.Data.Contains('SaveStage')) {
            Write-Host ('ENV_SAVE_FAILED stage={0} type={1}' -f $_.Exception.Data['SaveStage'], $_.Exception.Data['FailureType'])
        }
        Write-Host 'Setup failed. No settings were saved. Check interactive console, private file permissions, HTTPS URL, keys, migrations and connectivity. Error details are suppressed to protect credentials.'
        exit 1
    } finally {
        $secret = $null
        $publishableKey = $null
        $token = $null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-RestrictedDatabaseSetup
}
