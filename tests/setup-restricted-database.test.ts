import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/setup-restricted-database.ps1", import.meta.url));
const windows = process.platform === "win32";

function runPowerShell(command: string) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `. '${script.replaceAll("'", "''")}'; ${command}`], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("provisioning signs a real HS256 JWT with raw UTF-8 secret bytes", { skip: !windows }, () => {
  const secret = "synthetic-test-only-\u00e9-\u6f22";
  const encoded = Buffer.from(secret).toString("base64");
  const token = runPowerShell(`New-RestrictedToken ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))) 1800000000`);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), { role: "profile_dashboard", iat: 1800000000, exp: 1831536000 });
  assert.equal(signature, createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url"));
});

test("environment updates preserve unrelated lines, CRLF and duplicate assignments", { skip: !windows }, () => {
  const content = "# unchanged\r\nSUPABASE_URL=https://example.invalid\r\nOTHER='keep me'\r\nPROFILE_DATABASE_MODE=legacy\r\nexport PROFILE_DATABASE_MODE=legacy";
  const encoded = Buffer.from(content).toString("base64");
  const output = runPowerShell(`$content = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $updated = Update-EnvironmentContent $content ([ordered]@{ PROFILE_DATABASE_MODE = 'restricted'; PROFILE_RATE_LIMIT_BACKEND = 'database' }); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($updated))`);
  assert.equal(Buffer.from(output, "base64").toString(), "# unchanged\r\nSUPABASE_URL=https://example.invalid\r\nOTHER='keep me'\r\nPROFILE_DATABASE_MODE=restricted\r\nPROFILE_DATABASE_MODE=restricted\r\nPROFILE_RATE_LIMIT_BACKEND=database\r\n");
});

test("origin validation rejects credentials, non-HTTPS URLs, paths and duplicate URLs", { skip: !windows }, () => {
  const invalid = ["http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/path", "https://example.invalid?x=1", "https://example.invalid/#fragment", "https://example.invalid/../", "https://example.invalid\\path"];
  const fixtures = invalid.map((url) => `SUPABASE_URL=${url}`).concat("SUPABASE_URL=https://example.invalid\nSUPABASE_URL=https://other.invalid");
  for (const content of fixtures) {
    const encoded = Buffer.from(content).toString("base64");
    assert.equal(runPowerShell(`try { $null = Get-SupabaseOrigin ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); 'accepted' } catch { 'rejected' }`), "rejected");
  }
  assert.equal(runPowerShell(`Get-SupabaseOrigin 'SUPABASE_URL="https://example.invalid/" # local'`), "https://example.invalid");
});

function runSaveFixture(body: string) {
  return runPowerShell(`
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Windows PowerShell 5.1 required' }
    $parent = 'C:\\Users\\LENOVO\\AppData\\Local\\Temp\\opencode'
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Missing approved fixture parent' }
    $root = Join-Path $parent ([IO.Path]::GetRandomFileName())
    $null = New-Item -ItemType Directory -Path $root
    try {
      $path = Join-Path $root 'synthetic.txt'
      $utf8 = [Text.UTF8Encoding]::new($false, $true)
      $security = [Security.AccessControl.FileSecurity]::new()
      $security.SetAccessRuleProtection($true, $false)
      $security.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
      $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow'))
      [IO.File]::WriteAllText($path, 'SYNTHETIC=old', $utf8)
      Set-Acl -LiteralPath $path -AclObject $security
      Assert-PrivateEnvironment $path
      $original = [IO.File]::ReadAllBytes($path)
      $originalAcl = (Get-Acl -LiteralPath $path).Sddl
      ${body}
      if ((Get-Acl -LiteralPath $path).Sddl -cne $originalAcl) { throw 'ACL changed' }
      if (@(Get-ChildItem -LiteralPath $root -Force).Count -ne 1) { throw 'Backup or temporary file remains' }
      'PASS'
    } finally {
      Remove-Item -LiteralPath $root -Recurse -Force
    }
  `);
}

