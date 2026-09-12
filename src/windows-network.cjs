const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

function networkError(code, message) { return Object.assign(new Error(message), { code }); }
function ipv4(value) {
  if (typeof value !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return null;
  const bytes = value.split('.').map(Number);
  return bytes.every(n => n <= 255) ? bytes : null;
}
function subnet(address, netmask) {
  const ip = ipv4(address), mask = ipv4(netmask);
  if (!ip || !mask || [0, 127].includes(ip[0]) || (ip[0] === 169 && ip[1] === 254) || ip[0] >= 224) return null;
  const bits = mask.map(n => n.toString(2).padStart(8, '0')).join('');
  // Refuse invalid and /0 masks: a fallback must never allow the whole Internet.
  if (!/^1+0*$/.test(bits)) return null;
  const prefix = bits.indexOf('0') < 0 ? 32 : bits.indexOf('0');
  return `${ip.map((n, i) => n & mask[i]).join('.')}/${prefix}`;
}
function selectNetworkScopes(interfaces) {
  const scopes = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    if (!name || /[\x00-\x1f]/.test(name) || !Array.isArray(addresses)) continue;
    const subnets = [...new Set(addresses.filter(a => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)
      .map(a => subnet(a.address, a.netmask)).filter(Boolean))];
    if (subnets.length) scopes.push({ name, subnets });
  }
  const vpn = scopes.filter(scope => /radmin/i.test(scope.name));
  return vpn.length ? vpn : scopes;
}
function windowsPath(value, executable = false) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value) || /[\x00-\x1f*?"<>|]/.test(value) ||
      (!/^[A-Za-z]:\\/.test(value) && !/^\\\\[^\\]+\\[^\\]+\\/.test(value)) ||
      value.slice(/^[A-Za-z]:/.test(value) ? 2 : 0).includes(':') || (executable && !/\.exe$/i.test(value))) {
    throw networkError('INVALID_PATH', 'O caminho do aplicativo ou do Windows não é válido.');
  }
  return path.win32.normalize(value);
}
function createFirewallPlan(program, interfaces) {
  program = windowsPath(program, true);
  const scopes = selectNetworkScopes(interfaces);
  if (!scopes.length) throw networkError('NO_NETWORK', 'Conecte o Radmin VPN ou uma rede local antes de permitir a conexão.');
  const key = createHash('sha256').update(program.toLowerCase()).digest('hex').slice(0, 16);
  return { program, group: `EntreTela-${key}`, scopes };
}
function encoded(script) { return Buffer.from(script, 'utf16le').toString('base64'); }
function literal(value) { return `'${value.replace(/'/g, "''")}'`; }
function createPowerShellInvocation(plan, systemRoot) {
  const powershell = path.win32.join(windowsPath(systemRoot), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // All discovered names and paths travel as JSON data, never as PowerShell source.
  const payload = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
  const elevatedScript = `$ErrorActionPreference = 'Stop'
try {
  $plan = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
  $index = 0
  $expectedNames = @()
  foreach ($scope in $plan.scopes) {
    $index++
    foreach ($protocol in @('TCP', 'UDP')) {
      $name = $plan.group + '-' + $index + '-' + $protocol
      $expectedNames += $name
      $displayName = 'EntreTela (' + $scope.name + ') ' + $protocol
      $parameters = @{
        Description = 'Conexao autorizada no EntreTela: este executavel, esta interface e sua subrede IPv4.'
        Direction = 'Inbound'
        Action = 'Allow'
        Enabled = 'True'
        Profile = 'Any'
        Program = $plan.program
        Protocol = $protocol
        InterfaceAlias = [System.Management.Automation.WildcardPattern]::Escape($scope.name)
        RemoteAddress = [string[]] $scope.subnets
        EdgeTraversalPolicy = 'Block'
      }
      $existing = Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue
      if ($existing) {
        $existingApplication = $existing | Get-NetFirewallApplicationFilter
        if ($existing.Group -cne $plan.group -or $existingApplication.Program -ine $plan.program -or
            $existing.Direction -ne 'Inbound' -or $existing.Action -ne 'Allow') {
          throw 'An unrelated firewall rule already uses this name.'
        }
        $existing | Set-NetFirewallRule -NewDisplayName $displayName @parameters | Out-Null
      } else {
        New-NetFirewallRule -PolicyStore PersistentStore -Name $name -DisplayName $displayName -Group $plan.group @parameters | Out-Null
      }
    }
  }
  # Retire only our obsolete rules after every current scope has been applied.
  # This closes the old LAN scopes when a later click selects Radmin VPN.
  $ownedNamePattern = '^' + [regex]::Escape($plan.group) + '-[1-9][0-9]*-(TCP|UDP)$'
  $oldRules = Get-NetFirewallRule -PolicyStore PersistentStore -Group $plan.group -ErrorAction SilentlyContinue
  foreach ($oldRule in $oldRules) {
    if ($oldRule.Group -ceq $plan.group -and $oldRule.Name -cmatch $ownedNamePattern -and
        $expectedNames -notcontains $oldRule.Name -and $oldRule.Direction -eq 'Inbound' -and $oldRule.Action -eq 'Allow') {
      $oldApplication = $oldRule | Get-NetFirewallApplicationFilter
      if ($oldApplication.Program -ieq $plan.program) {
        Remove-NetFirewallRule -InputObject $oldRule | Out-Null
      }
    }
  }
  $applications = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore | Where-Object { $_.Program -eq $plan.program })
  if ($applications.Count) {
    $blocked = $applications | Get-NetFirewallRule |
      Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }
    if ($blocked) { exit 22 }
  }
  exit 0
} catch { exit 21 }
`;
  const outerScript = `$ErrorActionPreference = 'Stop'
try {
  $child = Start-Process -FilePath ${literal(powershell)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded(elevatedScript)}'
  exit $child.ExitCode
} catch {
  $problem = $_.Exception
  while ($null -ne $problem) {
    if ($problem.NativeErrorCode -eq 1223) { exit 20 }
    $problem = $problem.InnerException
  }
  exit 21
}
`;
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(outerScript)];
  if (powershell.length + args.join(' ').length > 30000) {
    throw networkError('TOO_MANY_NETWORKS', 'Há muitas interfaces de rede. Mantenha o Radmin VPN conectado e tente novamente.');
  }
  return { file: powershell, args };
}

