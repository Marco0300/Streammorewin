'use strict';

/**
 * Self-update support for the portable Windows build.
 *
 * electron-updater has no portable support at all. The portable launcher
 * (app-builder-lib/templates/nsis/portable.nsi) extracts the app into a temp
 * directory, exports PORTABLE_EXECUTABLE_DIR / PORTABLE_EXECUTABLE_FILE /
 * PORTABLE_EXECUTABLE_APP_FILENAME, waits for the app to exit and then deletes
 * the temp directory. That means `autoUpdater.quitAndInstall()` cannot replace
 * the executable the user actually launched: Electron cannot overwrite a
 * running image, and the portable launcher itself still holds the file open
 * while it waits.
 *
 * The portable path therefore works differently from the installer path:
 *
 *   1. resolve the newest release through electron-updater as usual;
 *   2. download the published *portable* executable into a `.update` file next
 *      to the running executable and verify it against `portable.yml`;
 *   3. hand the swap to a detached PowerShell helper that waits for this
 *      process and the portable launcher to exit, replaces the file (keeping a
 *      `.old` backup), and starts the new build.
 *
 * Everything in this module is pure so it can be tested on any platform; the
 * runtime wiring lives in main.cjs.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GITHUB_REPO = 'Marco0300/Streammorewin';
const RELEASE_DOWNLOAD_BASE = `https://github.com/${GITHUB_REPO}/releases/download`;
const RELEASE_PAGE_BASE = `https://github.com/${GITHUB_REPO}/releases/tag`;
const PORTABLE_ASSET_PREFIX = 'Streammore-Portable-';
const STAGED_SUFFIX = '.update';
const BACKUP_SUFFIX = '.old';
const FAILURE_LOG_SUFFIX = '.update-failed.log';
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function portableExecutable(env = process.env) {
  const file = env.PORTABLE_EXECUTABLE_FILE;
  return typeof file === 'string' && file.length > 0 ? file : null;
}

function isPortable(env = process.env) {
  return portableExecutable(env) !== null;
}

function releaseTag(version) {
  return `v${version}`;
}

function portableAssetName(version, arch = 'x64') {
  return `${PORTABLE_ASSET_PREFIX}${version}-${arch}.exe`;
}

function portableAssetUrl(version, arch = 'x64') {
  return `${RELEASE_DOWNLOAD_BASE}/${releaseTag(version)}/${portableAssetName(version, arch)}`;
}

function portableChannelUrl(version) {
  return `${RELEASE_DOWNLOAD_BASE}/${releaseTag(version)}/portable.yml`;
}

function releasePageUrl(version) {
  return `${RELEASE_PAGE_BASE}/${releaseTag(version)}`;
}

function latestReleasePageUrl() {
  return `https://github.com/${GITHUB_REPO}/releases/latest`;
}

/** Path of the downloaded-but-not-yet-installed portable executable. */
function stagedPathFor(target, version, pathApi = path) {
  return pathApi.join(pathApi.dirname(target), `${portableAssetName(version)}${STAGED_SUFFIX}`);
}

function backupPathFor(target) {
  return `${target}${BACKUP_SUFFIX}`;
}

function failureLogPathFor(target) {
  return `${target}${FAILURE_LOG_SUFFIX}`;
}

