'use strict';

/**
 * Tests for the portable self-update helpers. Run with `npm test`.
 *
 * The Windows swap itself cannot be exercised from here, so this covers
 * everything that decides *what* gets swapped and under which conditions:
 * release URLs, channel parsing, checksum verification, version ordering,
 * leftover cleanup rules, and the generated PowerShell helper.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const portable = require('../portable-update.cjs');

const winPath = path.win32;
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    console.error(`  FAIL - ${name}`);
    throw error;
  }
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `streammore-${label}-`));
}

console.log('portable update');

// --- portable detection -----------------------------------------------------

test('detects the portable launcher environment', () => {
  const env = { PORTABLE_EXECUTABLE_FILE: 'C:\\Users\\marco\\Streammore-Portable-1.0.3-x64.exe' };
  assert.equal(portable.isPortable(env), true);
  assert.equal(
    portable.portableExecutable(env),
    'C:\\Users\\marco\\Streammore-Portable-1.0.3-x64.exe',
  );
});

test('treats an installed build as non-portable', () => {
  assert.equal(portable.isPortable({}), false);
  assert.equal(portable.isPortable({ PORTABLE_EXECUTABLE_FILE: '' }), false);
  assert.equal(portable.portableExecutable({}), null);
});

// --- release URLs -----------------------------------------------------------

test('builds the published portable asset url', () => {
  assert.equal(portable.releaseTag('1.0.3'), 'v1.0.3');
  assert.equal(
    portable.portableAssetName('1.0.3'),
    'Streammore-Portable-1.0.3-x64.exe',
  );
  assert.equal(
    portable.portableAssetUrl('1.0.3'),
    'https://github.com/Marco0300/Streammorewin/releases/download/v1.0.3/Streammore-Portable-1.0.3-x64.exe',
  );
  assert.equal(
    portable.portableChannelUrl('1.0.3'),
    'https://github.com/Marco0300/Streammorewin/releases/download/v1.0.3/portable.yml',
  );
});

test('stages the download beside the running executable', () => {
  const target = 'C:\\Games\\Streammore\\Streammore-Portable-1.0.3-x64.exe';
  assert.equal(
    portable.stagedPathFor(target, '1.0.4', winPath),
    'C:\\Games\\Streammore\\Streammore-Portable-1.0.4-x64.exe.update',
  );
  assert.equal(
    portable.backupPathFor(target),
    'C:\\Games\\Streammore\\Streammore-Portable-1.0.3-x64.exe.old',
  );
  assert.equal(
    portable.failureLogPathFor(target),
    'C:\\Games\\Streammore\\Streammore-Portable-1.0.3-x64.exe.update-failed.log',
  );
});

// --- version ordering -------------------------------------------------------

test('only accepts strictly newer stable versions', () => {
  assert.equal(portable.isNewerVersion('1.0.3', '1.0.4'), true);
  assert.equal(portable.isNewerVersion('1.0.3', '1.1.0'), true);
  assert.equal(portable.isNewerVersion('1.0.3', '2.0.0'), true);
  assert.equal(portable.isNewerVersion('1.0.3', '1.0.3'), false);
  assert.equal(portable.isNewerVersion('1.0.4', '1.0.3'), false);
  assert.equal(portable.isNewerVersion('1.0.3', 'v1.0.4'), true);
  assert.equal(portable.isNewerVersion('1.0.3', '1.0.4-beta.1'), false);
  assert.equal(portable.isNewerVersion('1.0.3', 'not-a-version'), false);
});

// --- channel parsing --------------------------------------------------------

test('parses the channel file the workflow publishes', () => {
  const channel = portable.parsePortableChannel(
    [
      'version: 1.0.3',
      'files:',
      '  - url: Streammore-Portable-1.0.3-x64.exe',
      '    sha512: AAAA+BBB/CC==',
      '    size: 164365932',
      'path: Streammore-Portable-1.0.3-x64.exe',
      "releaseDate: '2026-09-26T01:26:32.169Z'",
      '',
    ].join('\n'),
  );
  assert.notEqual(channel, null);
  assert.equal(channel.version, '1.0.3');
  assert.equal(channel.url, 'Streammore-Portable-1.0.3-x64.exe');
  assert.equal(channel.sha512, 'AAAA+BBB/CC==');
  assert.equal(channel.size, 164365932);
});

test('parses a flat channel file too', () => {
  const channel = portable.parsePortableChannel(
    ['version: 1.0.3', 'url: Streammore-Portable-1.0.3-x64.exe', 'sha512: ZZ==', 'size: 12'].join('\r\n'),
  );
  assert.equal(channel.url, 'Streammore-Portable-1.0.3-x64.exe');
  assert.equal(channel.sha512, 'ZZ==');
  assert.equal(channel.size, 12);
});

test('rejects a channel file without a checksum', () => {
  assert.equal(portable.parsePortableChannel('version: 1.0.3\n'), null);
  assert.equal(portable.parsePortableChannel(''), null);
  assert.equal(portable.parsePortableChannel(undefined), null);
});

test('parses a channel file written with a UTF-8 byte order mark', () => {
  // The workflow writes portable.yml with PowerShell, which may prepend a BOM.
  const text = '\uFEFF' + 'version: 1.0.3\r\nurl: Streammore-Portable-1.0.3-x64.exe\r\nsha512: QQ==\r\nsize: 5\r\n';
  const channel = portable.parsePortableChannel(text);
  assert.notEqual(channel, null);
  assert.equal(channel.version, '1.0.3');
  assert.equal(channel.url, 'Streammore-Portable-1.0.3-x64.exe');
  assert.equal(channel.sha512, 'QQ==');
  assert.equal(channel.size, 5);
});

// --- checksum verification --------------------------------------------------

test('accepts a staged file that matches the channel checksum', () => {
  const dir = tempDir('verify-ok');
  const file = path.join(dir, 'Streammore-Portable-1.0.4-x64.exe.update');
  fs.writeFileSync(file, crypto.randomBytes(64 * 1024));
  const sha512 = portable.sha512Base64(file);
  const result = portable.verifyStagedFile(file, { sha512, size: fs.statSync(file).size });
  assert.equal(result.ok, true);
  assert.equal(result.sha512, sha512);
});

test('rejects a truncated or tampered staged file', () => {
  const dir = tempDir('verify-bad');
  const file = path.join(dir, 'update');
  const body = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(file, body);
  const sha512 = portable.sha512Base64(file);

  fs.writeFileSync(file, body.subarray(0, body.length - 1));
  const truncated = portable.verifyStagedFile(file, { sha512, size: body.length });
  assert.equal(truncated.ok, false);
  assert.match(truncated.reason, /size mismatch/);

  fs.writeFileSync(file, Buffer.concat([body.subarray(0, 100), Buffer.from([0])]));
  const tampered = portable.verifyStagedFile(file, { sha512, size: 101 });
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /checksum mismatch/);
});

test('rejects a channel file that publishes no checksum', () => {
  const dir = tempDir('verify-nohash');
  const file = path.join(dir, 'update');
  fs.writeFileSync(file, 'x');
  const result = portable.verifyStagedFile(file, { url: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not publish a sha512/);
});

test('reports an unreadable staged file instead of throwing', () => {
  const result = portable.verifyStagedFile(path.join(tempDir('verify-missing'), 'nope.exe'), {
    sha512: 'AA==',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not readable/);
});

// --- swap helper script -----------------------------------------------------

test('generates a swap script that waits, replaces, relaunches and self-deletes', () => {
  const script = portable.buildSwapScript({
    target: "C:\\Users\\marco\\Streammore-Portable-1.0.3-x64.exe",
    staged: "C:\\Users\\marco\\Streammore-Portable-1.0.4-x64.exe.update",
    appPid: 4321,
    launcherPid: 1234,
    logPath: "C:\\Users\\marco\\Streammore-Portable-1.0.3-x64.exe.update-failed.log",
  });

  // waits for the app and the portable launcher (which holds the file open)
  assert.match(script, /Wait-StreammoreExit \$appProcId/);
  assert.match(script, /Wait-StreammoreExit \$launcherProcId/);
  assert.match(script, /\$appProcId = 4321/);
  assert.match(script, /\$launcherProcId = 1234/);

  // retries the replace and keeps a backup of the current build
  assert.match(script, /for \(\$attempt = 0; \$attempt -lt 60; \$attempt\+\+\)/);
  assert.match(script, /Move-Item -LiteralPath \$staged -Destination \$target -Force/);
  assert.match(script, /\.exe\.old/);

  // relaunches the app and cleans up after itself
  assert.match(script, /Start-Process -FilePath \$target/);
  assert.match(script, /Remove-Item -LiteralPath \$MyInvocation\.MyCommand\.Path/);

  // never uses the reserved $PID automatic variable
  assert.doesNotMatch(script, /\$PID\b/);
});

test('escapes apostrophes in Windows paths', () => {
  const script = portable.buildSwapScript({
    target: "C:\\Users\\O'Brien\\Streammore.exe",
    staged: "C:\\Users\\O'Brien\\Streammore.exe.update",
    appPid: 1,
    launcherPid: 2,
    logPath: "C:\\Users\\O'Brien\\Streammore.exe.log",
  });
  assert.match(script, /'C:\\Users\\O''Brien\\Streammore\.exe'/);
});

test('writes the manual download link when the swap cannot happen', () => {
  const script = portable.buildSwapScript({
    target: 'C:\\ro\\Streammore.exe',
    staged: 'C:\\ro\\Streammore.exe.update',
    appPid: 1,
    launcherPid: 2,
    logPath: 'C:\\ro\\Streammore.exe.log',
  });
  assert.match(script, /could not replace/);
  assert.match(script, /releases\/latest/);
});

test('skips waiting when no launcher pid is known', () => {
  const script = portable.buildSwapScript({
    target: 'C:\\a\\Streammore.exe',
    staged: 'C:\\a\\Streammore.exe.update',
    appPid: 99,
    launcherPid: 0,
    logPath: 'C:\\a\\log.txt',
  });
  assert.match(script, /\$launcherProcId = 0/);
  assert.match(script, /if \(\$procId -le 0\) \{ return \}/);
});

// --- leftovers --------------------------------------------------------------

test('finds a staged update for a newer release', () => {
  const dir = tempDir('pending');
  fs.writeFileSync(path.join(dir, 'Streammore-Portable-1.0.4-x64.exe.update'), 'x');
  fs.writeFileSync(path.join(dir, 'Streammore-Portable-1.0.2-x64.exe.update'), 'x');
  const pending = portable.findPendingStaged(dir, '1.0.3');
  assert.notEqual(pending, null);
  assert.equal(pending.version, '1.0.4');
});

test('ignores staged files that are not newer than the running build', () => {
  const dir = tempDir('pending-none');
  fs.writeFileSync(path.join(dir, 'Streammore-Portable-1.0.3-x64.exe.update'), 'x');
  assert.equal(portable.findPendingStaged(dir, '1.0.3'), null);
  assert.equal(portable.findPendingStaged(path.join(dir, 'missing'), '1.0.3'), null);
});

test('cleans stale downloads and old backups without touching the app', () => {
  const dir = tempDir('cleanup');
  const current = path.join(dir, 'Streammore-Portable-1.0.4-x64.exe');
  const staleStaged = path.join(dir, 'Streammore-Portable-1.0.3-x64.exe.update');
  const pendingStaged = path.join(dir, 'Streammore-Portable-1.0.5-x64.exe.update');
  const freshBackup = path.join(dir, 'Streammore-Portable-1.0.3-x64.exe.old');
  const oldBackup = path.join(dir, 'Streammore-Portable-1.0.2-x64.exe.old');
  const unrelated = path.join(dir, 'notes.txt');

  for (const file of [current, staleStaged, pendingStaged, freshBackup, oldBackup, unrelated]) {
    fs.writeFileSync(file, 'x');
  }
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(oldBackup, old, old);

  const { removed, kept } = portable.cleanupLeftovers(dir, '1.0.4');

  assert.ok(removed.includes(staleStaged), 'stale download of the running version is removed');
  assert.ok(removed.includes(oldBackup), 'backup older than a day is removed');
  assert.ok(kept.includes(pendingStaged), 'pending update download is kept');
  assert.ok(kept.includes(freshBackup), 'recent backup is kept');
  assert.ok(fs.existsSync(current), 'running executable is untouched');
  assert.ok(fs.existsSync(unrelated), 'unrelated files are untouched');
  assert.equal(removed.length, 2);
});

// --- shipped wiring ---------------------------------------------------------

test('main.cjs wires the portable path and keeps the installer path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(source, /require\('\.\/portable-update\.cjs'\)/);
  assert.match(source, /portableUpdate\.isPortable\(\)/);
  assert.match(source, /portableUpdate\.buildSwapScript\(/);
  assert.match(source, /autoUpdater\.quitAndInstall\(/);
  assert.match(source, /portable\.yml|cacheBusting|portableChannelUrl/);
});

test('the CI channel verifier accepts a matching file and rejects a mismatch', () => {
  const script = path.join(__dirname, '..', 'scripts', 'verify-portable-channel.cjs');
  // The verifier cross-checks the channel version against package.json, so the
  // fixture has to use the version being built.
  const version = require('../package.json').version;
  const assetName = portable.portableAssetName(version);
  const dir = tempDir('channel');
  const exe = path.join(dir, assetName);
  fs.writeFileSync(exe, crypto.randomBytes(32 * 1024));
  const sha512 = portable.sha512Base64(exe);
  const channel = path.join(dir, 'portable.yml');
  fs.writeFileSync(
    channel,
    [
      `version: ${version}`,
      'files:',
      `  - url: ${assetName}`,
      `    sha512: ${sha512}`,
      `    size: ${fs.statSync(exe).size}`,
      `path: ${assetName}`,
      `sha512: ${sha512}`,
      '',
    ].join('\n'),
  );

  const ok = spawnSync(process.execPath, [script, channel, exe], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);

  fs.appendFileSync(exe, 'tampered');
  const bad = spawnSync(process.execPath, [script, channel, exe], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'a tampered executable must fail verification');
});

console.log(`\n${passed} checks passed`);
