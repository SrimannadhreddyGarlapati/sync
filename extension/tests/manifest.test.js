import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(extensionRoot, 'manifest.json'), 'utf8'));

const exists = (relativePath) => existsSync(resolve(extensionRoot, relativePath));

test('every file the manifest names exists', () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
  ];

  for (const path of referenced) {
    assert.ok(exists(path), `manifest references a missing file: ${path}`);
  }
});

test('the offscreen document and its script exist', () => {
  // Named in code rather than the manifest, so nothing else catches a typo
  // here — and WebRTC silently never starts if the path is wrong.
  assert.ok(exists('src/offscreen/offscreen.html'));
  assert.ok(exists('src/offscreen/offscreen.js'));
});

test('the offscreen permission is declared', () => {
  // Without it chrome.offscreen is undefined and P2P can never come up.
  assert.ok(
    manifest.permissions.includes('offscreen'),
    'hosting WebRTC outside the service worker requires the offscreen permission'
  );
});

test('minimum_chrome_version covers the APIs actually used', () => {
  // chrome.offscreen landed in 109; chrome.runtime.getContexts in 116.
  assert.ok(
    Number(manifest.minimum_chrome_version) >= 116,
    `getContexts requires Chrome 116, manifest says ${manifest.minimum_chrome_version}`
  );
});

test('the server host is permitted over both wss and https', () => {
  // wss for the relay, https for GET /turn-credentials.
  const hosts = manifest.host_permissions.join(' ');
  assert.match(hosts, /wss:\/\/[^\s]*onrender\.com/);
  assert.match(hosts, /https:\/\/[^\s]*onrender\.com/);
});

test('the committed build points at the deployed server, not localhost', () => {
  // A build left pointing at a local server fails silently for everyone except
  // the machine running it, and there is no visible sign of it in the UI.
  const source = readFileSync(resolve(extensionRoot, 'src/background/config.js'), 'utf8');

  assert.match(
    source,
    /const USE_LOCAL_SERVER = false;/,
    'set USE_LOCAL_SERVER back to false before committing'
  );
});

test('the server URL is defined in exactly one place', () => {
  // Two copies drift, and a WebSocket pointing somewhere the ICE fetch does not
  // is a confusing failure to diagnose.
  for (const path of [
    'src/background/transports/WebSocketTransport.js',
    'src/background/transports/WebRTCTransport.js',
  ]) {
    const source = readFileSync(resolve(extensionRoot, path), 'utf8');
    assert.ok(
      !source.includes('onrender.com'),
      `${path} hardcodes the server host; it should import from config.js`
    );
  }
});

test('the offscreen page carries no inline script', () => {
  // MV3's content security policy refuses inline script in extension pages.
  const html = readFileSync(resolve(extensionRoot, 'src/offscreen/offscreen.html'), 'utf8');
  const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i;

  assert.ok(!inline.test(html), 'inline script would be blocked by MV3 CSP');
});

test('the popup carries no inline script', () => {
  const html = readFileSync(resolve(extensionRoot, manifest.action.default_popup), 'utf8');
  const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i;

  assert.ok(!inline.test(html), 'inline script would be blocked by MV3 CSP');
});

test('every background command module is imported by SyncEngine', () => {
  // A command that is never imported never self-registers with CommandFactory,
  // so its wire type deserializes to null and the command is dropped silently.
  const engine = readFileSync(
    resolve(extensionRoot, 'src/background/SyncEngine.js'),
    'utf8'
  );

  const commandFiles = [
    'PlayCommand', 'PauseCommand', 'SeekCommand', 'DriftCommand',
    'ForceSyncCommand', 'RoomStateCommand', 'RequestStateCommand',
  ];

  for (const name of commandFiles) {
    assert.ok(exists(`src/background/commands/${name}.js`), `missing ${name}.js`);
    assert.match(engine, new RegExp(`commands/${name}\\.js`), `${name} not imported`);
  }
});

test('every wire command type has a client-side counterpart', () => {
  // The background deserializes a command, then the content script
  // deserializes it again from its own registry. A type present in one and
  // absent from the other is dropped after travelling the whole way.
  const content = readFileSync(
    resolve(extensionRoot, 'src/content/commands/ContentCommands.js'),
    'utf8'
  );

  for (const type of ['PLAY', 'PAUSE', 'SEEK', 'DRIFT', 'FORCE_SYNC', 'ROOM_STATE']) {
    assert.match(content, new RegExp(`\\['${type}',`), `${type} missing from client registry`);
  }
});