// Called only by the main-process IPC handler after the user's explicit button click.
// No renderer-supplied program, interface, command, or argument is accepted.
async function allowNetwork() {
  if (process.platform !== 'win32') return { ok: false, code: 'NOT_WINDOWS', message: 'Esta opção está disponível apenas no Windows.' };
  let plan;
  try {
    plan = createFirewallPlan(process.execPath, os.networkInterfaces());
    const invocation = createPowerShellInvocation(plan, process.env.SystemRoot || process.env.windir || 'C:\\Windows');
    await runFile(invocation.file, invocation.args, { windowsHide: true, shell: false, maxBuffer: 65536 });
    return { ok: true, code: 'NETWORK_ALLOWED', interfaces: plan.scopes.map(s => s.name), message: 'Conexão permitida para este aplicativo. Façam isso nos dois computadores e tentem entrar novamente.' };
  } catch (error) {
    if (error.code === 20 || error.code === 1223) return { ok: false, code: 'UAC_CANCELLED', message: 'A autorização do Windows foi cancelada. Clique novamente e aceite a solicitação para permitir a conexão.' };
    if (error.code === 22) return { ok: false, configured: true, code: 'FIREWALL_BLOCK_RULE', message: 'A permissão foi criada, mas há também uma regra de bloqueio para este aplicativo. Abra o Firewall do Windows > Configurações avançadas > Regras de Entrada e revise o bloqueio do EntreTela.' };
    if (['INVALID_PATH', 'NO_NETWORK', 'TOO_MANY_NETWORKS'].includes(error.code)) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'FIREWALL_FAILED', message: 'O Windows não conseguiu configurar a permissão. Use uma conta de administrador. Se houver outro firewall ou antivírus, permita o EntreTela na rede do Radmin VPN nele também.' };
  }
}

module.exports = { allowNetwork, createFirewallPlan, createPowerShellInvocation, selectNetworkScopes };
