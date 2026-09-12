const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createFirewallPlan, createPowerShellInvocation, selectNetworkScopes } = require('../src/windows-network.cjs');
const ipv4 = (address, netmask = '255.255.255.0', extra = {}) => ({ family: 'IPv4', address, netmask, internal: false, ...extra });
const executable = 'C:\\Users\\João\\AppData\\Local\\Temp\\EntreTela\\EntreTela.exe';

test('firewall prefers the Radmin interface and calculates its actual subnet', () => {
  const scopes = selectNetworkScopes({
    Ethernet: [ipv4('192.168.1.30')],
    'Radmin VPN': [ipv4('26.71.12.99', '255.0.0.0'), ipv4('26.71.12.99', '255.0.0.0')],
    Loopback: [ipv4('127.0.0.1', '255.0.0.0', { internal: true })]
  });
  assert.deepEqual(scopes, [{ name: 'Radmin VPN', subnets: ['26.0.0.0/8'] }]);
});

test('LAN fallback keeps each interface and subnet paired, rejecting invalid or global masks', () => {
  assert.deepEqual(selectNetworkScopes({
    WiFi: [ipv4('192.168.7.54', '255.255.254.0')],
    Ethernet: [ipv4('10.5.8.42', '255.255.255.240')],
    Invalid: [ipv4('10.1.1.1', '255.0.255.0'), ipv4('10.1.1.1', '0.0.0.0')],
    Disconnected: [ipv4('169.254.10.30')],
    Loopback: [ipv4('127.0.0.1')],
    IPv6: [{ family: 'IPv6', address: '::1', netmask: 'ffff:ffff:ffff:ffff::' }]
  }), [
    { name: 'WiFi', subnets: ['192.168.6.0/23'] },
    { name: 'Ethernet', subnets: ['10.5.8.32/28'] }
  ]);
  assert.throws(() => createFirewallPlan(executable, {}), { code: 'NO_NETWORK' });
});

test('firewall commands encode hostile-looking paths and adapter names strictly as data', () => {
  const program = "C:\\Users\\D'Ávila $(`whoami); [x]\\EntreTela.exe";
  const name = "Radmin VPN ' ; Write-Host injected; # [*]";
  const plan = createFirewallPlan(program, { [name]: [ipv4('26.1.2.3', '255.0.0.0')] });
  const invocation = createPowerShellInvocation(plan, "C:\\Windows D'Ávila");
  assert.equal(invocation.file, "C:\\Windows D'Ávila\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const outer = Buffer.from(invocation.args[3], 'base64').toString('utf16le');
  assert.match(outer, /-Verb RunAs -WindowStyle Hidden -Wait -PassThru/);
  assert.match(outer, /Windows D''Ávila/);
  assert.match(outer, /NativeErrorCode -eq 1223/);
  const encodedInner = outer.match(/-ArgumentList '-NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)'/)[1];
  const inner = Buffer.from(encodedInner, 'base64').toString('utf16le');
  assert.equal(inner.includes(program), false);
  assert.equal(inner.includes(name), false);
  const payload = inner.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')), plan);
  assert.match(inner, /WildcardPattern\]::Escape\(\$scope.name\)/);
  assert.match(inner, /Program = \$plan.program/);
  assert.match(inner, /RemoteAddress = \[string\[\]\] \$scope.subnets/);
  assert.match(inner, /Direction = 'Inbound'/);
  assert.match(inner, /@\('TCP', 'UDP'\)/);
  assert.match(inner, /Profile = 'Any'/);
  assert.match(inner, /\$existing \| Set-NetFirewallRule -NewDisplayName \$displayName @parameters/);
  assert.doesNotMatch(inner, /Set-NetFirewallProfile|netsh|Invoke-Expression/);
  assert.match(inner, /\$existing.Group -cne \$plan.group -or \$existingApplication.Program -ine \$plan.program/);
  assert.match(inner, /Get-NetFirewallRule -PolicyStore PersistentStore -Group \$plan.group/);
  assert.match(inner, /\$oldRule.Group -ceq \$plan.group -and \$oldRule.Name -cmatch \$ownedNamePattern/);
  assert.match(inner, /\$expectedNames -notcontains \$oldRule.Name/);
  assert.match(inner, /if \(\$oldApplication.Program -ieq \$plan.program\) \{\s+Remove-NetFirewallRule -InputObject \$oldRule/);
  assert.equal((inner.match(/Remove-NetFirewallRule/g) || []).length, 1);
  assert.match(inner, /\$_.Action -eq 'Block'/);
});

test('firewall scopes and rule identities are tied to the actual executable path', () => {
  const interfaces = { 'Radmin VPN': [ipv4('26.1.2.3', '255.0.0.0')] };
  const a = createFirewallPlan(executable, interfaces);
  assert.equal(a.group, createFirewallPlan(executable.toUpperCase(), interfaces).group);
  assert.notEqual(a.group, createFirewallPlan('C:\\Other\\EntreTela.exe', interfaces).group);
  for (const bad of ['EntreTela.exe', 'C:\\*\\EntreTela.exe', 'C:\\folder\\bad.exe\n', 'C:\\folder\\not.exe.ps1', 'C:\\folder\\other:bad.exe']) {
    assert.throws(() => createFirewallPlan(bad, interfaces), { code: 'INVALID_PATH' });
  }
});

test('Windows PowerShell parses both generated scripts without executing them', { skip: process.platform !== 'win32' }, () => {
  const plan = createFirewallPlan(executable, { 'Radmin VPN': [ipv4('26.1.2.3', '255.0.0.0')] });
  const invocation = createPowerShellInvocation(plan, process.env.SystemRoot || 'C:\\Windows');
  const outer = Buffer.from(invocation.args[3], 'base64').toString('utf16le');
  const inner = Buffer.from(outer.match(/-ArgumentList '-NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf16le');
  // ParseInput only constructs syntax trees. Neither supplied script is invoked.
  const parser = `$scripts = ConvertFrom-Json ([Console]::In.ReadToEnd())
foreach ($source in $scripts) {
  $tokens = $null; $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref] $tokens, [ref] $errors)
  if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }
}
exit 0`;
  const result = spawnSync(invocation.file, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')], {
    input: JSON.stringify([outer, inner]), encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