function normalizeBase64(value) {
  return String(value ?? '').replace(/\s+/g, '').replace(/^['"]|['"]$/g, '');
}

function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('base64');
}

function verifyStagedFile(filePath, expected, fsApi = fs) {
  let size;
  try {
    size = fsApi.statSync(filePath).size;
  } catch (error) {
    return { ok: false, reason: `staged file is not readable (${error.code || error.message})` };
  }

  const expectedSize = Number(expected && expected.size);
  if (Number.isFinite(expectedSize) && expectedSize > 0 && size !== expectedSize) {
    return { ok: false, reason: `size mismatch (downloaded ${size}, expected ${expectedSize})` };
  }

  const expectedHash = normalizeBase64(expected && expected.sha512);
  if (expectedHash.length === 0) {
    return { ok: false, reason: 'release channel does not publish a sha512 value' };
  }

  const actualHash = sha512Base64(filePath);
  if (actualHash !== expectedHash) {
    return { ok: false, reason: 'checksum mismatch' };
  }

  return { ok: true, sha512: actualHash, size };
}

/**
 * Minimal reader for the `portable.yml` channel file published with each
 * release (same shape as electron-builder's latest.yml).
 */
function parsePortableChannel(text) {
  const result = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(?:-\s*)?(version|url|path|sha512|size)\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/^['"]|['"]$/g, '');
    if (key === 'size') {
      const size = Number(value);
      if (Number.isFinite(size)) result.size = size;
      continue;
    }
    if (key === 'path' && result.url) continue;
    if (key === 'url') {
      result.url = value;
      continue;
    }
    if (result[key] === undefined) result[key] = value;
  }
  if (!result.url || !result.sha512) return null;
  return result;
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/.exec(String(value ?? '').trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

/** True when `candidate` is a strictly newer stable release than `current`. */
function isNewerVersion(current, candidate) {
  const from = parseVersion(current);
  const to = parseVersion(candidate);
  if (from === null || to === null) return false;
  if (to.prerelease !== null) return false;
  for (const part of ['major', 'minor', 'patch']) {
    if (from[part] !== to[part]) return to[part] > from[part];
  }
  return false;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Detached helper that finishes a portable update. It has to wait for the app
 * *and* the portable launcher to exit, because the launcher holds the file
 * open while it waits for the app to finish.
 */
function buildSwapScript({ target, staged, appPid, launcherPid, logPath }) {
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    `$target = ${psQuote(target)}`,
    `$staged = ${psQuote(staged)}`,
    `$logPath = ${psQuote(logPath)}`,
    `$appProcId = ${Number(appPid) > 0 ? Number(appPid) : 0}`,
    `$launcherProcId = ${Number(launcherPid) > 0 ? Number(launcherPid) : 0}`,
    '',
    '# Wait for the running Streammore process and its portable launcher to exit.',
    'function Wait-StreammoreExit([int]$procId) {',
    '  if ($procId -le 0) { return }',
    '  for ($i = 0; $i -lt 600; $i++) {',
    '    if ($null -eq (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { return }',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '}',
    '',
    'Wait-StreammoreExit $appProcId',
    'Wait-StreammoreExit $launcherProcId',
    'Start-Sleep -Milliseconds 500',
    '',
    '$replaced = $false',
    'for ($attempt = 0; $attempt -lt 60; $attempt++) {',
    '  try {',
    `    if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination ${psQuote(backupPathFor(target))} -Force -ErrorAction SilentlyContinue }`,
    '    Move-Item -LiteralPath $staged -Destination $target -Force -ErrorAction Stop',
    '    $replaced = $true',
    '    break',
    '  } catch {',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '}',
    '',
    'if ($replaced) {',
    '  Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue',
    '  Start-Process -FilePath $target',
    '} else {',
    `  ("Streammore could not replace {0}. Download the new version from {1}" -f $target, ${psQuote(latestReleasePageUrl())}) | Set-Content -LiteralPath $logPath -Encoding utf8`,
    '  Start-Process -FilePath $target',
    '}',
    '',
    'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
    '',
  ];
  return lines.join('\r\n');
}

function stagedVersionFromName(name) {
  const match = /^Streammore-Portable-(\d+\.\d+\.\d+)-x64\.exe\.update$/.exec(String(name ?? ''));
  return match === null ? null : match[1];
}

/** A downloaded update for a newer release that was never installed. */
function findPendingStaged(dir, currentVersion, fsApi = fs, pathApi = path) {
  let entries;
  try {
    entries = fsApi.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    const version = stagedVersionFromName(name);
    if (version === null || !isNewerVersion(currentVersion, version)) continue;
    if (best === null || isNewerVersion(best.version, version)) {
      best = { version, path: pathApi.join(dir, name) };
    }
  }
  return best;
}

/**
 * Remove leftovers from a previous portable update. Only files this app
 * created next to the portable executable are touched: backups older than a
 * day, and staged downloads of the version that is already running.
 */
function cleanupLeftovers(dir, currentVersion, { fsApi = fs, pathApi = path, now = Date.now() } = {}) {
  const removed = [];
  const kept = [];
  let entries;
  try {
    entries = fsApi.readdirSync(dir);
  } catch {
    return { removed, kept };
  }

  for (const name of entries) {
    if (!name.startsWith(PORTABLE_ASSET_PREFIX)) continue;
    const full = pathApi.join(dir, name);

    if (name.endsWith(BACKUP_SUFFIX)) {
      let stat;
      try {
        stat = fsApi.statSync(full);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs < BACKUP_MAX_AGE_MS) {
        kept.push(full);
        continue;
      }
      try {
        fsApi.rmSync(full, { force: true });
        removed.push(full);
      } catch {
        kept.push(full);
      }
      continue;
    }

    const stagedVersion = stagedVersionFromName(name);
    if (stagedVersion === null) continue;
    if (isNewerVersion(currentVersion, stagedVersion)) {
      kept.push(full);
      continue;
    }
    try {
      fsApi.rmSync(full, { force: true });
      removed.push(full);
    } catch {
      kept.push(full);
    }
  }

  return { removed, kept };
}

module.exports = {
  GITHUB_REPO,
  PORTABLE_ASSET_PREFIX,
  STAGED_SUFFIX,
  BACKUP_SUFFIX,
  FAILURE_LOG_SUFFIX,
  portableExecutable,
  isPortable,
  releaseTag,
  portableAssetName,
  portableAssetUrl,
  portableChannelUrl,
  releasePageUrl,
  latestReleasePageUrl,
  stagedPathFor,
  backupPathFor,
  failureLogPathFor,
  normalizeBase64,
  sha512Base64,
  verifyStagedFile,
  parsePortableChannel,
  parseVersion,
  isNewerVersion,
  buildSwapScript,
  stagedVersionFromName,
  findPendingStaged,
  cleanupLeftovers,
};
