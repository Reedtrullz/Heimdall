'use strict';

/**
 * Node 22 stdlib checks for the offline fee-demand fixture and egress guard.
 * Run with: node --test e2e/helpers/fee-revenue-egress.test.cjs
 *
 * The file stays inert when Playwright's ordinary suite discovers it: cases
 * are only registered under the Node test runner.
 */

const RUNS_UNDER_NODE_TEST = process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);

if (!RUNS_UNDER_NODE_TEST) {
  module.exports = { registersUnderNodeTest: false };
} else {
  register();
}

function register() {
  const assert = require('node:assert/strict');
  const http = require('node:http');
  const net = require('node:net');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { after, before, test } = require('node:test');
  const egress = require('./fee-revenue-egress.cjs');

  const rawConnect = net.connect;
  let fixture;
  let allow;
  let unboundPort;

  function denial(run) {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new assert.AssertionError({ message: 'expected the egress guard to deny this call' });
  }

  before(async () => {
    const modulePath = pathToFileURL(path.join(__dirname, 'fee-revenue-fixture.ts')).href;
    const fixtureModule = await import(modulePath);
    fixture = await fixtureModule.startFeeRevenueFixture();
    allow = [`127.0.0.1:${fixture.port}`, `localhost:${fixture.port}`];
    egress.install(allow);

    const throwaway = net.createServer();
    await new Promise((resolve) => throwaway.listen(0, '127.0.0.1', resolve));
    unboundPort = throwaway.address().port;
    await new Promise((resolve) => throwaway.close(resolve));
  });

  after(async () => {
    egress.uninstall();
    if (fixture) await fixture.close().catch(() => {});
  });

  test('real HTTP fixture serves authored earnings and counts upstream work', { timeout: 10000 }, async () => {
    fixture.reset();
    const response = await fetch(`${fixture.origin}/midgard-primary/v2/history/earnings?interval=day&count=30`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(Buffer.byteLength(text), 538);
    const body = JSON.parse(text);
    assert.equal(body.intervals.length, 1);
    assert.equal(body.intervals[0].liquidityFees, '100000000');

    const snapshot = fixture.snapshot();
    assert.equal(snapshot.attempts['midgard:v2/history/earnings'], 1);
    assert.equal(snapshot.upstreamBytes, 538);
    assert.equal(snapshot.bytesByKey['midgard:v2/history/earnings'], 538);
    assert.equal(snapshot.seed, 46);
  });

  test('authority allowlist mutation denies the adjacent port before connect', { timeout: 10000 }, () => {
    const error = denial(() => fetch(`http://127.0.0.1:${unboundPort}/`));
    assert.equal(error.code, 'FEE_EGRESS_DENIED');
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${unboundPort}`));
    assert.deepEqual([...egress.parseAllowList('127.0.0.1:123, nope, x:0')], ['127.0.0.1:123']);
    assert.equal(egress.isAllowed('127.0.0.1', fixture.port), true);
  });

  test('both positive addresses have a real mainnet bech32 checksum and 20-byte payload', async () => {
    const { FEE_ADDRESS_A, FEE_ADDRESS_B } = await import(pathToFileURL(path.join(__dirname, 'fee-revenue-fixture.ts')).href);
    // BIP-173 polymod, independent of the fixture and the application's validator.
    const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    function checksum(address) {
      assert.match(address, /^thor1[ac-hj-np-z02-9]{38}$/);
      const values = [...'thor'].map(c => c.charCodeAt(0) >> 5).concat(0, [...'thor'].map(c => c.charCodeAt(0) & 31), [...address.slice(5)].map(c => alphabet.indexOf(c)));
      let check = 1;
      for (const value of values) {
        const top = check >>> 25;
        check = ((check & 0x1ffffff) << 5) ^ value;
        for (let bit = 0; bit < 5; bit++) if ((top >>> bit) & 1) check ^= [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3][bit];
      }
      return check >>> 0;
    }
    assert.equal(checksum(FEE_ADDRESS_A), 1);
    assert.equal(checksum(FEE_ADDRESS_B), 1);
    assert.notEqual(FEE_ADDRESS_A, FEE_ADDRESS_B);
  });

  test('number, string and options socket forms follow the allowlist', { timeout: 10000 }, () => {
    assert.equal(denial(() => net.connect(unboundPort)).code, 'FEE_EGRESS_DENIED');
    assert.equal(denial(() => net.connect(`127.0.0.1:${unboundPort}`)).code, 'FEE_EGRESS_DENIED');
    assert.equal(denial(() => net.connect({ host: '127.0.0.1', port: unboundPort })).code, 'FEE_EGRESS_DENIED');
    assert.equal(denial(() => net.connect('/tmp/fee-demand.sock')).code, 'FEE_EGRESS_DENIED');

    const socket = net.connect({ host: '127.0.0.1', port: fixture.port });
    assert.equal(socket.connecting, true);
    socket.destroy();
  });

  test('external host fetch and DNS lookups are denied', { timeout: 10000 }, async () => {
    assert.equal(denial(() => fetch('http://example.com/')).code, 'FEE_EGRESS_DENIED');
    const dnsError = await new Promise((resolve) => {
      require('node:dns').lookup('example.com', (error) => resolve(error));
    });
    assert.equal(dnsError.code, 'FEE_EGRESS_DENIED');
    assert.equal(denial(() => http.get('http://example.com/')).code, 'FEE_EGRESS_DENIED');
  });

  test('HTTPS egress is denied', { timeout: 10000 }, () => {
    const error = denial(() => fetch(`https://127.0.0.1:${fixture.port}/`));
    assert.equal(error.code, 'FEE_EGRESS_DENIED');
    assert.match(error.message, /protocol https:/);
  });

  test('fixture modes expose malformed bodies, 429 Retry-After and 503 truthfully', { timeout: 10000 }, async () => {
    const url = `${fixture.origin}/midgard-primary/v2/history/earnings`;

    fixture.setMode('malformed');
    const malformed = await fetch(url);
    assert.equal(malformed.status, 200);
    const malformedText = await malformed.text();
    assert.throws(() => JSON.parse(malformedText), /JSON/);

    fixture.setMode('rate-limit');
    const limited = await fetch(url);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '2');

    fixture.setMode('source-failure');
    const failing = await fetch(url);
    assert.equal(failing.status, 503);

    fixture.setMode('stale');
    const stale = await fetch(url);
    assert.deepEqual((await stale.json()).intervals, []);

    fixture.setMode('ok');
  });

  test('205 responses retain exact aggregate counts and bytes beyond the detail cap', { timeout: 10000 }, async () => {
    fixture.reset();
    for (let index = 0; index < 205; index += 1) {
      const response = await fetch(`${fixture.origin}/midgard-primary/v2/history/earnings`);
      assert.equal(response.status, 200);
      assert.equal((await response.arrayBuffer()).byteLength, 538);
    }
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.total, 205);
    assert.equal(snapshot.attempts['midgard:v2/history/earnings'], 205);
    assert.equal(snapshot.upstreamBytes, 110290);
    assert.equal(snapshot.bytesByKey['midgard:v2/history/earnings'], 110290);
    assert.equal(snapshot.requests.length, 200);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.limitExceeded, false);
  });

  test('positive Portfolio consumers and every unknown prefix path remain observable', { timeout: 10000 }, async () => {
    fixture.reset();
    const get = async (path) => {
      const response = await fetch(`${fixture.origin}${path}`);
      assert.equal(response.status, 200, path);
      return response.json();
    };
    const nodes = await get('/thornode/thorchain/nodes');
    assert.equal(nodes[0].total_bond, '2500000000000');
    assert.equal(nodes[0].bond_providers.providers[0].bond, '1250000000000');
    assert.equal((await get('/midgard-primary/v2/health')).lastThorNode.height, 12345678);
    assert.equal((await get('/midgard-primary/v2/pools'))[0].asset, 'BTC.BTC');
    assert.equal((await get('/midgard-primary/v2/member/thor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq4yeyjz')).pools[0].liquidityUnits, '1000');
    assert.equal((await get('/midgard-primary/v2/history/rune')).intervals[0].runePriceUSD, '1.50');
    let unknownBytes = 0;
    for (const path of ['/unknown', '/midgard-primary/v2/not-authored', '/thornode/thorchain/not-authored']) {
      const response = await fetch(`${fixture.origin}${path}`);
      assert.equal(response.status, 404);
      unknownBytes += (await response.arrayBuffer()).byteLength;
    }
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.unhandled, 3);
    assert.equal(snapshot.requests.filter(entry => entry.kind === 'unhandled').reduce((sum, entry) => sum + entry.bytes, 0), unknownBytes);
  });

  test('clock stays fixed across real HTTP and advances only on owned control', { timeout: 10000 }, async () => {
    fixture.reset();
    await (await fetch(`${fixture.origin}/midgard-primary/v2/history/earnings`)).text();
    assert.equal(fixture.snapshot().requests[0].at, 1792972800000);
    const advance = await fetch(`${fixture.origin}/-/advance`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ms: 300000 }),
    });
    assert.equal(advance.status, 200);
    await (await fetch(`${fixture.origin}/midgard-primary/v2/history/earnings`)).text();
    assert.equal(fixture.snapshot().requests[1].at, 1792973100000);
    assert.equal(fixture.snapshot().clock, '2026-10-26T00:05:00.000Z');
    assert.throws(() => fixture.advance(-1), /invalid clock advance/);
    fixture.reset();
  });

  test('guard deletion control denies then reaches the same owned forbidden authority', { timeout: 10000 }, async () => {
    egress.install([]);
    assert.equal(denial(() => net.connect({ host: '127.0.0.1', port: fixture.port })).code, 'FEE_EGRESS_DENIED');
    egress.uninstall();
    const socket = rawConnect({ host: '127.0.0.1', port: fixture.port });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.destroy();
    egress.install(allow);
  });

  test('frozen input identity rejects misleading labels, missing identity and dirty artifacts', { timeout: 10000 }, () => {
    const fs = require('node:fs');
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'fee-input-'));
    const artifact = path.join(root, 'artifact');
    fs.mkdirSync(path.join(artifact, '.next'), { recursive: true });
    fs.writeFileSync(path.join(artifact, 'server.js'), 'immutable helper control only');
    fs.writeFileSync(path.join(artifact, '.next/BUILD_ID'), 'helper-control');
    for (const file of [path.join(artifact, 'server.js'), path.join(artifact, '.next/BUILD_ID')]) fs.chmodSync(file, 0o444);
    fs.chmodSync(path.join(artifact, '.next'), 0o555);fs.chmodSync(artifact, 0o555);
    const input = { label: 'baseline', phase: 'baseline', artifact, revision: 'a'.repeat(40),
      artifactSha256: egress.artifactDigest(artifact), runtime: process.version, clock: egress.CLOCK_EPOCH,
      instrumentation: egress.digest(egress.INSTRUMENTATION.map(file => path.join(process.cwd(), file))) };
    try {
      assert.equal(egress.validateInputs([input]).length, 1);
      assert.throws(() => egress.validateInputs([{ ...input, revision: undefined }]), /identity/);
      assert.throws(() => egress.validateInputs([{ ...input, label: 'candidate' }]), /label/);
      assert.throws(() => egress.validateInputs([input, { ...input, label: 'candidate', phase: 'candidate', revision: 'b'.repeat(40) }]), /duplicate/);
      fs.chmodSync(path.join(artifact, 'server.js'), 0o644);
      assert.throws(() => egress.validateInputs([input]), /read-only/);
      fs.writeFileSync(path.join(artifact, 'server.js'), 'dirty');
      assert.throws(() => egress.validateInputs([input]), /stale or dirty/);
    } finally {
      fs.chmodSync(artifact, 0o755);fs.chmodSync(path.join(artifact, '.next'), 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('shared Node clock advances Date and the actual interval scheduler', { timeout: 10000 }, () => {
    const fs = require('node:fs');
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'fee-clock-'));
    const file = path.join(root, 'clock');fs.writeFileSync(file, String(egress.CLOCK_EPOCH));
    const script = 'const a=require("node:assert/strict"),fs=require("node:fs"),realTimeout=setTimeout;const g=require(process.argv[1]);const restore=g.installClock(process.argv[2]);let hits=0;setInterval(()=>hits++,300000);fs.writeFileSync(process.argv[2],String(g.CLOCK_EPOCH+300000));realTimeout(()=>{try{a.equal(Date.now(),g.CLOCK_EPOCH+300000);a.equal(hits,1);restore();console.log("controlled interval PASS")}catch(e){restore();throw e}},50)';
    try {
      const result = require('node:child_process').spawnSync(process.execPath, ['-e', script, path.join(__dirname, 'fee-revenue-egress.cjs'), file], {
        cwd: process.cwd(), timeout: 2000, maxBuffer: 1048576, encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /controlled interval PASS/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('pending request cancellation counts the actual attempt without invented response bytes', { timeout: 10000 }, async () => {
    fixture.reset();fixture.setMode('pending');
    const controller = new AbortController();
    const request = fetch(`${fixture.origin}/midgard-primary/v2/history/earnings`, { signal: controller.signal }).catch(error => error);
    const start = Date.now();
    while (!fixture.snapshot().pending && Date.now() - start < 1000) await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.snapshot().pending, 1);
    controller.abort();await request;
    const cancelledAt = Date.now();
    while (fixture.snapshot().pending && Date.now() - cancelledAt < 1000) await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.snapshot().pending, 0);
    assert.equal(fixture.snapshot().upstreamBytes, 0);
    const released = await fetch(`${fixture.origin}/-/release`, { method: 'POST' });await released.text();
    assert.equal(fixture.snapshot().total, 1);
    assert.equal(fixture.snapshot().pending, 0);
    fixture.setMode('ok');fixture.reset();
  });

  test('standalone inputs allow contained read-only dependency links and reject escapes', () => {
    const fs = require('node:fs');
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'fee-links-'));
    const artifact = path.join(root, 'artifact');
    fs.mkdirSync(path.join(artifact, '.next'), { recursive: true });
    fs.writeFileSync(path.join(artifact, 'server.js'), 'authored inert server');
    fs.writeFileSync(path.join(artifact, '.next/BUILD_ID'), 'authored-build');
    fs.symlinkSync('server.js', path.join(artifact, 'dependency.js'));
    fs.writeFileSync(path.join(root, 'outside'), 'authored outside canary');
    for (const file of ['server.js', '.next/BUILD_ID']) fs.chmodSync(path.join(artifact, file), 0o444);
    fs.chmodSync(path.join(artifact, '.next'), 0o555);fs.chmodSync(artifact, 0o555);
    try {
      const input = { label: 'baseline', phase: 'baseline', artifact, revision: 'a'.repeat(40),
        artifactSha256: egress.artifactDigest(artifact), runtime: process.version, clock: egress.CLOCK_EPOCH,
        instrumentation: egress.digest(egress.INSTRUMENTATION.map(file => path.join(process.cwd(), file))) };
      assert.equal(egress.validateInputs([input]).length, 1);
      fs.chmodSync(artifact, 0o755);fs.unlinkSync(path.join(artifact, 'dependency.js'));
      fs.symlinkSync('../outside', path.join(artifact, 'dependency.js'));
      assert.throws(() => egress.artifactDigest(artifact), /outside|escape/);
    } finally {
      fs.chmodSync(artifact, 0o755);fs.chmodSync(path.join(artifact, '.next'), 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function observationRows() {
    const counters = () => ({ browserRequests: {}, browserBytes: {}, attempts: {}, bytesByKey: {}, total: 0, upstreamBytes: 0, pending: 0, unhandled: 0 });
    const ui = () => ({ route: '/dashboard/portfolio', summary: 'authored total', health: 'authored health', checks: 'authored checks', diagnosis: null, fees: [], errors: [], loading: 0 });
    return egress.EXPECTED_SCENARIOS.map(id => {
      const action = id.split('/')[1], before = counters(), after = counters();
      const subscriber = ['subscriber-mount', 'primary-close', 'subscriber-focus', 'subscriber-300s'].includes(action) ? ui() : null;
      if (['refresh-300s', 'focus', 'reconnect', 'manual-global', 'subscriber-focus', 'subscriber-300s'].includes(action)) {
        const key = (action.startsWith('subscriber-') ? 'independent:' : 'primary:') + '/api/midgard/v2/history/earnings';
        after.browserRequests[key] = 1;
      }
      const http = /-(direct|failed)$/.test(action) ? { status: 200, retryAfter: null, bytes: 10 } : null;
      return { id, population: /^(stale|malformed|source-failure|rate-limit)-/.test(action) ? 'error' : 'happy', before, after, clocks: { fixture: egress.CLOCK_EPOCH, browser: egress.CLOCK_EPOCH, server: egress.CLOCK_EPOCH }, outcome: { ...ui(), subscriber, http } };
    });
  }

  test('complete observation contract rejects malformed UI, counter maps and missing action work', () => {
    assert.equal(egress.validateObservations(observationRows()).length, egress.EXPECTED_SCENARIOS.length);
    const mutate = fn => { const rows = observationRows(); fn(rows); return () => egress.validateObservations(rows); };
    assert.throws(mutate(rows => { rows[0].outcome.summary = {}; }), /outcome|UI/);
    assert.throws(mutate(rows => { rows[0].after.browserRequests = 1; }), /counter/);
    assert.throws(mutate(rows => { delete rows[0].outcome.subscriber; }), /outcome|subscriber/);
    assert.throws(mutate(rows => { rows.find(row => row.id === 'desktop/focus').after.browserRequests = {}; }), /action|attribut/);
    assert.throws(mutate(rows => { rows.find(row => row.id === 'desktop/subscriber-mount').outcome.subscriber = null; }), /subscriber/);
    assert.throws(mutate(rows => { rows.find(row => row.id === 'desktop/rate-limit-direct').outcome.http = null; }), /HTTP|http/);
    assert.throws(mutate(rows => { rows[0].clocks.server += 1; }), /clock/);
    assert.throws(mutate(rows => { delete rows[0].clocks; }), /clock/);
    assert.throws(() => egress.validateObservations(observationRows().slice(1)), /population/);
  });

  test('active browser artifacts count toward the artifact envelope before retention', { timeout: 10000 }, async () => {
    const fs = require('node:fs');
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'fee-artifacts-'));
    const scratch = path.join(root, 'runtime');fs.mkdirSync(scratch);
    const script = 'const fs=require("node:fs"),p=require("node:path");const dir=p.join(process.argv[1],"artifacts");fs.mkdirSync(dir);fs.writeFileSync(p.join(dir,"body"),Buffer.alloc(65537));setTimeout(()=>{},500)';
    try {
      const result = await egress.runOwned({ cwd: process.cwd(), args: ['-e', script, scratch], env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch }, scratch, output: root, artifactLimit: 65536, timeoutMs: 2000 });
      assert.match(result.reason ?? '', /artifact bound/);
      assert(result.peakArtifacts >= 65537);
      assert.equal(result.clean, true);
      assert(result.processes.length > 0 && result.processes.every(p => p.absent));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  async function ownedControl(script, verify, extraEnv = {}, limits = {}) {
    const fs = require('node:fs');
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'fee-owned-'));
    const scratch = path.join(root, 'runtime');fs.mkdirSync(scratch);
    try {
      const result = await egress.runOwned({ cwd: process.cwd(), args: ['-e', script], env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, ...extraEnv }, scratch, output: root, timeoutMs: limits.timeoutMs ?? 1000, streamLimit: limits.streamLimit, scratchLimit: limits.scratchLimit });
      process.stdout.write('# owned-control ' + JSON.stringify({ ...result, stdout: undefined }) + '\n');
      await verify(result);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  test('real detached HTTP descendant and its listener are absent after parent exit', { timeout: 10000 }, async () => {
    const childScript = 'const http=require("node:http");http.createServer((q,r)=>r.end("owned")).listen(0,"127.0.0.1");setInterval(()=>{},1000)';
    const script = 'require("node:child_process").spawn(process.execPath,["-e",' + JSON.stringify(childScript) + '],{detached:true,stdio:"ignore",env:process.env});setTimeout(()=>process.exit(0),300)';
    await ownedControl(script, result => {
      assert.equal(result.reason, null);
      assert.equal(result.clean, true);
      assert(result.processes.length >= 2 && result.processes.every(p => p.absent));
      assert.equal(result.ports.length, 1);
      assert.equal(result.ports[0].refused, true);
    });
  });

  test('malformed ownership returns a finite failed receipt and still reaps its owned root', { timeout: 10000 }, async () => {
    const script = 'setTimeout(()=>require("node:fs").appendFileSync(process.env.FEE_OWNERSHIP_FILE,"{\\n"),300);setInterval(()=>{},1000)';
    await ownedControl(script, result => {
      assert.match(result.reason ?? '', /ownership|JSON/);
      assert.equal(result.clean, false);
      assert(result.processes.length > 0 && result.processes.every(p => p.absent));
    });
  });

  test('an ownership claim cannot authorize signalling an unrelated authored process', { timeout: 10000 }, async () => {
    const cp = require('node:child_process');
    const unrelated = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const ended = new Promise(resolve => unrelated.once('exit', resolve));
    const birth = egress.processTable().find(row => row.pid === unrelated.pid);
    assert(birth);
    const script = 'setTimeout(()=>require("node:fs").appendFileSync(process.env.FEE_OWNERSHIP_FILE,JSON.stringify({pid:Number(process.env.UNRELATED_PID),ppid:process.pid})+"\\n"),300);setInterval(()=>{},1000)';
    try {
      await ownedControl(script, result => {
        assert.match(result.reason ?? '', /unowned|ownership/);
        assert.equal(result.clean, false);
        assert(egress.processTable().some(row => row.pid === birth.pid && row.start === birth.start), 'unrelated authored process must remain alive');
      }, { UNRELATED_PID: String(unrelated.pid) });
    } finally { unrelated.kill('SIGTERM');await ended; }
  });

  test('process-table failure still closes the owned child and returns an honest failed receipt', { timeout: 10000 }, async () => {
    const cp = require('node:child_process'), original = cp.execFileSync;
    cp.execFileSync = function(command, ...args) {
      if (command === 'ps') throw new Error('authored process table unavailable');
      return original.call(this, command, ...args);
    };
    try {
      await ownedControl('setInterval(()=>{},1000)', result => {
        assert.match(result.reason ?? '', /process table unavailable/);
        assert.equal(result.clean, false);
        assert.equal(result.rootClosed, true);
      });
    } finally { cp.execFileSync = original; }
  });

  test('the larger browser envelope rejects a non-browser invocation', async () => {
    await assert.rejects(egress.runOwned({ profile: 'fee-demand-browser-v1',
      approval: '781cd061013ec6227385fb3b8b6a29766df50747a867e537c41ab6f9480472c3',
      args: ['-e', 'throw new Error("must never start")'] }), /unapproved browser resource invocation/);
  });

  for (const [name, script, limits, reason] of [
    ['stream', 'process.stdout.write(Buffer.alloc(2048));setInterval(()=>{},1000)', { streamLimit: 1024 }, /stream bound/],
    ['scratch', 'require("node:fs").writeFileSync(require("node:path").join(process.env.HOME,"spill"),Buffer.alloc(65537));setInterval(()=>{},1000)', { scratchLimit: 32768 }, /scratch bound/],
    ['timeout', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)', { timeoutMs: 2000 }, /invocation bound/],
  ]) {
    test('real ' + name + ' limit rejects work and reaps its owned process', { timeout: 10000 }, async () => {
      await ownedControl(script, result => {
        assert.match(result.reason ?? '', reason);
        assert.equal(result.clean, true);
        assert.equal(result.rootClosed, true);
        assert(result.processes.length > 0 && result.processes.every(p => p.absent));
      }, {}, limits);
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    test('real ' + signal + ' interruption retains a cleanup receipt', { timeout: 10000 }, () => {
      const fs = require('node:fs');
      const root = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'fee-interrupt-'));
      const scratch = path.join(root, 'runtime');fs.mkdirSync(scratch);
      const child = 'setTimeout(()=>process.kill(process.ppid,' + JSON.stringify(signal) + '),300);setInterval(()=>{},1000)';
      const controller = 'const g=require(process.argv[1]);g.runOwned({cwd:process.cwd(),args:["-e",process.argv[4]],env:{PATH:process.env.PATH,HOME:process.argv[2],TMPDIR:process.argv[2]},scratch:process.argv[2],output:process.argv[3],timeoutMs:2000}).then(r=>{console.log(JSON.stringify(r));if(!r.rootClosed||!r.clean)process.exitCode=1}).catch(e=>{console.error(e);process.exitCode=1})';
      try {
        const run = require('node:child_process').spawnSync(process.execPath, ['-e', controller, path.join(__dirname, 'fee-revenue-egress.cjs'), scratch, root, child], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch }, encoding: 'utf8', timeout: 4000, maxBuffer: 1048576 });
        assert.equal(run.status, 0, run.stderr);
        const result = JSON.parse(run.stdout);
        process.stdout.write('# interrupted-control ' + JSON.stringify({ ...result, stdout: undefined }) + '\n');
        assert.equal(result.reason, signal);
        assert(result.processes.length > 0 && result.processes.every(p => p.absent));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('pair checks reject changed adverse outcomes, shared caches and unstable repetitions', () => {
    const run = (label, index) => {
      const rows = observationRows();
      for (const row of rows.filter(row => row.id.endsWith('/closed-valid'))) {
        row.after.browserRequests['primary:/api/midgard/v2/history/earnings'] = label === 'baseline' ? 1 : 0;
      }
      const target = { label, phase: label, revision: (label === 'baseline' ? 'a' : 'b').repeat(40), artifactSha256: (label === 'baseline' ? 'c' : 'd').repeat(64), instrumentation: 'e'.repeat(64) };
      return { target, runtime: { label, phase: label, pid: 100 + index, fixturePid: 200 + index, processStart: 'authored-' + index, cache: 'authored-cache-' + index, invocation: 'authored-invocation-' + index, artifactSha256: target.artifactSha256, instrumentation: target.instrumentation, runtime: process.version, clock: egress.CLOCK_EPOCH, revision: target.revision }, observations: rows };
    };
    assert.doesNotThrow(() => egress.compareRuns([run('baseline', 0), run('candidate', 1)], true));
    const changed = run('candidate', 1);
    changed.observations.find(row => row.id === 'mobile/source-failure-failed').outcome.errors = ['authored different failure'];
    assert.throws(() => egress.compareRuns([run('baseline', 0), changed], true), /outcomes changed/);
    const shared = run('candidate', 1);shared.runtime.cache = 'authored-cache-0';
    assert.throws(() => egress.compareRuns([run('baseline', 0), shared], true), /shared process\/cache/);
    const mislabeled = run('candidate', 1);mislabeled.runtime.label = 'baseline';
    assert.throws(() => egress.compareRuns([run('baseline', 0), mislabeled], true), /runtime identity/);
    const unstable = run('baseline', 2);unstable.observations[0].outcome.summary = 'authored drift';
    assert.throws(() => egress.compareRuns([run('baseline', 0), unstable], false), /repetition instability/);
  });

  test('prelaunch identity failure creates no orphan and preserves the primary error', async () => {
    const fs = require('node:fs'), cp = require('node:child_process'), Module = require('node:module');
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'fee-prelaunch-'));
    const artifact = path.join(root, 'artifact'), output = path.join(root, 'output'), inputFile = path.join(root, 'input.json');
    fs.mkdirSync(path.join(artifact, '.next'), { recursive: true });
    fs.writeFileSync(path.join(artifact, 'server.js'), 'inert authored artifact; never executed');
    fs.writeFileSync(path.join(artifact, '.next/BUILD_ID'), 'authored');
    for (const file of ['server.js', '.next/BUILD_ID']) fs.chmodSync(path.join(artifact, file), 0o444);
    fs.chmodSync(path.join(artifact, '.next'), 0o555);fs.chmodSync(artifact, 0o555);
    const target = { label: 'baseline', phase: 'baseline', artifact, revision: 'a'.repeat(40), artifactSha256: egress.artifactDigest(artifact), runtime: process.version, clock: egress.CLOCK_EPOCH, instrumentation: egress.digest(egress.INSTRUMENTATION.map(file => path.join(process.cwd(), file))) };
    fs.writeFileSync(inputFile, JSON.stringify([target]));
    const priorOutput = process.env.FEE_DEMAND_OUTPUT, exec = cp.execFileSync, resolve = Module._resolveFilename;
    process.env.FEE_DEMAND_OUTPUT = output;
    try {
      cp.execFileSync = function(command, ...args) { if (command === 'git') throw new Error('authored initial identity failure');return exec.call(this, command, ...args); };
      await assert.rejects(egress.nativeRun(inputFile), /authored initial identity failure/);
      assert(!fs.readdirSync(output).some(name => name.startsWith('owned-')), 'identity failure must precede owned runtime allocation');
      let gitReads = 0;
      cp.execFileSync = function(command, ...args) { if (command === 'git' && ++gitReads > 1) throw new Error('authored final identity failure');return exec.call(this, command, ...args); };
      Module._resolveFilename = function(request, ...args) { if (request === '@playwright/test/cli') throw new Error('authored primary prelaunch failure');return resolve.call(this, request, ...args); };
      await assert.rejects(egress.nativeRun(inputFile), /authored primary prelaunch failure/);
      assert(!fs.readdirSync(output).some(name => name.startsWith('owned-')));
      const receipt = JSON.parse(fs.readFileSync(path.join(output, 'native-cleanup.json'), 'utf8'));
      assert.match(receipt.primaryError, /authored primary prelaunch failure/);
      assert.match(receipt.identityError, /authored final identity failure/);
      assert.equal(receipt.removed, true);
    } finally {
      cp.execFileSync = exec;Module._resolveFilename = resolve;
      if (priorOutput === undefined) delete process.env.FEE_DEMAND_OUTPUT;else process.env.FEE_DEMAND_OUTPUT = priorOutput;
      fs.chmodSync(artifact, 0o755);fs.chmodSync(path.join(artifact, '.next'), 0o755);fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // H7: every fixture directory is registered; teardown removes exactly these after containment, symlink and open-handle checks.
  const made = [];
  const mk = (prefix) => { const dir = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), prefix)); made.push(dir); return dir; };
  after(() => {
    const fs = require('node:fs'), cp = require('node:child_process'), base = fs.realpathSync(require('node:os').tmpdir());
    for (const dir of made) {
      if (!fs.existsSync(dir)) continue;
      const real = fs.realpathSync(dir);
      assert(path.dirname(real) === base && /^fee-/.test(path.basename(real)) && !fs.lstatSync(dir).isSymbolicLink(), 'owned fixture directory containment: ' + dir);
      assert.equal(cp.spawnSync('lsof', ['-t', '+D', real], { stdio: 'ignore' }).status, 1, 'open handles under ' + dir);
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
  const APPROVAL = '781cd061013ec6227385fb3b8b6a29766df50747a867e537c41ab6f9480472c3';
  const execFor = (sudo) => {
    const sha = (file) => require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(file)).digest('hex');
    return Object.fromEntries(['sudo', 'unshare', 'bash', 'kill', 'python3'].map((name) => {
      const file = name === 'sudo' ? sudo : name === 'kill' ? '/bin/kill' : '/bin/sh';
      return [name, { path: file, sha256: sha(file) }];
    }));
  };
  function nsConfig(root) {
    const fs = require('node:fs'), crypto = require('node:crypto');
    const cli = path.join(root, 'cli.js'), browsers = path.join(root, 'browsers'), artifact = path.join(root, 'artifact');
    fs.mkdirSync(browsers); fs.mkdirSync(artifact);
    fs.writeFileSync(cli, 'cli'); fs.writeFileSync(path.join(browsers, 'chrome'), 'browser'); fs.writeFileSync(path.join(artifact, 'server.js'), 'server');
    const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return {
      nonce: 'n'.repeat(32), guardSha256: egress.GUARD_SCRIPT_SHA256, size: '62m', approval: APPROVAL, limit: 105, cwd: process.cwd(), home: path.join(root, 'home'),
      hostNs: { net: 'net:[1]', mnt: 'mnt:[1]', pid: 'pid:[1]' },
      exec: Object.fromEntries(['sudo', 'unshare', 'bash', 'kill', 'python3'].map((name) => [name, { path: '/usr/bin/' + name, sha256: '0'.repeat(64) }])),
      node: { path: process.execPath, sha256: sha(process.execPath) }, cli: { path: cli, sha256: sha(cli) },
      browser: { path: browsers, sha256: egress.artifactDigest(browsers) }, browsers, artifact, artifactSha256: egress.artifactDigest(artifact),
      instrumentation: egress.digest(egress.INSTRUMENTATION.map(file => path.join(process.cwd(), file))), target: {},
    };
  }

  test('namespace identity rejects stale executable, browser, artifact, nonce and guard state', { timeout: 30000 }, () => {
    const fs = require('node:fs'), os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-ns-'));
    try {
      const cases = {
        cli: config => fs.appendFileSync(config.cli.path, 'x'),
        browser: config => fs.appendFileSync(path.join(config.browser.path, 'chrome'), 'x'),
        artifact: config => fs.appendFileSync(path.join(config.artifact, 'server.js'), 'x'),
        instrumentation: config => { config.instrumentation = '0'.repeat(64); },
      };
      const good = nsConfig(fs.mkdtempSync(path.join(root, 'ok-')));
      egress.checkIdentity(good, egress.identityReadback(good));
      assert.throws(() => egress.checkIdentity(good, { ...egress.identityReadback(good), nonce: 'other' }), /stale or changed/);
      assert.throws(() => egress.checkIdentity(good, { ...egress.identityReadback(good), guardSha256: '0'.repeat(64) }), /stale or changed/);
      assert.throws(() => egress.checkIdentity(good, { forged: true }), /stale or changed/);
      for (const [name, mutate] of Object.entries(cases)) {
        const config = nsConfig(fs.mkdtempSync(path.join(root, name + '-')));
        mutate(config);
        assert.throws(() => egress.checkIdentity(config, egress.identityReadback(config)), /stale or changed/, name);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('namespace boundary readback rejects every weakened mask, privilege, write or network state', () => {
    const zero = '0000000000000000';
    const sha = 'a'.repeat(64), host = { ns: { net: 'net:[1]', mnt: 'mnt:[1]', pid: 'pid:[1]' }, configSha256: sha };
    const good = { uid: 1000, noNewPrivs: '1', caps: [zero, zero, zero, zero, zero], checkoutWrite: 'EROFS', artifactWrite: 'EROFS', tmpWrite: 'WRITABLE', interfaces: ['lo'],
      homeUnexpected: [], vault: 'ABSENT', gitEntries: 0, ns: { net: 'net:[2]', mnt: 'mnt:[2]', pid: 'pid:[2]' }, configSha256: sha };
    egress.checkBoundary(good, host);
    // homeEntries===0 cannot hold once the declared root is restored under the masked home (H3); leaks are the unexpected entries instead.
    for (const bad of [{ uid: 0 }, { noNewPrivs: '0' }, { caps: [zero, zero, '0000000000000001', zero, zero] }, { checkoutWrite: 'WRITABLE' },
      { artifactWrite: 'WRITABLE' }, { tmpWrite: 'EROFS' }, { interfaces: ['lo', 'eth0'] }, { homeUnexpected: ['.ssh'] }, { homeUnexpected: undefined }, { vault: 'PRESENT' }, { gitEntries: 3 }, { caps: undefined },
      { ns: { ...host.ns } }, { ns: { ...good.ns, net: host.ns.net } }, { ns: undefined }, { configSha256: 'b'.repeat(64) }]) {
      assert.throws(() => egress.checkBoundary({ ...good, ...bad }, host), /boundary/, JSON.stringify(bad));
    }
    assert.throws(() => egress.checkBoundary(good), /boundary/);
  });

  test('namespace argv is frozen to the guard bytes, pinned executables and the 16 MiB default, 62+2 MiB browser total and 105 s bounds', () => {
    const crypto = require('node:crypto');
    const config = nsConfig(mk('fee-ns-'));
    const argv = egress.frozenArgv(config, '/scratch/x', 1000, 1001);
    assert.deepEqual(argv.slice(0, 11), [config.exec.sudo.path, '-n', config.exec.unshare.path, '--net', '--mount', '--pid', '--fork', '--kill-child', '--mount-proc', config.exec.bash.path, '-c']);
    assert.equal(crypto.createHash('sha256').update(argv[11]).digest('hex'), egress.GUARD_SCRIPT_SHA256);
    assert.deepEqual(argv.slice(12, 28), ['bash', '/scratch/x', '1000', '1001', config.cwd, config.home, config.artifact, '105', '62m',
      'bash', '-c', 'cd "$1" && shift && exec "$@"', 'bash', config.cwd, 'env', '-i']);
    assert(argv.includes('FEE_NATIVE_NONCE=' + config.nonce) && argv.includes('TMPDIR=/scratch/x/tmp'));
    assert.deepEqual(argv.slice(-3), [process.execPath, path.resolve(__dirname, 'fee-revenue-egress.cjs'), '--namespace-inner']);
    // H1: 62 MiB namespace + 2 MiB retained parent artifacts is exactly the 64 MiB writable total; 16 MiB stays the default outside the approved browser case.
    assert.equal(egress.writableBudget(config), 64);
    assert.doesNotThrow(() => egress.frozenArgv({ ...config, size: '16m', approval: undefined }, '/scratch/x', 1000, 1001));
    assert.throws(() => egress.frozenArgv({ ...config, exec: { ...config.exec, sudo: undefined } }, '/scratch/x', 1000, 1001), /not pinned/);
    for (const bad of [{ size: '64m' }, { size: '65m' }, { size: '128m' }, { size: '16m' }, { approval: undefined }, { size: '32m', approval: undefined }, { limit: 106 }, { limit: 0 }, { guardSha256: '0'.repeat(64) }]) {
      assert.throws(() => egress.frozenArgv({ ...config, ...bad }, '/scratch/x', 1000, 1001), /bound|frozen/, JSON.stringify(bad));
    }
    assert.throws(() => egress.namespaceConfig({}, process.cwd(), {}, { platform: 'darwin', uid: 1000 }), /Linux only/);
    assert.throws(() => egress.namespaceConfig({}, process.cwd(), {}, { platform: 'linux', uid: 0 }), /root/);
    assert.throws(() => egress.namespaceConfig({}, process.cwd(), { PLAYWRIGHT_BROWSERS_PATH: '/opt/b' }, { platform: 'linux', uid: 1000 }), /frozen/);
  });

  test('namespace launcher reports forged success, exit status, stream flood and timeout honestly and leaves no process', { timeout: 30000 }, async () => {
    const fs = require('node:fs'), os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-ns-'));
    const bin = path.join(root, 'bin'), sudo = path.join(bin, 'sudo');
    fs.mkdirSync(bin);
    const config = nsConfig(fs.mkdtempSync(path.join(root, 'cfg-')));
    const fake = body => { fs.writeFileSync(sudo, '#!/bin/sh\nif [ "$2" = /bin/kill ]; then shift 2; exec /bin/kill "$@"; fi\n' + body + '\n', { mode: 0o755 }); config.exec = execFor(sudo); };
    const forged = 'printf "FEE_NATIVE_READBACK {\\"forged\\":true}\\nFEE_NATIVE_RESULT {\\"result\\":{\\"status\\":\\"PASS\\"}}\\n"';
    try {
      fake(forged + '; exit 0');
      let run = await egress.runNamespace(config);
      assert.equal(run.receipt.clean, false);
      assert.match(run.receipt.reason, /stale or changed/);
      assert.equal(run.result, null);
      fake(forged + '; exit 3');
      run = await egress.runNamespace(config);
      assert.equal(run.receipt.code, 3);
      assert.equal(run.receipt.clean, false);
      assert.equal(run.result, null);
      fake('exec yes x');
      run = await egress.runNamespace(config);
      assert.match(run.receipt.reason, /1 MiB/);
      assert.equal(run.receipt.clean, false);
      assert(run.receipt.signalled.length > 0 && run.receipt.descendantsAbsent);
      fake('sleep 30 & wait');
      run = await egress.runNamespace(config, { outerMs: 500 });
      assert.match(run.receipt.reason, /native invocation bound/);
      assert.equal(run.receipt.clean, false);
      assert(run.receipt.elapsedMs < 10000 && run.receipt.descendantsAbsent && run.receipt.scratchRemoved);
      const alive = egress.processTable().map(row => row.pid);
      assert(run.receipt.signalled.length >= 2 && run.receipt.signalled.every(pid => !alive.includes(pid)), 'signalled owned processes must be gone');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('namespace launcher follows reparented descendants by birth identity and reports a failed privileged kill within the hard bound', { timeout: 30000 }, async () => {
    const fs = require('node:fs'), cp = require('node:child_process');
    const root = mk('fee-ns-'), sudo = path.join(root, 'sudo');
    const config = nsConfig(fs.mkdtempSync(path.join(root, 'cfg-')));
    const script = body => { fs.writeFileSync(sudo, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); config.exec = execFor(sudo); };
    const pgrep = pattern => cp.spawnSync('pgrep', ['-f', pattern], { stdio: 'ignore' }).status;
    // The intermediate shell exits after 0.6 s; its sleep is reparented but must stay owned and be killed.
    script('if [ "$2" = /bin/kill ]; then shift 2; exec /bin/kill "$@"; fi\nsh -c "sleep 31 & sleep 0.6; exit 0" & sleep 30 & wait');
    let run = await egress.runNamespace(config, { outerMs: 1500 });
    assert.match(run.receipt.reason, /native invocation bound/);
    assert.equal(run.receipt.descendantsAbsent, true);
    assert.equal(pgrep('sleep 31'), 1, 'reparented descendant must be killed');
    assert(run.receipt.signalled.length >= 3 && run.receipt.killStatus.every((status) => status === 0));
    // A privileged kill that fails with survivors keeps the primary cause, the nonzero status and the scratch, and still returns in a finite time.
    script('if [ "$2" = /bin/kill ]; then exit 1; fi\nsleep 30 & wait');
    run = await egress.runNamespace(config, { outerMs: 300, hardMs: 2000 });
    try {
      assert.equal(run.receipt.clean, false);
      assert.equal(run.receipt.descendantsAbsent, false);
      assert.match(run.receipt.reason, /sudo kill reported \[1.*first cause: native invocation bound/);
      assert.equal(run.receipt.scratchRemoved, false);
      assert(run.receipt.elapsedMs < 6000, 'finite shutdown: ' + run.receipt.elapsedMs);
    } finally {
      for (const pid of run.receipt.signalled) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      const scratch = run.receipt.scratch;
      assert(path.basename(scratch).startsWith('fee-native-') && path.dirname(fs.realpathSync(scratch)) === fs.realpathSync(process.env.RUNNER_TOOL_CACHE || require('node:os').tmpdir()));
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('restored mount ancestry is allowed but every other home entry is reported', () => {
    const fs = require('node:fs'), home = mk('fee-home-');
    const repo = path.join(home, 'work', 'repo'), pw = path.join(home, 'work', 'pw');
    fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(pw);
    fs.writeFileSync(path.join(repo, 'restored'), 'x');
    assert.deepEqual(egress.homeUnexpected(home, [repo, pw]), []);
    fs.mkdirSync(path.join(home, '.ssh')); fs.writeFileSync(path.join(home, 'work', 'other'), 'x');
    assert.deepEqual(egress.homeUnexpected(home, [repo, pw]).sort(), ['.ssh', 'work/other']);
    assert.deepEqual(egress.homeUnexpected(home, ['/outside/root']).sort(), ['.ssh', 'work']);
  });

  test('private vault presence is detected without reading the file', () => {
    const fs = require('node:fs'), root = mk('fee-vault-');
    assert.doesNotThrow(() => egress.assertNoPrivateVault(root));
    const dir = path.join(root, 'group_vars', 'vps');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'vault.yml'), '', { mode: 0 });
    assert.throws(() => egress.assertNoPrivateVault(root), /private vault file is present/);
  });

  test('frozen guard controls are the supplied bodies and each judge rejects a missing or weakened observation', () => {
    const crypto = require('node:crypto');
    assert.deepEqual(Object.keys(egress.GUARD_CONTROLS).sort(), ['EGRESS', 'FLOOD', 'OVERLIMIT', 'PRIVATE', 'PRIVS', 'SLEEP', 'SURVIVOR', 'WRITES']);
    for (const [name, body] of Object.entries(egress.GUARD_CONTROLS)) assert.equal(crypto.createHash('sha256').update(body).digest('hex'), egress.GUARD_CONTROL_SHA256[name], name);
    assert.deepEqual(Object.keys(egress.GUARD_NA), ['RFMS']);
    const res = (text, extra = {}) => ({ code: 0, signal: null, capped: false, timedOut: false, seconds: 1, leftovers: [], text, ...extra });
    const zero = '0000000000000000', caps = { CapInh: zero, CapPrm: zero, CapEff: zero, CapBnd: zero, CapAmb: zero };
    const good = {
      EGRESS: { loopback: 'OK', '192.0.2.1': 'OSError', '1.1.1.1': 'TimeoutError' },
      PRIVATE: { home_canary: 'ENOENT', git_head: 'ENOENT', outside: { checkout: 30, home: 30, host_dir: 'ABSENT' } },
      PRIVS: { nnp: 1, caps, sudo: 'DENIED', setuid0: 'EPERM', mount: 'DENIED' },
      WRITES: { checkout: 30, home: 13, scratch: 'WRITABLE' }, OVERLIMIT: { errno: 28, mib: 4 },
    };
    const bad = {
      EGRESS: [{ ...good.EGRESS, '1.1.1.1': 'CONNECTED' }, { '192.0.2.1': 'OSError', '1.1.1.1': 'OSError' }, { ...good.EGRESS, extra: 1 }],
      PRIVATE: [{ ...good.PRIVATE, home_canary: 'READ' }, { ...good.PRIVATE, outside: { ...good.PRIVATE.outside, host_dir: 'PRESENT' } }, { ...good.PRIVATE, outside: { ...good.PRIVATE.outside, home: 'WRITABLE' } }],
      PRIVS: [{ ...good.PRIVS, sudo: 'OK' }, { ...good.PRIVS, nnp: 0 }, { ...good.PRIVS, caps: { ...caps, CapEff: '0000000000000001' } }, { ...good.PRIVS, setuid0: 'OK' }],
      WRITES: [{ ...good.WRITES, scratch: 30 }, { ...good.WRITES, checkout: 'WRITABLE' }, { checkout: 30 }],
      OVERLIMIT: [{ errno: null, mib: 200 }, { errno: 28, mib: 0 }, { errno: true, mib: 1 }],
    };
    for (const name of Object.keys(good)) {
      assert.equal(egress.judgeGuard(name, res(JSON.stringify(good[name]))), null, name);
      for (const value of bad[name]) assert.match(egress.judgeGuard(name, res(JSON.stringify(value))) || '', /./, name + JSON.stringify(value));
      assert.match(egress.judgeGuard(name, res('not json')), /unparseable/, name);
      assert.match(egress.judgeGuard(name, res(JSON.stringify(good[name]), { leftovers: ['scratch mount survived'] })), /cleanup/, name);
    }
    assert.equal(egress.judgeGuard('FLOOD', res('', { capped: true })), null);
    assert.match(egress.judgeGuard('FLOOD', res('')), /flood/);
    assert.equal(egress.judgeGuard('SLEEP', res('', { code: 137, seconds: 2.1 })), null);
    assert.match(egress.judgeGuard('SLEEP', res('', { code: 0, seconds: 0.1 })), /hung command/);
    assert.equal(egress.judgeGuard('SURVIVOR', res('')), null);
    assert.match(egress.judgeGuard('SURVIVOR', res('', { leftovers: ['process mentioning fee-survivor survived'] })), /cleanup/);
  });

  test('guard controls stop the run on a forged weakened observation, manufacture nothing and remove their canary', { timeout: 30000 }, async () => {
    const fs = require('node:fs'), root = mk('fee-ns-'), sudo = path.join(root, 'sudo');
    const config = nsConfig(fs.mkdtempSync(path.join(root, 'cfg-')));
    fs.mkdirSync(config.home);
    fs.writeFileSync(sudo, '#!/bin/sh\nprintf \'{"loopback":"OK","192.0.2.1":"CONNECTED","1.1.1.1":"CONNECTED"}\\n\'\n', { mode: 0o755 });
    config.exec = execFor(sudo);
    const run = await egress.runGuardControls(config, { hardMs: 5000 });
    assert.equal(run.ok, false);
    assert.deepEqual(Object.keys(run.results), ['EGRESS']);
    assert.equal(run.results.EGRESS.status, 'FAIL');
    assert.deepEqual(fs.readdirSync(config.home), []);
    assert(run.receipts.every((receipt) => receipt.scratchRemoved));
  });

  test('bounded diagnostics keep the primary cause and terminal context; the authored result fits or fails explicitly', () => {
    const noisy = 'PRIMARY-CAUSE ' + 'x'.repeat(500000) + ' TERMINAL';
    const bounded = egress.boundedLog(noisy, 4096);
    assert(Buffer.byteLength(bounded) <= 4096 && bounded.startsWith('PRIMARY-CAUSE') && bounded.endsWith('TERMINAL') && /elided/.test(bounded));
    const result = { status: 'PASS', rows: 'r'.repeat(200 * 1024) }, receipt = { clean: true, code: 0 };
    const line = egress.buildTrailer({ receipt, log: noisy, result, runtime: { pid: 1 } });
    assert(Buffer.byteLength(line) <= 1048576 - 65536);
    const parsed = JSON.parse(line);
    assert.deepEqual(parsed.result, result);
    assert(parsed.log.startsWith('PRIMARY-CAUSE') && parsed.log.endsWith('TERMINAL'));
    assert.throws(() => egress.buildTrailer({ receipt, log: noisy, result: { rows: 'r'.repeat(1048576) }, runtime: null }), /transport capacity/);
  });

  test('cleanup closes the fixture and stops accepting connections', { timeout: 10000 }, async () => {
    const before = fixture.snapshot();
    await fixture.close();

    let failure;
    try {
      await fetch(`${fixture.origin}/-/ready`);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'closed fixture must refuse connections');
    // A pooled keep-alive socket reports ECONNRESET; a fresh one ECONNREFUSED.
    assert.match(String(failure.cause?.code ?? failure.message), /ECONNREFUSED|ECONNRESET|EPIPE/);
    assert.equal(fixture.snapshot().total, before.total);
  });
}
