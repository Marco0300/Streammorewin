const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// "Sign in with a code" is driven by the page (public/app.js in the web client),
// which only offers it when the shell says it can present the pairing screen.
// That flag is the whole shell-side contract, so it is worth pinning.

const root = path.resolve(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');

test('the preload advertises device sign-in', () => {
  assert.match(preload, /deviceSignIn: true/);
});

test('the advertised name is the one the page looks for', () => {
  // public/app.js reads window.streammoreDesktop.deviceSignIn.
  assert.match(preload, /exposeInMainWorld\('streammoreDesktop'/);
  assert.match(preload, /deviceSignIn: true/);
});

test('the shell does not need to broker the requests', () => {
  // The page talks to /api/auth/device/* itself: its responses land in the same
  // Electron session, so the cookie it receives is the session the app uses.
  // Nothing in main.cjs should intercept or proxy the device endpoints.
  assert.doesNotMatch(main, /api\/auth\/device/);
});

test('the capability sits beside the other advertised capabilities', () => {
  assert.match(preload, /nativePlayback: true/);
  assert.match(preload, /deviceSignIn: true/);
  assert.match(preload, /version: process\.versions\.electron/);
  assert.match(preload, /platform: process\.platform/);
});