for (const newline of ["\r\n", "\n"]) {
  test(`PowerShell 5.1 atomic save preserves private ACL and ${JSON.stringify(newline)} without backups`, { skip: !windows }, () => {
    const content = `# synthetic only${newline}SYNTHETIC=old${newline}OTHER=keep${newline}`;
    const expected = content.replace("SYNTHETIC=old", "SYNTHETIC=new");
    assert.equal(runSaveFixture(`
      $content = $utf8.GetString([Convert]::FromBase64String('${Buffer.from(content).toString("base64")}'))
      [IO.File]::WriteAllText($path, $content, $utf8)
      $original = [IO.File]::ReadAllBytes($path)
      $updated = Update-EnvironmentContent $content ([ordered]@{ SYNTHETIC = 'new' })
      Save-EnvironmentAtomically $path $original $updated
      Assert-PrivateEnvironment $path
      if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne '${Buffer.from(expected).toString("base64")}') { throw 'Bytes or newlines changed' }
    `), "PASS");
  });
}

for (const scenario of ["changed", "locked", "encoding"] as const) {
  test(`PowerShell 5.1 atomic save fails safely for ${scenario} fixtures`, { skip: !windows }, () => {
    const setup = {
      changed: `[IO.File]::WriteAllText($path, 'SYNTHETIC=concurrent', $utf8)`,
      locked: `$lock = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)`,
      encoding: `$updated = [string][char]0xD800`,
    }[scenario];
    const stage = { changed: "check-unchanged", locked: "replace", encoding: "write-temp" }[scenario];
    assert.equal(runSaveFixture(`
      $updated = 'SYNTHETIC=new'
      $lock = $null
      ${setup}
      $before = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
      try {
        $caught = $false
        try { Save-EnvironmentAtomically $path $original $updated } catch {
          $caught = $true
          if ($_.Exception.Message -cne 'ENV_SAVE_FAILED') { throw 'Unsafe diagnostic' }
          if ($_.Exception.Data['SaveStage'] -cne '${stage}') { throw 'Unexpected failure stage' }
          if ($_.Exception.Data['FailureType'] -notmatch '^[A-Za-z]+Exception$') { throw 'Unsafe exception type' }
          if ($null -ne $_.Exception.InnerException) { throw 'Unsanitized inner exception' }
        }
        if (-not $caught) { throw 'Expected save failure' }
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne $before) { throw 'Original changed on failure' }
      } finally {
        if ($null -ne $lock) { $lock.Dispose() }
      }
    `), "PASS");
  });
}

test("PowerShell 5.1 null-string regression reproduces the old File.Replace failure", { skip: !windows }, () => {
  assert.equal(runSaveFixture(`
    $source = Join-Path $root 'replacement.tmp'
    [IO.File]::WriteAllText($source, 'SYNTHETIC=new', $utf8)
    try {
      $caught = $false
      try { [IO.File]::Replace($source, $path, $null) } catch {
        $caught = $true
        if ($_.Exception.GetBaseException().GetType().FullName -cne 'System.ArgumentException') { throw 'Unexpected original failure' }
      }
      if (-not $caught) { throw 'Original bug not reproduced' }
      if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne [Convert]::ToBase64String($original)) { throw 'Original changed' }
    } finally {
      if ([IO.File]::Exists($source)) { [IO.File]::Delete($source) }
    }
    Save-EnvironmentAtomically $path $original 'SYNTHETIC=new'
    if ([IO.File]::ReadAllText($path) -cne 'SYNTHETIC=new') { throw 'Fixed save failed' }
  `), "PASS");
});

test("noninteractive provisioning exits before prompts, environment reads or network access", { skip: !windows }, () => {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `. '${script.replaceAll("'", "''")}'; function Read-HiddenValue { throw 'Unexpected prompt' }; function Assert-PrivateEnvironment { throw 'Unexpected file access' }; function Test-RestrictedAccess { throw 'Unexpected network access' }; Invoke-RestrictedDatabaseSetup`], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /interactive console/);
  assert.doesNotMatch(result.stdout + result.stderr, /Unexpected/);
});
