'use strict';

/**
 * CI guard: verify that the portable.yml channel file published with a release
 * really describes the portable executable that was just built.
 *
 * Usage: node scripts/verify-portable-channel.cjs <channel.yml> <portable.exe>
 *
 * Exits non-zero when the file name, size or sha512 does not match, so a
 * release cannot ship update metadata that would fail verification inside the
 * app (or worse, point at the wrong file).
 */

const fs = require('node:fs');
const path = require('node:path');

const portable = require('../portable-update.cjs');

function fail(message) {
  console.error(`portable channel check failed: ${message}`);
  process.exit(1);
}

const [channelPath, executablePath] = process.argv.slice(2);
if (!channelPath || !executablePath) {
  fail('usage: verify-portable-channel.cjs <channel.yml> <portable.exe>');
}
if (!fs.existsSync(channelPath)) fail(`channel file not found: ${channelPath}`);
if (!fs.existsSync(executablePath)) fail(`executable not found: ${executablePath}`);

const channel = portable.parsePortableChannel(fs.readFileSync(channelPath, 'utf8'));
if (channel === null) fail(`could not parse ${channelPath}`);

const executableName = path.basename(executablePath);
if (channel.url !== executableName) {
  fail(`channel url "${channel.url}" does not match "${executableName}"`);
}

const verification = portable.verifyStagedFile(executablePath, channel);
if (!verification.ok) fail(verification.reason);

const packageVersion = require('../package.json').version;
if (channel.version !== packageVersion) {
  fail(`channel version "${channel.version}" does not match package.json "${packageVersion}"`);
}

console.log(
  `portable.yml verified: ${channel.url}, ${verification.size} bytes, sha512 ${verification.sha512}`,
);
