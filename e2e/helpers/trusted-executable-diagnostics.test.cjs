'use strict';

if (process.argv.includes('--test') || process.env.NODE_TEST_CONTEXT) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path').posix;
  const vm = require('node:vm');
  const { test } = require('node:test');
  const source = fs.readFileSync(require('node:path').join(__dirname, 'fee-revenue-egress.cjs'), 'utf8');
  // Exercise the actual private lookup with authored filesystem outcomes only.
  const roots = source.match(/^const TRUSTED_DIRS = .+;$/m)[0];
  const inside = source.slice(source.indexOf('function inside('), source.indexOf('function pinned('));
  const lookup = source.slice(source.indexOf('function trustedExec('), source.indexOf('function verifyExec('));
  const createLookup = (realpathSync, sha256File) => vm.runInNewContext(`${roots}\n${inside}\n${lookup}\ntrustedExec`, { path, fs: { realpathSync }, sha256File });

  test('trusted lookup retains rejected realpath and OS causes without accepting them', () => {
    const hashed = [];
    const find = createLookup(file => {
      if (file === '/usr/bin/sudo') return '/usr/lib/cargo/bin/sudo';
      if (file === '/sbin/sudo') return '/usr/bin/sudo';
      throw Object.assign(new Error('private error text must not escape'), { code: file === '/bin/sudo' ? 'EACCES' : 'ENOENT' });
    }, file => {
      hashed.push(file);
      throw Object.assign(new Error('private hash error text'), { code: 'EIO' });
    });
    assert.throws(() => find('sudo'), error => {
      assert.match(error.message, /trusted executable missing: sudo/);
      assert.match(error.message, /\/usr\/lib\/cargo\/bin\/sudo/);
      for (const code of ['ENOENT', 'EACCES', 'EIO']) assert(error.message.includes(code), code);
      assert(!error.message.includes('private'));
      assert(error.message.length < 2048);
      return true;
    });
    assert.deepEqual(hashed, ['/usr/bin/sudo'], 'An untrusted resolved target must never be read or hashed');
  });

  test('trusted lookup preserves successful pinned resolution', () => {
    const find = createLookup(() => '/usr/bin/sudo', file => {
      assert.equal(file, '/usr/bin/sudo');
      return 'a'.repeat(64);
    });
    const result = find('sudo');
    assert.equal(result.path, '/usr/bin/sudo');
    assert.equal(result.sha256, 'a'.repeat(64));
  });

  test('trusted lookup redacts non-system targets and never hashes them', () => {
    const find = createLookup(() => '/home/authored-private/sudo', () => assert.fail('Untrusted target was read'));
    assert.throws(() => find('sudo'), error => {
      assert(error.message.includes('redacted non-system target'));
      assert(!error.message.includes('/home/'));
      return true;
    });
  });
}
