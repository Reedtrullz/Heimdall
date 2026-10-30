'use strict';

/**
 * Fail-closed egress guard for the offline fee-demand measurement.
 *
 * Loaded into the production server with
 *   NODE_OPTIONS=--require e2e/helpers/fee-revenue-egress.cjs
 * when FEE_EGRESS_ALLOW lists the exact owned loopback authorities, and
 * installed directly by the Node helper checks.
 *
 * Boundary: this hooks JavaScript fetch, DNS and TCP/TLS connect calls that
 * this process makes. It does not sandbox native addons, child processes or
 * code that kept its own references before install.
 */

const dns = require('node:dns');
const net = require('node:net');
const tls = require('node:tls');

const MAX_DENIALS = 64;
const denials = [];
const originals = {};
let allow = new Set();
let installed = false;

class FeeEgressDenied extends Error {
  constructor(target, reason) {
    super(`fee-demand egress denied: ${target} (${reason})`);
    this.name = 'FeeEgressDenied';
    this.code = 'FEE_EGRESS_DENIED';
    this.target = target;
    this.reason = reason;
  }
}

function normalizeHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
  return value;
}

function parseAllowList(value) {
  const entries = new Set();
  const rawEntries = Array.isArray(value) ? value : String(value || '').split(',');
  for (const raw of rawEntries) {
    const entry = String(raw).trim().toLowerCase();
    if (!entry) continue;
    const index = entry.lastIndexOf(':');
    if (index <= 0) continue;
    const host = normalizeHost(entry.slice(0, index));
    const port = Number(entry.slice(index + 1));
    if (!['127.0.0.1', 'localhost'].includes(host) || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
    entries.add(`${host}:${port}`);
  }
  return entries;
}

function isAllowed(host, port) {
  return allow.has(`${normalizeHost(host)}:${Number(port)}`);
}

function recordDenial(target, reason) {
  if (denials.length < MAX_DENIALS) denials.push({ target, reason, at: Date.now() });
  return new FeeEgressDenied(target, reason);
}

function fetchUrl(input) {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  if (input && typeof input.url === 'string') return new URL(input.url);
  return new URL(String(input));
}

function assertFetchAllowed(input) {
  const url = fetchUrl(input);
  if (url.protocol !== 'http:') throw recordDenial(url.href, `protocol ${url.protocol}`);
  const port = Number(url.port || 80);
  if (!isAllowed(url.hostname, port)) {
    throw recordDenial(`${normalizeHost(url.hostname)}:${port}`, 'fetch authority not allowlisted');
  }
  return url;
}

function normalizeConnectArgs(args) {
  // Node's net.connect normalises its arguments and forwards [options, cb].
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  let port;
  let unixPath;

  if (first && typeof first === 'object') {
    if (typeof first.path === 'string') unixPath = first.path;
    host = first.host || first.hostname;
    port = first.port;
  } else if (typeof first === 'number') {
    port = first;
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof first === 'string') {
    if (/^\d+$/.test(first)) {
      port = Number(first);
      host = 'localhost';
    } else {
      const index = first.lastIndexOf(':');
      if (index > 0 && /^\d+$/.test(first.slice(index + 1))) {
        host = first.slice(0, index);
        port = Number(first.slice(index + 1));
      } else {
        unixPath = first;
      }
    }
  }

  return { host, port: Number(port), unixPath };
}

function assertConnectAllowed(kind, args) {
  const target = normalizeConnectArgs(args);
  if (target.unixPath) throw recordDenial(`unix:${target.unixPath}`, `${kind} unix socket denied`);
  if (!target.host || !Number.isInteger(target.port) || target.port <= 0) {
    throw recordDenial(`${String(target.host)}:${String(target.port)}`, `${kind} target incomplete`);
  }
  if (!isAllowed(target.host, target.port)) {
    throw recordDenial(`${normalizeHost(target.host)}:${target.port}`, `${kind} authority not allowlisted`);
  }
}

function install(allowList) {
  if (allowList !== undefined) allow = parseAllowList(allowList);
  else allow = parseAllowList(process.env.FEE_EGRESS_ALLOW);
  if (installed) return module.exports;

  originals.fetch = globalThis.fetch;
  originals.lookup = dns.lookup;
  originals.promisesLookup = dns.promises.lookup;
  originals.socketConnect = net.Socket.prototype.connect;
  originals.connect = net.connect;
  originals.createConnection = net.createConnection;
  originals.tlsConnect = tls.connect;

  if (typeof originals.fetch === 'function') {
    globalThis.fetch = function guardedFetch(input, init) {
      assertFetchAllowed(input);
      return originals.fetch.call(globalThis, input, init);
    };
  }

  dns.lookup = function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (normalizeHost(hostname) !== '127.0.0.1' && normalizeHost(hostname) !== 'localhost') {
      const error = recordDenial(normalizeHost(hostname), 'dns lookup denied');
      if (typeof callback === 'function') return process.nextTick(() => callback(error));
      throw error;
    }
    return originals.lookup.call(dns, hostname, options, callback);
  };

  dns.promises.lookup = function guardedPromiseLookup(hostname, options) {
    const host = normalizeHost(hostname);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      return Promise.reject(recordDenial(host, 'dns lookup denied'));
    }
    return originals.promisesLookup.call(dns.promises, hostname, options);
  };

  net.Socket.prototype.connect = function guardedSocketConnect(...args) {
    assertConnectAllowed('net.Socket.connect', args);
    return originals.socketConnect.apply(this, args);
  };

  net.connect = function guardedConnect(...args) {
    assertConnectAllowed('net.connect', args);
    return originals.connect.apply(net, args);
  };

  net.createConnection = function guardedCreateConnection(...args) {
    assertConnectAllowed('net.createConnection', args);
    return originals.createConnection.apply(net, args);
  };

  tls.connect = function guardedTlsConnect(...args) {
    const target = args[0] && typeof args[0] === 'object' ? args[0] : {};
    throw recordDenial(
      `tls:${normalizeHost(target.host || target.hostname || 'unknown')}:${String(target.port || 443)}`,
      'TLS egress denied'
    );
  };

  installed = true;
  return module.exports;
}

function uninstall() {
  if (!installed) return module.exports;
  if (typeof originals.fetch === 'function') globalThis.fetch = originals.fetch;
  dns.lookup = originals.lookup;
  dns.promises.lookup = originals.promisesLookup;
  net.Socket.prototype.connect = originals.socketConnect;
  net.connect = originals.connect;
  net.createConnection = originals.createConnection;
  tls.connect = originals.tlsConnect;
  installed = false;
  return module.exports;
}

function reset() {
  denials.length = 0;
}

module.exports = {
  FeeEgressDenied,
  getDenials: () => denials.map((entry) => ({ ...entry })),
  getAllowList: () => [...allow],
  install,
  isAllowed,
  isInstalled: () => installed,
  parseAllowList,
  reset,
  uninstall,
};

if (process.env.FEE_EGRESS_ALLOW) install();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const CLOCK_EPOCH = 1792972800000;
const INSTRUMENTATION = [
  'e2e/fee-revenue-demand.measure.ts', 'e2e/helpers/fee-revenue-fixture.ts',
  'e2e/helpers/fee-revenue-egress.cjs', 'e2e/helpers/fee-revenue-egress.test.cjs',
  'playwright.fee-demand.config.ts',
];
function digest(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) { hash.update(path.basename(file)); hash.update(fs.readFileSync(file)); }
  return hash.digest('hex');
}
function artifactDigest(root) {
  const hash = crypto.createHash('sha256');
  const realRoot = fs.realpathSync(root);
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (target !== realRoot && !target.startsWith(realRoot + path.sep)) throw new Error('artifact symlink escapes outside input');
        hash.update(JSON.stringify([relative, 'link', fs.readlinkSync(file)]) + '\n');
      } else if (entry.isDirectory()) {
        hash.update(JSON.stringify([relative, 'directory']) + '\n');
        visit(file);
      } else {
        hash.update(JSON.stringify([relative, 'file', crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]) + '\n');
      }
    }
  }
  visit(root);
  return hash.digest('hex');
}
function validateInputs(input, cwd = process.cwd(), runtimeTarget = false) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) throw new Error('one baseline or two independently built inputs required');
  const instrumentation = digest(INSTRUMENTATION.map(file=>path.join(cwd,file)));
  for (const target of input) {
    if (!target || !/^[a-f0-9]{40}$/.test(target.revision || '') ||
        !/^[a-f0-9]{64}$/.test(target.artifactSha256 || '') ||
        target.runtime !== process.version || target.clock !== CLOCK_EPOCH ||
        target.instrumentation !== instrumentation || !path.isAbsolute(target.artifact || '') ||
        !fs.existsSync(path.join(target.artifact,'server.js')) ||
        !fs.existsSync(path.join(target.artifact,'.next','BUILD_ID'))) throw new Error('missing or mismatched frozen input identity');
    if (artifactDigest(target.artifact) !== target.artifactSha256) throw new Error('stale or dirty frozen artifact');
    function readOnly(dir) {
      if (fs.statSync(dir).mode & 0o222) throw new Error('artifact input must be read-only');
      for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
        const file=path.join(dir,entry.name);
        if(entry.isDirectory())readOnly(file);
        else if(fs.statSync(file).mode & 0o222)throw new Error('artifact input must be read-only');
      }
    }
    readOnly(target.artifact);
  }
  if (input[0].label !== 'baseline' || input[0].phase !== 'baseline') {
    if (!runtimeTarget || input.length !== 1 || input[0].label !== 'candidate' || input[0].phase !== 'candidate') throw new Error('false baseline label');
  }
  if (input.length === 2) {
    const [a,b] = input;
    if (b.label !== 'candidate' || b.phase !== 'candidate' || a.revision === b.revision ||
        a.artifactSha256 === b.artifactSha256 || fs.realpathSync(a.artifact) === fs.realpathSync(b.artifact)) throw new Error('duplicate binary or false candidate label');
  }
  return input;
}

const ACTIONS = [
  'closed-valid','open','close','reopen','closed-absent','closed-invalid',
  'pending-open','pending-close','pending-reopen',...Array.from({length:6},(_,i)=>'toggle-'+i),
  'unmounted','late-release','pending-recovery','address-A','address-invalid','address-B','address-recovery',
  'refresh-300s','focus','reconnect','manual-global','subscriber-mount','primary-close',
  'subscriber-focus','subscriber-300s','subscriber-unmount','primary-reopen',
  ...['stale','malformed','source-failure','rate-limit'].flatMap(mode=>['healthy','direct','failed','recovered'].map(action=>mode+'-'+action)),
];
const EXPECTED_SCENARIOS = ['desktop','mobile'].flatMap(viewport=>ACTIONS.map(action=>viewport+'/'+action));
function validateObservations(rows) {
  if (!Array.isArray(rows) || rows.length !== EXPECTED_SCENARIOS.length) throw new Error('incomplete scenario population');
  const seen = new Set();
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const ui = value => {
    if (!object(value) || typeof value.route !== 'string' || !value.route.startsWith('/dashboard/') ||
        !['summary','health','checks','diagnosis'].every(key => Object.hasOwn(value,key) && (value[key] === null || typeof value[key] === 'string')) ||
        !['fees','errors'].every(key => Array.isArray(value[key]) && value[key].every(text => typeof text === 'string')) ||
        !integer(value.loading)) throw new Error('missing or malformed observed UI outcome');
  };
  for (const row of rows) {
    if (!EXPECTED_SCENARIOS.includes(row.id) || seen.has(row.id)) throw new Error('duplicate or unknown scenario');
    seen.add(row.id);
    const action = row.id.split('/')[1];
    const population = /^(stale|malformed|source-failure|rate-limit)-/.test(action) ? 'error' : 'happy';
    if (row.population !== population) throw new Error('wrong outcome population');
    if (!object(row.clocks) || !['fixture','browser','server'].every(key => integer(row.clocks[key])) ||
        row.clocks.fixture !== row.clocks.browser || row.clocks.fixture !== row.clocks.server) throw new Error('missing or divergent observed clocks');
    ui(row.outcome);
    if (!Object.hasOwn(row.outcome,'subscriber')) throw new Error('missing observed subscriber outcome');
    const hasSubscriber = ['subscriber-mount','primary-close','subscriber-focus','subscriber-300s'].includes(action);
    if (hasSubscriber && !row.outcome.subscriber) throw new Error('missing observed subscriber');
    if (row.outcome.subscriber !== null) ui(row.outcome.subscriber);
    if (!Object.hasOwn(row.outcome,'http')) throw new Error('missing observed HTTP outcome');
    const http = row.outcome.http;
    if (/-(direct|failed)$/.test(action) && http === null) throw new Error('missing observed HTTP response');
    if (http !== null && (!object(http) || !Number.isInteger(http.status) || http.status < 100 || http.status > 599 ||
        !(http.retryAfter === null || typeof http.retryAfter === 'string') ||
        (action.endsWith('-direct') && !integer(http.bytes)))) throw new Error('malformed observed HTTP response');
    for (const end of ['before','after']) {
      const counts=row[end];
      if (!object(counts) || !['total','upstreamBytes','pending','unhandled'].every(key => integer(counts[key])) ||
          !['browserRequests','browserBytes','attempts','bytesByKey'].every(key => object(counts[key]) && Object.values(counts[key]).every(integer))) throw new Error('incomplete or malformed counters');
    }
    for (const key of ['total','upstreamBytes']) if (row.after[key] < row.before[key]) throw new Error('action counter moved backwards');
    if (['refresh-300s','focus','reconnect','manual-global','subscriber-focus','subscriber-300s'].includes(action)) {
      const key = (action.startsWith('subscriber-') ? 'independent:' : 'primary:') + '/api/midgard/v2/history/earnings';
      if ((row.after.browserRequests[key] ?? 0) <= (row.before.browserRequests[key] ?? 0)) throw new Error('missing per-action request attribution');
    }
  }
  return [...rows].sort((a,b)=>a.id.localeCompare(b.id));
}
function compareRuns(runs, paired) {
  const identities = new Set();
  const first = new Map();
  for (const run of runs) {
    const runtime=run.runtime;
    if (!runtime || !Number.isInteger(runtime.pid) || !Number.isInteger(runtime.fixturePid) ||
        !runtime.processStart || !runtime.cache || !runtime.invocation || !runtime.artifactSha256 ||
        runtime.instrumentation!==run.target.instrumentation || runtime.runtime!==process.version ||
        runtime.clock!==CLOCK_EPOCH || runtime.revision!==run.target.revision ||
        runtime.artifactSha256!==run.target.artifactSha256 || runtime.label!==run.target.label ||
        runtime.phase!==run.target.phase) throw new Error('incomplete runtime identity');
    for (const key of ['invocation','cache']) {
      if (identities.has(key+':'+runtime[key])) throw new Error('shared process/cache identity');
      identities.add(key+':'+runtime[key]);
    }
    const processIdentity=runtime.pid+':'+runtime.processStart;
    if(identities.has(processIdentity))throw new Error('shared server process');
    identities.add(processIdentity);
    run.observations=validateObservations(run.observations);
    const signature=JSON.stringify(run.observations);
    if(first.has(run.target.label) && first.get(run.target.label)!==signature) throw new Error('same-source repetition instability');
    first.set(run.target.label,signature);
  }
  if(!paired)return;
  const nonincrease=(a,b)=>{
    if(typeof a==='number'&&typeof b==='number') {if(b>a)throw new Error('secondary work increased');return;}
    const keys=new Set([...Object.keys(a),...Object.keys(b)]);
    for(const key of keys)nonincrease(a[key]??0,b[key]??0);
  };
  for(let i=0;i<runs.length;i+=2) {
    const pair=runs.slice(i,i+2);
    const base=pair.find(run=>run.target.label==='baseline');
    const candidate=pair.find(run=>run.target.label==='candidate');
    if(!base||!candidate)throw new Error('missing pair');
    for(const population of ['happy','error']) {
      const left=base.observations.filter(row=>row.population===population);
      const right=candidate.observations.filter(row=>row.population===population);
      for(let j=0;j<left.length;j++) {
        const a=left[j],b=right[j];
        if(a.id!==b.id||JSON.stringify(a.outcome)!==JSON.stringify(b.outcome))throw new Error('pair-local outcomes changed');
        for(const key of Object.keys(a.after))nonincrease(a.after[key],b.after[key]);
        if(a.id.endsWith('/closed-valid')) {
          const key='primary:/api/midgard/v2/history/earnings';
          if((b.after.browserRequests[key]??0)>=(a.after.browserRequests[key]??0))throw new Error('no strict primary work reduction');
        }
      }
    }
  }
}
function treeBytes(root, excluded) {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (stat.isSymbolicLink()) throw new Error('owned scratch/output symlink');
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(root,{withFileTypes:true}).reduce((sum,entry)=>{
    const file=path.join(root,entry.name);
    if(file===excluded)return sum;
    if(entry.isSymbolicLink())throw new Error('owned scratch/output symlink');
    return sum+(entry.isDirectory()?treeBytes(file,excluded):fs.statSync(file).size);
  },0);
}
function processTable() {
  const output=require('node:child_process').execFileSync('ps',['-axo','pid=,ppid=,pgid=,stat=,lstart='],{encoding:'utf8',timeout:2000,maxBuffer:1048576});
  return output.trim().split('\n').map(line=>{
    const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if(!match)throw new Error('unreadable process identity');
    return {pid:Number(match[1]),ppid:Number(match[2]),pgid:Number(match[3]),state:match[4],start:match[5]};
  });
}
function inputIdentity(cwd, targets) {
  const files=require('node:child_process').execFileSync('git',['ls-files','-z','--','src','next.config.ts','package.json','pnpm-lock.yaml'],{cwd,timeout:5000,maxBuffer:1048576}).toString().split('\0').filter(Boolean);
  return {source:digest(files.map(file=>path.join(cwd,file))),instrumentation:digest(INSTRUMENTATION.map(file=>path.join(cwd,file))),artifacts:targets.map(target=>artifactDigest(target.artifact))};
}
async function refused(port) {
  return new Promise((resolve,reject)=>{
    const socket=new net.Socket();
    socket.setTimeout(500,()=>{socket.destroy();reject(new Error('owned port teardown timed out'))});
    socket.once('connect',()=>{socket.destroy();resolve(false)});
    socket.once('error',error=>{if(error.code==='ECONNREFUSED'||error.code==='ECONNRESET')resolve(true);else reject(error)});
    (originals.socketConnect||net.Socket.prototype.connect).call(socket,{host:'127.0.0.1',port});
  });
}
async function runOwned(options) {
  const cp=require('node:child_process');
  const browser = options.profile === 'fee-demand-browser-v1';
  if (options.profile && !browser) throw new Error('unapproved resource profile');
  if (browser && (options.approval !== '781cd061013ec6227385fb3b8b6a29766df50747a867e537c41ab6f9480472c3' ||
      options.args.length !== 4 || options.args[1] !== 'test' || options.args[2] !== '-c' ||
      options.args[3] !== 'playwright.fee-demand.config.ts' ||
      fs.realpathSync(options.args[0]) !== fs.realpathSync(require.resolve('@playwright/test/cli')))) throw new Error('unapproved browser resource invocation');
  const scratchLimit = Math.min(options.scratchLimit ?? (browser ? 67108864 : 16777216), browser ? 67108864 : 16777216);
  const timeout = Math.min(options.timeoutMs ?? 120000,120000);
  const owned=new Map(),ports=new Map();
  const receipt={processes:[],ports:[],streams:0,peakScratchBytes:0,peakArtifacts:0,scratchLimit,reason:null,code:null,signal:null};
  const ownership=path.join(options.scratch,'ownership.jsonl');
  fs.writeFileSync(ownership,'');
  const env={...options.env,FEE_OWNERSHIP_FILE:ownership,NODE_OPTIONS:'--require '+JSON.stringify(__filename)};
  const child=cp.spawn(process.execPath,options.args,{cwd:options.cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
  const chunks=[];
  const started=Date.now();
  const deadline=started+timeout;
  let unsafeOwnership=false,poll;
  let closed=false;
  const closedPromise=new Promise(resolve=>{
    child.once('error',error=>{receipt.reason??=String(error);unsafeOwnership=true});
    child.once('close',(code,signal)=>{closed=true;receipt.code=code;receipt.signal=signal;resolve()});
  });
  const inspect=()=>{
    const rows=processTable();
    const candidates=new Set([...owned.keys()]);
    const root=rows.find(row=>row.pid===child.pid&&row.ppid===process.pid);
    if(root&&!owned.has(root.pid)){owned.set(root.pid,root);candidates.add(root.pid)}
    let added=true;
    while(added){added=false;for(const row of rows)if(candidates.has(row.ppid)&&
      rows.some(parent=>parent.pid===row.ppid&&(!owned.has(parent.pid)||parent.start===owned.get(parent.pid).start))&&!candidates.has(row.pid)){candidates.add(row.pid);added=true}}
    for(const row of rows)if(candidates.has(row.pid)&&!owned.has(row.pid))owned.set(row.pid,row);
    const events=fs.readFileSync(ownership,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    for(const event of events)if(rows.some(row=>row.pid===event.pid)&&!owned.has(event.pid))throw new Error('unowned process in ownership record');
    for(const event of events)if(event.port&&owned.has(event.pid))ports.set(event.port,event.pid);
    receipt.peakScratchBytes=Math.max(receipt.peakScratchBytes,treeBytes(options.scratch));
    const activeArtifacts = ['artifacts','result.json','runtime.json','ownership.jsonl'].reduce((sum,name)=>sum+treeBytes(path.join(options.scratch,name)),0);
    receipt.peakArtifacts=Math.max(receipt.peakArtifacts,treeBytes(options.output,options.scratch)+activeArtifacts);
    if(receipt.peakScratchBytes>scratchLimit)receipt.reason??='scratch bound including browser profile/cache';
    if(receipt.peakArtifacts>Math.min(options.artifactLimit??2097152,2097152))receipt.reason??='2 MiB output artifact bound';
    if(Date.now()-started>timeout-Math.min(3000,timeout/4))receipt.reason??='native invocation bound including cleanup reserve';
  };
  const safeInspect=()=>{try{inspect()}catch(error){receipt.reason??='ownership/resource inspection failed: '+String(error);unsafeOwnership=true}};
  const signalOwned=signal=>{
    const rows=processTable();
    // Match birth identity before touching any PID, including separately grouped descendants.
    for(const identity of [...owned.values()].reverse()){
      const live=rows.find(row=>row.pid===identity.pid&&row.start===identity.start);
      if(live){try{process.kill(live.pid,signal)}catch(error){if(error.code!=='ESRCH')throw error}}
    }
  };
  const killRoot=()=>{if(!closed)try{child.kill('SIGKILL')}catch(error){receipt.cleanupError??=String(error);unsafeOwnership=true}};
  const safeSignal=signal=>{try{signalOwned(signal)}catch(error){receipt.reason??=String(error);unsafeOwnership=true;killRoot()}};
  const liveOwned=()=>{
    try{return processTable().filter(row=>owned.has(row.pid)&&owned.get(row.pid).start===row.start)}
    catch(error){receipt.reason??=String(error);unsafeOwnership=true;return null}
  };
  const interrupt=signal=>{receipt.reason??=signal;safeInspect();safeSignal('SIGTERM')};
  const onInt=()=>interrupt('SIGINT'),onTerm=()=>interrupt('SIGTERM');
  process.once('SIGINT',onInt);process.once('SIGTERM',onTerm);
  const collect=chunk=>{
    receipt.streams+=chunk.length;
    if(receipt.streams>Math.min(options.streamLimit??1048576,1048576)){receipt.reason??='1 MiB combined stream bound';safeInspect();safeSignal('SIGTERM')}
    else chunks.push(chunk);
  };
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  const watch=setInterval(()=>{safeInspect();if(receipt.reason)safeSignal('SIGTERM')},20);
  try {
    safeInspect();
    await Promise.race([closedPromise,new Promise(resolve=>{
      poll=setInterval(()=>{if(closed||receipt.reason){clearInterval(poll);resolve()}},10);
    })]);
  } finally {
    clearInterval(watch);clearInterval(poll);
    safeInspect();safeSignal('SIGTERM');
    const until=Math.min(Date.now()+500,deadline-100);
    while(Date.now()<until){const live=liveOwned();if(live===null||live.length===0)break;await new Promise(resolve=>setTimeout(resolve,10))}
    safeSignal('SIGKILL');
    let closeTimer;
    try{await Promise.race([closedPromise,new Promise(resolve=>{closeTimer=setTimeout(resolve,Math.max(1,deadline-Date.now()))})])}
    finally{clearTimeout(closeTimer)}
    if(!closed){receipt.reason??='owned child or descendant streams did not close';unsafeOwnership=true;killRoot();child.stdout.destroy();child.stderr.destroy()}
    const survivors=liveOwned();
    receipt.processes=[...owned.values()].map(row=>({...row,absent:survivors!==null&&!survivors.some(live=>live.pid===row.pid)}));
    for(const [port,pid] of ports){
      try{receipt.ports.push({port,pid,refused:await refused(port)})}
      catch(error){receipt.ports.push({port,pid,refused:false,error:String(error)});receipt.reason??=String(error);unsafeOwnership=true}
    }
    process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);
    receipt.stdout=Buffer.concat(chunks).toString();
    receipt.rootClosed=closed;
    receipt.elapsedMs=Date.now()-started;
    receipt.clean=closed&&!unsafeOwnership&&survivors!==null&&survivors.length===0&&receipt.ports.every(port=>port.refused);
    if(receipt.elapsedMs>timeout){receipt.reason??='native invocation exceeded total time bound';receipt.clean=false}
    if(!receipt.clean)receipt.reason??='owned process/port teardown failed';
  }
  return receipt;
}
// Frozen util-linux namespace guard SCRIPT (guard JSON sha256 6428ed96...1801); its bytes are pinned by GUARD_SCRIPT_SHA256.
const GUARD_SCRIPT = "set -eu\nscratch=$1; uid=$2; gid=$3; root=$4; home=$5; pw=$6; limit=$7; size=$8; shift 8\nmount --make-rprivate /\nmkdir -p \"$scratch\"\nmount -t tmpfs -o \"size=$size,mode=0700,uid=$uid,gid=$gid,nosuid,nodev\" tmpfs \"$scratch\"\ninstall -d -m 0700 \"$scratch/.stage\" \"$scratch/.stage/root\" \"$scratch/.stage/pw\"\nmount --bind \"$root\" \"$scratch/.stage/root\"\nmount --bind \"$pw\" \"$scratch/.stage/pw\"\nmount -t tmpfs -o size=1m,mode=0755,nosuid,nodev tmpfs \"$home\"\nmkdir -p \"$root\" \"$pw\"\nmount --bind \"$scratch/.stage/root\" \"$root\"\nmount --bind \"$scratch/.stage/pw\" \"$pw\"\numount -l \"$scratch/.stage/root\" \"$scratch/.stage/pw\"\nif [ -d \"$root/.git\" ]; then mount -t tmpfs -o size=4k,mode=0555,ro tmpfs \"$root/.git\"\nelif [ -e \"$root/.git\" ]; then mount --bind /dev/null \"$root/.git\"; fi\nwhile read -r mp; do\n  case \"$mp\" in \"$scratch\"|\"$scratch\"/*|/proc|/proc/*|/sys|/sys/*|/dev/pts) continue;; esac\n  mount -o remount,bind,ro \"$mp\" 2>/dev/null || { printf 'o23-diag remount-failed %.200s\\n' \"$mp\" >&2; exit 97; }\ndone <<EOF\n$(awk '{print $5}' /proc/self/mountinfo)\nEOF\ninstall -d -o \"$uid\" -g \"$gid\" -m 0700 \"$scratch/home\" \"$scratch/tmp\" \"$scratch/shm\" \"$scratch/cache\" \"$scratch/config\" \"$scratch/run\" \"$scratch/work\"\nmount --bind \"$scratch/tmp\" /tmp\nif [ -d /var/tmp ]; then mount --bind \"$scratch/tmp\" /var/tmp; fi\nif [ -d /dev/shm ]; then mount --bind \"$scratch/shm\" /dev/shm; fi\nip link set lo up\nexec timeout --signal=KILL \"$limit\" setpriv --reuid=\"$uid\" --regid=\"$gid\" --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all \"$@\"\n";
const GUARD_SCRIPT_SHA256 = 'da5c257d2d86a63acdde3984a968fe0f28b06d20fcbd4242d7d1874a5361aa55';
const NAMESPACE_LIMIT_SECONDS = 105, NAMESPACE_INNER_MS = 95000, NAMESPACE_OUTER_MS = 108000, NAMESPACE_HARD_MS = 115000, NAMESPACE_STREAM = 1048576;
const TRAILER_MAX = NAMESPACE_STREAM - 65536; // headroom for the readback line and sudo/unshare diagnostics inside the unchanged 1 MiB stream bound
const BROWSER_APPROVAL = '781cd061013ec6227385fb3b8b6a29766df50747a867e537c41ab6f9480472c3';
// H1: 62 MiB namespace (tmp, shm, internal output) + 2 MiB parent artifacts retained concurrently = the 64 MiB writable total; default stays 16 MiB.
const BROWSER_NAMESPACE_MIB = 62, PARENT_ARTIFACT_MIB = 2, WRITABLE_TOTAL_MIB = 64;
const TRUSTED_DIRS = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'], SAFE_PATH = TRUSTED_DIRS.join(':');
const PRIVILEGED = ['sudo', 'unshare', 'bash', 'kill', 'python3'];
const PRIVATE_VAULT = path.join('group_vars', 'vps', 'vault.yml'); // H6: existence is checked with lstat only; the file is never read, hashed or exported
const GUARD_CONTROLS = {"EGRESS":"import socket, json\nout = {}\nfor host, port in ((\"192.0.2.1\", 80), (\"1.1.1.1\", 443)):\n    s = socket.socket(); s.settimeout(3)\n    try:\n        s.connect((host, port)); out[host] = \"CONNECTED\"\n    except OSError as e:\n        out[host] = type(e).__name__\n    finally:\n        s.close()\nsrv = socket.socket(); srv.bind((\"127.0.0.1\", 0)); srv.listen(1)\nsocket.create_connection(srv.getsockname(), timeout=3).close(); out[\"loopback\"] = \"OK\"\nprint(json.dumps(out))","PRIVATE":"import errno, json, os, sys\ncanary, root, host_dir, marker, host_home = sys.argv[1:6]\ndef code(error): return errno.errorcode.get(error.errno, str(error.errno))\ndef read(path):\n    try:\n        with open(path, \"rb\") as handle: handle.read(1)\n        return \"READ\"\n    except OSError as e: return code(e)\ndef write(path):\n    try:\n        open(path, \"w\").close(); os.unlink(path); return \"WRITABLE\"\n    except OSError as e: return e.errno\nout = {\"home_canary\": read(canary), \"git_head\": read(os.path.join(root, \".git\", \"HEAD\")),\n       \"outside\": {\"checkout\": write(os.path.join(root, \"o23-write-probe\")),\n                   \"home\": write(os.path.join(host_home, \"o23-write-probe\")),\n                   \"host_dir\": \"PRESENT\" if os.path.exists(host_dir) else \"ABSENT\"}}\nfor base in (\"/tmp\", \"/var/tmp\", \"/dev/shm\"):\n    try:\n        with open(os.path.join(base, marker), \"w\") as handle: handle.write(\"x\")\n    except OSError: pass\nprint(json.dumps(out))","PRIVS":"import errno, json, os, subprocess\nstatus = dict(line.split(\":\", 1) for line in open(\"/proc/self/status\").read().splitlines() if \":\" in line)\ndef attempt(argv):\n    try: return \"OK\" if subprocess.run(argv, capture_output=True, timeout=10).returncode == 0 else \"DENIED\"\n    except (OSError, subprocess.SubprocessError): return \"DENIED\"\ntry: os.setuid(0); setuid0 = \"OK\"\nexcept OSError as e: setuid0 = errno.errorcode.get(e.errno, str(e.errno))\nprint(json.dumps({\"nnp\": int(status[\"NoNewPrivs\"]), \"caps\": {k: status[k].strip() for k in (\"CapInh\", \"CapPrm\", \"CapEff\", \"CapBnd\", \"CapAmb\")},\n                  \"sudo\": attempt([\"sudo\", \"-n\", \"true\"]), \"setuid0\": setuid0, \"mount\": attempt([\"mount\", \"-t\", \"tmpfs\", \"x\", \"/mnt\"])}))","WRITES":"import json, os, sys\nout = {}\nfor label, base in ((\"checkout\", sys.argv[1]), (\"home\", sys.argv[2]), (\"scratch\", os.environ[\"TMPDIR\"])):\n    path = os.path.join(base, \"o23-write-probe\")\n    try:\n        open(path, \"w\").close(); os.unlink(path); out[label] = \"WRITABLE\"\n    except OSError as e:\n        out[label] = e.errno\nprint(json.dumps(out))","OVERLIMIT":"import json, os\nchunk = b\"x\" * (1 << 20); n = 0; paths = [os.path.join(d, \"fill\") for d in (os.environ[\"TMPDIR\"], \"/tmp\", \"/dev/shm\")]\ntry:\n    while n < 200:\n        with open(paths[n % 3], \"ab\") as f:\n            f.write(chunk); f.flush(); os.fsync(f.fileno())\n        n += 1\n    print(json.dumps({\"errno\": None, \"mib\": n}))\nexcept OSError as e:\n    print(json.dumps({\"errno\": e.errno, \"mib\": n}))\nfinally:\n    for path in paths:\n        try: os.unlink(path)\n        except OSError: pass","FLOOD":"import sys\nwhile True: sys.stdout.write('x' * 65536)","SLEEP":"import time; time.sleep(60)","SURVIVOR":"import subprocess, sys; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)', sys.argv[1]], start_new_session=True)"};
const GUARD_CONTROL_SHA256 = {"EGRESS":"406e6fcf8778ef416bdb1a1115f4858f38818d8226f0ba422011c92ac05f5831","PRIVATE":"a6a898e77c35c26b8050dd0352734013bd2426ee247e27232c1e005f09f09849","PRIVS":"a4b30009079428ab97ea0ddcb89a08baade873057062904e75be02df48cf15d2","WRITES":"9d3b169a2c1b5f014fbb196d857362fa433def8e10a7d2e7000b575e9a19c1bb","OVERLIMIT":"d86bfedc5a27afa277f74e917d74b1ea8a6bdce123b0033651905444ef468b87","FLOOD":"a2a866db4990633e1ef42718aafb3f0e07367727f39a41bf7ae19876f45b623e","SLEEP":"ce5ff26113096b649ce078382cf00ba464f5ada7c2bedd34fd5deb7ba89e23ee","SURVIVOR":"dcf2554349ab9b9205f144447a2cba4da57d03d17ea12de723a24badfac819d3"};
const GUARD_CONTROL_PLAN = { EGRESS: { limit: 20, size: '8m' }, PRIVATE: { limit: 20, size: '8m' }, PRIVS: { limit: 30, size: '8m' }, WRITES: { limit: 20, size: '8m' },
  OVERLIMIT: { limit: 60, size: '4m' }, FLOOD: { limit: 20, size: '8m' }, SLEEP: { limit: 2, size: '8m' }, SURVIVOR: { limit: 20, size: '8m' } };
const GUARD_NA = { RFMS: 'domain-specific to the ReedFS sibling RFMS checkout; Heimdall has no such mount' };
const READ_DENIALS = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'], WRITE_DENIALS = [1, 2, 13, 30]; // EPERM ENOENT EACCES EROFS
const SOCKET_DENIALS = ['OSError', 'BlockingIOError', 'ChildProcessError', 'ConnectionError', 'BrokenPipeError', 'ConnectionAbortedError', 'ConnectionRefusedError', 'ConnectionResetError',
  'FileExistsError', 'FileNotFoundError', 'InterruptedError', 'IsADirectoryError', 'NotADirectoryError', 'PermissionError', 'ProcessLookupError', 'TimeoutError'];
const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const guardDigest = () => crypto.createHash('sha256').update(GUARD_SCRIPT).digest('hex');
function inside(file, dir) { const rel = path.relative(dir, file); return !rel.startsWith('..') && !path.isAbsolute(rel); }
function pinned(file, label, allowedRoot) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || (inside(file, require('node:os').homedir()) && !(allowedRoot && inside(file, allowedRoot)))) {
    throw new Error(label + ' must be an absolute real path outside the masked home');
  }
  return { path: file, sha256: sha256File(file) };
}
function trustedExec(name) {
  for (const dir of TRUSTED_DIRS) {
    try { const real = fs.realpathSync(path.join(dir, name)); if (TRUSTED_DIRS.some(item => inside(real, item))) return { path: real, sha256: sha256File(real) }; } catch (error) { /* try the next trusted directory */ }
  }
  throw new Error('trusted executable missing: ' + name);
}
function verifyExec(config) {
  for (const name of PRIVILEGED) {
    const item = config.exec && config.exec[name];
    if (!item || !path.isAbsolute(item.path) || sha256File(item.path) !== item.sha256) throw new Error('privileged executable changed or not pinned: ' + name);
  }
}
function readNs() { return Object.fromEntries(['net', 'mnt', 'pid'].map(key => [key, fs.readlinkSync('/proc/self/ns/' + key)])); }
function assertNoPrivateVault(root) {
  try { fs.lstatSync(path.join(root, PRIVATE_VAULT)); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
  throw new Error('private vault file is present in the root mount; remove it from the hosted checkout before the guarded run');
}
function writableBudget(config) {
  const mib = /^\d+m$/.test(config.size || '') ? Number(config.size.slice(0, -1)) : NaN;
  const browser = config.approval === BROWSER_APPROVAL;
  if (!(browser ? mib === BROWSER_NAMESPACE_MIB : [4, 8, 16].includes(mib))) throw new Error('namespace bound outside the 16 MiB default or exact 62 MiB browser case');
  if (mib + PARENT_ARTIFACT_MIB > WRITABLE_TOTAL_MIB) throw new Error('namespace plus parent artifact bound exceeds 64 MiB');
  return mib + PARENT_ARTIFACT_MIB;
}
function namespaceConfig(target, cwd, env = process.env, host = { platform: process.platform, uid: process.getuid() }) {
  if (host.platform !== 'linux') throw new Error('namespace profile is Linux only');
  if (host.uid === 0) throw new Error('namespace profile refuses root');
  if (guardDigest() !== GUARD_SCRIPT_SHA256) throw new Error('frozen guard script changed');
  const browsers = env.PLAYWRIGHT_BROWSERS_PATH, expected = env.FEE_NATIVE_BROWSERS_SHA256;
  if (!path.isAbsolute(browsers || '') || !/^[a-f0-9]{64}$/.test(expected || '') || fs.realpathSync(browsers) !== browsers ||
      inside(browsers, require('node:os').homedir())) throw new Error('browser root and sha256 must be frozen outside the masked home before launch');
  if (artifactDigest(browsers) !== expected) throw new Error('browser bytes differ from the frozen identity');
  assertNoPrivateVault(cwd);
  return {
    nonce: crypto.randomUUID(), guardSha256: GUARD_SCRIPT_SHA256, size: BROWSER_NAMESPACE_MIB + 'm', approval: BROWSER_APPROVAL, limit: NAMESPACE_LIMIT_SECONDS, cwd, home: require('node:os').homedir(),
    node: pinned(process.execPath, 'node'), cli: pinned(fs.realpathSync(require.resolve('@playwright/test/cli')), 'cli', cwd),
    exec: Object.fromEntries(PRIVILEGED.map(name => [name, trustedExec(name)])), hostNs: readNs(),
    browser: { path: browsers, sha256: expected }, browsers, artifact: target.artifact, artifactSha256: target.artifactSha256,
    instrumentation: target.instrumentation, target,
  };
}
function frozenArgv(config, scratch, uid, gid, control) {
  if (config.guardSha256 !== GUARD_SCRIPT_SHA256 || guardDigest() !== GUARD_SCRIPT_SHA256) throw new Error('frozen guard script changed');
  if (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > NAMESPACE_LIMIT_SECONDS) throw new Error('namespace bound outside 105 s');
  writableBudget(config);
  for (const name of PRIVILEGED) if (!config.exec || !config.exec[name] || !path.isAbsolute(config.exec[name].path)) throw new Error('privileged executable not pinned: ' + name);
  const bin = name => config.exec[name].path;
  const env = { PATH: path.dirname(config.node.path) + ':/usr/local/bin:/usr/bin:/bin', HOME: scratch + '/home', TMPDIR: scratch + '/tmp', XDG_CACHE_HOME: scratch + '/cache',
    XDG_CONFIG_HOME: scratch + '/config', LANG: 'C.UTF-8', CI: 'true' };
  if (!control) Object.assign(env, { FEE_NATIVE_NONCE: config.nonce, FEE_NATIVE_CONFIG: JSON.stringify(config) });
  return [bin('sudo'), '-n', bin('unshare'), '--net', '--mount', '--pid', '--fork', '--kill-child', '--mount-proc', bin('bash'), '-c', GUARD_SCRIPT, 'bash', scratch, String(uid), String(gid),
    config.cwd, config.home, config.artifact, String(config.limit), config.size,
    'bash', '-c', 'cd "$1" && shift && exec "$@"', 'bash', config.cwd, 'env', '-i', ...Object.entries(env).map(([key, value]) => key + '=' + value),
    ...(control ? control : [config.node.path, __filename, '--namespace-inner'])];
}
function identityReadback(config) {
  return { nonce: config.nonce, guardSha256: guardDigest(), node: sha256File(process.execPath), cli: sha256File(config.cli.path), browser: artifactDigest(config.browser.path),
    instrumentation: digest(INSTRUMENTATION.map(file => path.join(config.cwd, file))), artifactSha256: artifactDigest(config.artifact) };
}
function checkIdentity(config, readback) {
  const expected = { nonce: config.nonce, guardSha256: GUARD_SCRIPT_SHA256, node: config.node.sha256, cli: config.cli.sha256, browser: config.browser.sha256,
    instrumentation: config.instrumentation, artifactSha256: config.artifactSha256 };
  if (!readback || Object.keys(expected).some(key => readback[key] !== expected[key])) throw new Error('stale or changed namespace configuration');
}
// H3: with root and artifact restored under the masked home, only their ancestor directories may exist; anything else under home is a leak.
function homeUnexpected(home, mounts) {
  const targets = mounts.filter(mount => inside(mount, home)).map(mount => path.resolve(mount)), bad = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir)) {
      const file = path.join(dir, entry);
      if (targets.includes(file)) continue;
      if (targets.some(target => inside(target, file))) visit(file); else bad.push(path.relative(home, file));
    }
  };
  visit(home);
  return bad;
}
function checkBoundary(rb, host) {
  const ns = rb && rb.ns;
  if (!rb || rb.uid === 0 || !Number.isInteger(rb.uid) || rb.noNewPrivs !== '1' || !Array.isArray(rb.caps) || rb.caps.length !== 5 || rb.caps.some(value => !/^0+$/.test(value)) ||
      rb.checkoutWrite !== 'EROFS' || rb.artifactWrite !== 'EROFS' || rb.tmpWrite !== 'WRITABLE' || JSON.stringify(rb.interfaces) !== '["lo"]' ||
      !Array.isArray(rb.homeUnexpected) || rb.homeUnexpected.length !== 0 || rb.vault !== 'ABSENT' || !(rb.gitEntries === 0 || rb.gitEntries === 'ENOENT') ||
      !host || !host.ns || !ns || ['net', 'mnt', 'pid'].some(key => typeof ns[key] !== 'string' || ns[key] === host.ns[key]) ||
      !/^[a-f0-9]{64}$/.test(rb.configSha256 || '') || rb.configSha256 !== host.configSha256) throw new Error('namespace boundary readback failed');
}
function namespaceReadback(config) {
  if (process.execPath !== config.node.path || process.env.FEE_NATIVE_NONCE !== config.nonce) throw new Error('stale or changed namespace configuration');
  const readback = identityReadback(config);
  checkIdentity(config, readback);
  assertNoPrivateVault(config.cwd);
  const status = Object.fromEntries(fs.readFileSync('/proc/self/status', 'utf8').split('\n').filter(line => line.includes(':')).map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
  const probe = dir => { const file = path.join(dir, 'fee-native-probe'); try { fs.closeSync(fs.openSync(file, 'wx')); fs.unlinkSync(file); return 'WRITABLE'; } catch (error) { return error.code; } };
  const git = path.join(config.cwd, '.git');
  let gitEntries;
  try { gitEntries = fs.statSync(git).isDirectory() ? fs.readdirSync(git).length : fs.statSync(git).size; } catch (error) { gitEntries = error.code; }
  Object.assign(readback, { uid: process.getuid(), noNewPrivs: status.NoNewPrivs, caps: ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map(key => status[key]),
    checkoutWrite: probe(config.cwd), artifactWrite: probe(config.artifact), tmpWrite: probe(process.env.TMPDIR), interfaces: Object.keys(require('node:os').networkInterfaces()),
    homeUnexpected: homeUnexpected(config.home, [config.cwd, config.artifact]), vault: 'ABSENT', gitEntries, ns: readNs(),
    configSha256: crypto.createHash('sha256').update(process.env.FEE_NATIVE_CONFIG).digest('hex') });
  checkBoundary(readback, { ns: config.hostNs, configSha256: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex') });
  return readback;
}
// H8: keep the early primary cause and the terminal context; the authored result is never truncated, it either fits the unchanged 1 MiB stream or fails explicitly.
function boundedLog(text, max) {
  const buf = Buffer.from(String(text));
  if (buf.length <= max) return buf.toString();
  if (max < 512) return '';
  const mark = '\n[... ' + (buf.length - max) + ' bytes elided ...]\n', budget = max - Buffer.byteLength(mark) - 8, head = Math.floor(budget / 4);
  return buf.subarray(0, head).toString() + mark + buf.subarray(buf.length - (budget - head)).toString();
}
function buildTrailer(parts, max = TRAILER_MAX) {
  const { receipt, log, result, runtime } = parts;
  const room = JSON.stringify({ receipt, log: '', result, runtime }).length;
  let bound = Math.min(262144, max - room);
  for (let i = 0; i < 16 && bound >= 512; i++) {
    const line = JSON.stringify({ receipt, log: boundedLog(log, bound), result, runtime }), size = Buffer.byteLength(line);
    if (size <= max) return line;
    bound -= size - max + 16;
  }
  const line = JSON.stringify({ receipt, log: '', result, runtime });
  if (Buffer.byteLength(line) <= max) return line;
  throw new Error('authored result exceeds the 1 MiB stream transport capacity');
}
async function namespaceInner() {
  const config = JSON.parse(process.env.FEE_NATIVE_CONFIG);
  const readback = namespaceReadback(config); // every identity and boundary check precedes the first browser, server or fixture launch
  process.stdout.write('FEE_NATIVE_READBACK ' + JSON.stringify(readback) + '\n');
  const invocation = crypto.randomUUID(), run = path.join(process.env.TMPDIR, 'run-' + invocation), output = path.join(process.env.TMPDIR, 'out');
  fs.mkdirSync(run); fs.mkdirSync(output);
  const clockFile = path.join(run, 'clock'), manifestFile = path.join(run, 'input.json'), resultFile = path.join(run, 'result.json');
  fs.writeFileSync(clockFile, String(CLOCK_EPOCH)); fs.writeFileSync(manifestFile, JSON.stringify(config.target));
  const reserve = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const fixturePort = await reserve(), appPort = await reserve();
  const env = { PATH: process.env.PATH, CI: 'true', HOME: run, TMPDIR: run, TMP: run, TEMP: run, XDG_CACHE_HOME: run, PLAYWRIGHT_BROWSERS_PATH: config.browsers,
    FEE_SERVER_INPUT: manifestFile, FEE_CLOCK_FILE: clockFile, FEE_RUNTIME_IDENTITY: path.join(run, 'runtime.json'), FEE_DEMAND_SCRATCH: run,
    FEE_DEMAND_RESULT_PATH: resultFile, FEE_INVOCATION: invocation, FEE_FIXTURE_PORT: String(fixturePort), FEE_DEMAND_APP_PORT: String(appPort) };
  const receipt = await runOwned({ cwd: config.cwd, args: [config.cli.path, 'test', '-c', 'playwright.fee-demand.config.ts'], env, scratch: run, output,
    profile: 'fee-demand-browser-v1', approval: BROWSER_APPROVAL, timeoutMs: NAMESPACE_INNER_MS, streamLimit: 524288, scratchLimit: BROWSER_NAMESPACE_MIB * 1048576 - 4194304 });
  const log = receipt.stdout; delete receipt.stdout;
  let ok = !receipt.reason && receipt.code === 0 && receipt.clean;
  let result = null, runtime = null;
  if (ok) {
    result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); runtime = JSON.parse(fs.readFileSync(env.FEE_RUNTIME_IDENTITY, 'utf8'));
    const fixture = receipt.processes.find(row => receipt.ports.some(item => item.port === fixturePort && item.pid === row.pid));
    if (!fixture || !receipt.ports.some(item => item.port === appPort)) throw new Error('missing owned server/fixture ports');
    runtime.fixturePid = fixture.pid;
  }
  let line;
  try { line = buildTrailer({ receipt, log, result, runtime }); } catch (error) {
    ok = false; receipt.reason ??= String(error.message);
    line = buildTrailer({ receipt, log, result: null, runtime: null });
  }
  process.stdout.write('FEE_NATIVE_RESULT ' + line + '\n');
  process.exitCode = ok && result && result.status === 'PASS' ? 0 : 1;
}
function leftovers(scratch, unterminated, patterns = []) {
  const cp = require('node:child_process'), problems = unterminated ? ['owned namespace not proven terminal'] : [];
  for (const pattern of [scratch, ...patterns]) {
    let status;
    try { status = cp.spawnSync(trustedExec('pgrep').path, ['-f', '--', pattern.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&')], { timeout: 2000, stdio: 'ignore' }).status; } catch (error) { status = 'error'; }
    if (status === 0) problems.push('process mentioning ' + path.basename(pattern) + ' survived'); else if (status !== 1) problems.push('process observation failed for ' + path.basename(pattern));
  }
  if (process.platform === 'linux') {
    try { if (fs.readFileSync('/proc/mounts', 'utf8').includes(scratch)) problems.push('scratch mount survived'); } catch (error) { problems.push('mount observation unavailable'); }
  }
  return problems;
}
// H5: birth identities (pid + start) are recorded while the tree is observed, so reparented descendants stay owned and a reused pid is never signalled.
async function launchBounded(argv, cwd, { outerMs = NAMESPACE_OUTER_MS, hardMs = NAMESPACE_HARD_MS } = {}) {
  const cp = require('node:child_process');
  const receipt = { streams: 0, signalled: [], killStatus: [], reason: null, code: null, signal: null, capped: false, timedOut: false, unterminated: false };
  const started = Date.now(), hard = started + hardMs, chunks = [], owned = new Map(), key = row => row.pid + ':' + row.start;
  const child = cp.spawn(argv[0], argv.slice(1), { cwd, detached: true, env: { PATH: SAFE_PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const observe = () => {
    const rows = processTable(), live = new Set(rows.map(key));
    const root = rows.find(row => row.pid === child.pid && row.ppid === process.pid);
    if (root) owned.set(key(root), root);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) if (!owned.has(key(row)) && [...owned.values()].some(parent => parent.pid === row.ppid && live.has(key(parent)))) { owned.set(key(row), row); grew = true; }
    }
    return rows;
  };
  const liveOwned = () => { const live = new Set(processTable().map(key)); return [...owned.values()].filter(row => live.has(key(row))); };
  const kill = () => {
    try {
      observe();
      const pids = liveOwned().map(row => row.pid);
      if (!pids.length) return;
      for (const pid of pids) if (!receipt.signalled.includes(pid)) receipt.signalled.push(pid);
      const limit = Math.max(500, Math.min(3000, hard - Date.now() - 500));
      const result = cp.spawnSync(argv[0], ['-n', receipt.killPath, '-KILL', ...pids.map(String)], { timeout: limit, stdio: 'ignore', env: { PATH: SAFE_PATH } });
      receipt.killStatus.push(result.error ? String(result.error.code || result.error) : result.status ?? 'signal:' + result.signal);
    } catch (error) { receipt.reason ??= 'owned namespace kill failed: ' + error; receipt.unterminated = true; }
  };
  receipt.killPath = argv.killPath;
  let closed = false;
  const done = new Promise(resolve => {
    child.once('error', error => { receipt.reason ??= String(error); closed = true; resolve(); });
    child.once('close', (code, signal) => { closed = true; receipt.code = code; receipt.signal = signal; receipt.seconds = (Date.now() - started) / 1000; resolve(); });
  });
  child.stdout.on('data', chunk => { receipt.streams += chunk.length; if (receipt.streams > NAMESPACE_STREAM) { receipt.reason ??= '1 MiB combined stream bound'; receipt.capped = true; kill(); } else chunks.push(chunk); });
  child.stderr.on('data', chunk => { receipt.streams += chunk.length; if (receipt.streams > NAMESPACE_STREAM) { receipt.reason ??= '1 MiB combined stream bound'; receipt.capped = true; kill(); } else chunks.push(chunk); });
  const sweep = setInterval(() => {
    try { observe(); } catch (error) { receipt.reason ??= 'ownership observation failed: ' + error; receipt.unterminated = true; }
    if (receipt.reason && !closed && Date.now() < hard - 500) kill();
  }, 50);
  const timer = setTimeout(() => { receipt.reason ??= 'native invocation bound including cleanup'; receipt.timedOut = true; kill(); }, outerMs);
  let hardTimer;
  try { await Promise.race([done, new Promise(resolve => { hardTimer = setTimeout(resolve, Math.max(1, hard - Date.now())); })]); } finally { clearTimeout(timer); clearTimeout(hardTimer); }
  if (!closed) { receipt.reason ??= 'namespace child did not terminate within the hard bound'; receipt.unterminated = true; child.stdout.destroy(); child.stderr.destroy(); }
  clearInterval(sweep);
  let survivors;
  try {
    survivors = liveOwned();
    if (survivors.length && Date.now() < hard - 500) {
      receipt.reason ??= 'owned descendants outlived the namespace root';
      kill();
      while (liveOwned().length && Date.now() < hard - 200) await new Promise(resolve => setTimeout(resolve, 50));
      survivors = liveOwned();
    }
  } catch (error) { receipt.reason ??= 'ownership observation failed: ' + error; survivors = null; }
  receipt.survivors = survivors === null ? null : survivors.length;
  if (survivors === null || survivors.length) { receipt.unterminated = true; receipt.reason ??= 'owned namespace processes survive'; }
  if (receipt.killStatus.some(status => status !== 0) && receipt.unterminated) receipt.reason = 'sudo kill reported ' + JSON.stringify(receipt.killStatus) + ' and owned processes survive; first cause: ' + receipt.reason;
  receipt.descendantsAbsent = survivors !== null && survivors.length === 0;
  return { receipt, text: Buffer.concat(chunks).toString(), started };
}
async function invoke(config, control, { outerMs, hardMs, patterns = [] } = {}) {
  verifyExec(config);
  const os = require('node:os'), parent = process.env.RUNNER_TOOL_CACHE || os.tmpdir();
  if (process.env.RUNNER_TOOL_CACHE && (inside(parent, config.home) || inside(parent, config.cwd))) throw new Error('scratch parent must be outside masked roots');
  const scratch = fs.mkdtempSync(path.join(parent, 'fee-native-'));
  const argv = frozenArgv(config, scratch, process.getuid(), process.getgid(), control);
  argv.killPath = config.exec.kill.path;
  const run = await launchBounded(argv, config.cwd, { outerMs, hardMs });
  const receipt = run.receipt;
  delete receipt.killPath;
  receipt.argvSha256 = crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex');
  receipt.scratch = scratch;
  receipt.leftovers = leftovers(scratch, receipt.unterminated, patterns);
  if (receipt.leftovers.length) receipt.reason ??= 'cleanup: ' + receipt.leftovers.join('; ');
  if (!receipt.unterminated && !receipt.leftovers.length) fs.rmSync(scratch, { recursive: true, force: true });
  receipt.scratchRemoved = !fs.existsSync(scratch);
  receipt.elapsedMs = Date.now() - run.started;
  return { receipt, text: run.text, started: run.started };
}
function finishReceipt(receipt) {
  if (!(receipt.elapsedMs <= 120000)) receipt.reason ??= 'native invocation exceeded total time bound';
  receipt.clean = !receipt.reason && receipt.descendantsAbsent && receipt.scratchRemoved && !receipt.leftovers.length;
}
async function runNamespace(config, { outerMs = NAMESPACE_OUTER_MS, hardMs = NAMESPACE_HARD_MS } = {}) {
  const { receipt, text } = await invoke(config, null, { outerMs, hardMs });
  const line = prefix => { const row = text.split('\n').find(item => item.startsWith(prefix)); return row && JSON.parse(row.slice(row.indexOf(' ') + 1)); };
  let readback = null, trailer = null;
  try {
    readback = line('FEE_NATIVE_READBACK ');
    if (readback) {
      checkIdentity(config, readback);
      checkBoundary(readback, { ns: config.hostNs, configSha256: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex') });
    }
    trailer = line('FEE_NATIVE_RESULT ');
  } catch (error) { receipt.reason ??= String(error.message); }
  if (!receipt.reason && receipt.code !== 0) receipt.reason = trailer?.receipt?.reason || 'namespace exit ' + receipt.code + ' signal ' + receipt.signal;
  if (!receipt.reason && (!readback || !trailer?.result || trailer.receipt?.clean !== true || trailer.receipt.code !== 0)) receipt.reason = 'missing readback or result';
  finishReceipt(receipt);
  receipt.readback = readback; receipt.inner = trailer?.receipt ?? null;
  return { receipt, log: trailer?.log ?? boundedLog(text, 262144), result: receipt.reason ? null : trailer.result, runtime: receipt.reason ? null : trailer.runtime };
}
// H4: judge the supplied frozen controls exactly; a missing or malformed observation is a failure, never an inferred pass.
function judgeGuard(name, res) {
  if (res.leftovers.length) return 'cleanup: ' + res.leftovers.join('; ');
  if (name === 'FLOOD') return res.capped && !res.timedOut ? null : 'flood not cut by output cap';
  if (name === 'SLEEP') return ([124, 137].includes(res.code) || res.signal === 'SIGKILL') && !res.capped && !res.timedOut && res.seconds >= 1.9 && res.seconds < 12 ? null : 'hung command not killed by wall limit';
  if (res.code !== 0 || res.timedOut || res.capped) return 'control failed to run: ' + String(res.text).slice(0, 800);
  if (name === 'SURVIVOR') return null;
  let j;
  try { j = JSON.parse(res.text.trim().split('\n').pop()); } catch (error) { return 'unparseable control output: ' + String(res.text).slice(0, 300); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'control output is not an object';
  const keys = value => JSON.stringify(Object.keys(value).sort());
  const wr = value => Number.isInteger(value) && WRITE_DENIALS.includes(value), rd = value => typeof value === 'string' && READ_DENIALS.includes(value);
  const nm = value => typeof value === 'string' && SOCKET_DENIALS.includes(value);
  let ok = false;
  if (name === 'EGRESS') ok = keys(j) === keys({ loopback: 1, '192.0.2.1': 1, '1.1.1.1': 1 }) && j.loopback === 'OK' && nm(j['192.0.2.1']) && nm(j['1.1.1.1']);
  else if (name === 'PRIVATE') { const o = j.outside; ok = keys(j) === keys({ home_canary: 1, git_head: 1, outside: 1 }) && o && typeof o === 'object' && keys(o) === keys({ checkout: 1, home: 1, host_dir: 1 }) && rd(j.home_canary) && rd(j.git_head) && o.host_dir === 'ABSENT' && wr(o.checkout) && wr(o.home); }
  else if (name === 'PRIVS') { const c = j.caps; ok = keys(j) === keys({ nnp: 1, caps: 1, sudo: 1, setuid0: 1, mount: 1 }) && c && keys(c) === keys({ CapInh: 1, CapPrm: 1, CapEff: 1, CapBnd: 1, CapAmb: 1 }) && Object.values(c).every(v => /^0+$/.test(v)) && j.nnp === 1 && j.sudo === 'DENIED' && j.setuid0 === 'EPERM' && j.mount === 'DENIED'; }
  else if (name === 'WRITES') ok = keys(j) === keys({ checkout: 1, home: 1, scratch: 1 }) && wr(j.checkout) && wr(j.home) && j.scratch === 'WRITABLE';
  else if (name === 'OVERLIMIT') ok = keys(j) === keys({ errno: 1, mib: 1 }) && j.errno === 28 && Number.isInteger(j.mib) && j.mib >= 1 && j.mib <= 4; // ENOSPC
  return ok ? null : 'guard denial missing or incomplete: ' + JSON.stringify(j).slice(0, 500);
}
async function runGuardControls(config, { hardMs } = {}) {
  for (const [name, body] of Object.entries(GUARD_CONTROLS)) if (crypto.createHash('sha256').update(body).digest('hex') !== GUARD_CONTROL_SHA256[name]) throw new Error('frozen guard control changed: ' + name);
  const py = config.exec.python3.path, canaryDir = fs.mkdtempSync(path.join(config.home, '.fee-guard-')); // authored, credential-free private canary
  fs.writeFileSync(path.join(canaryDir, 'canary'), 'x');
  const marker = 'fee-marker-' + process.pid, survivor = 'fee-survivor-' + process.pid, results = {}, receipts = [];
  const argvFor = { EGRESS: [], PRIVATE: [path.join(canaryDir, 'canary'), config.cwd, canaryDir, marker, config.home], PRIVS: [], WRITES: [config.cwd, config.home], OVERLIMIT: [], FLOOD: [], SLEEP: [], SURVIVOR: [survivor] };
  try {
    for (const [name, plan] of Object.entries(GUARD_CONTROL_PLAN)) {
      const run = await invoke({ ...config, ...plan, approval: undefined }, [py, '-c', GUARD_CONTROLS[name], ...argvFor[name]], { hardMs, patterns: name === 'SURVIVOR' ? [survivor] : [] });
      const r = run.receipt;
      const why = judgeGuard(name, { code: r.code, signal: r.signal, capped: r.capped, timedOut: r.timedOut, seconds: r.seconds, leftovers: r.leftovers, text: run.text });
      r.clean = !r.reason?.startsWith('cleanup') && r.descendantsAbsent && r.scratchRemoved && !r.leftovers.length;
      receipts.push(r);
      results[name] = { status: why ? 'FAIL' : 'PASS', why, code: r.code, seconds: r.seconds, stdout: run.text.slice(0, 600), argvSha256: r.argvSha256, bodySha256: GUARD_CONTROL_SHA256[name] };
      if (why) break;
    }
    const leaked = ['/tmp', '/var/tmp', '/dev/shm'].filter(dir => fs.existsSync(path.join(dir, marker)));
    if (leaked.length && results.PRIVATE) { results.PRIVATE.status = 'FAIL'; results.PRIVATE.why = 'marker leaked to host ' + leaked.join(','); }
  } finally { fs.rmSync(canaryDir, { recursive: true, force: true }); }
  const ok = Object.keys(GUARD_CONTROL_PLAN).every(name => results[name] && results[name].status === 'PASS');
  return { ok, results, receipts, na: GUARD_NA };
}
async function nativeRun(inputFile) {
  const targets=validateInputs(JSON.parse(fs.readFileSync(inputFile,'utf8')));
  const cwd=process.cwd(),output=path.resolve(process.env.FEE_DEMAND_OUTPUT||'test-results/fee-demand');
  fs.mkdirSync(output,{recursive:true});
  if(treeBytes(output)>2097152)throw new Error('preexisting output exceeds 2 MiB');
  const before=inputIdentity(cwd,targets),runs=[],cleanup=[];
  const scratch=fs.mkdtempSync(path.join(output,'owned-'));
  let after,primaryError;
  let guards;
  try {
    const order=targets.length===1?[targets[0],targets[0]]:Array.from({length:10},(_,i)=>i%2?[targets[1],targets[0]]:[targets[0],targets[1]]).flat();
    for(const [index,target]of order.entries()){
      validateInputs(targets,cwd);
      if(process.env.FEE_NATIVE_PROFILE==='namespace-v1') {
        const nsConfig=namespaceConfig(target,cwd);
        if(!guards){
          guards=await runGuardControls(nsConfig);
          cleanup.push(...guards.receipts);
          fs.writeFileSync(path.join(output,'native-guards.json'),JSON.stringify({ok:guards.ok,results:guards.results,na:guards.na}));
          if(!guards.ok)throw new Error('guard controls failed, app not run: '+Object.entries(guards.results).filter(([,v])=>v.status!=='PASS').map(([k,v])=>k+': '+v.why).join('; '));
        }
        const run=await runNamespace(nsConfig);
        cleanup.push(run.receipt);
        fs.writeFileSync(path.join(output,'native-'+index+'.txt'),run.log);
        if(!run.receipt.clean)throw new Error(run.receipt.reason||'namespace invocation failed');
        after=inputIdentity(cwd,targets);
        if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('source/build/input mutated');
        if(run.result.status!=='PASS')throw new Error('native outcomes failed');
        const observations=validateObservations(run.result.observations);
        runs.push({target,runtime:run.runtime,observations});
        fs.writeFileSync(path.join(output,'observations-'+index+'.json.gz'),require('node:zlib').gzipSync(JSON.stringify({target,runtime:run.runtime,observations})));
        if(treeBytes(output,scratch)>2097152)throw new Error('2 MiB output artifact bound');
        continue;
      }
      const runDir=path.join(scratch,String(index));fs.mkdirSync(runDir);
      const clockFile=path.join(runDir,'clock'),manifestFile=path.join(runDir,'input.json'),resultFile=path.join(runDir,'result.json');
      fs.writeFileSync(clockFile,String(CLOCK_EPOCH));
      fs.writeFileSync(manifestFile,JSON.stringify(target));
      const reserve=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})});
      const fixturePort=await reserve(),appPort=await reserve();
      const invocation=crypto.randomUUID();
      const env={
        PATH:process.env.PATH,CI:'true',HOME:runDir,TMPDIR:runDir,TMP:runDir,TEMP:runDir,XDG_CACHE_HOME:runDir,
        PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH||path.join(require('node:os').homedir(),process.platform==='darwin'?'Library/Caches/ms-playwright':'.cache/ms-playwright'),
        FEE_SERVER_INPUT:manifestFile,FEE_CLOCK_FILE:clockFile,FEE_RUNTIME_IDENTITY:path.join(runDir,'runtime.json'),
        FEE_DEMAND_SCRATCH:runDir,FEE_DEMAND_RESULT_PATH:resultFile,FEE_INVOCATION:invocation,
        FEE_FIXTURE_PORT:String(fixturePort),FEE_DEMAND_APP_PORT:String(appPort),
      };
      const receipt=await runOwned({cwd,args:[require.resolve('@playwright/test/cli'),'test','-c','playwright.fee-demand.config.ts'],env,scratch:runDir,output,
        profile:'fee-demand-browser-v1',approval:'781cd061013ec6227385fb3b8b6a29766df50747a867e537c41ab6f9480472c3'});
      const log=receipt.stdout;delete receipt.stdout;cleanup.push(receipt);
      fs.writeFileSync(path.join(output,'native-'+index+'.txt'),log);
      if(receipt.reason||receipt.code!==0||!receipt.clean)throw new Error(receipt.reason||'native invocation failed: '+receipt.code);
      after=inputIdentity(cwd,targets);
      if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('source/build/input mutated');
      const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));
      if(result.status!=='PASS')throw new Error('native outcomes failed');
      const runtime=JSON.parse(fs.readFileSync(env.FEE_RUNTIME_IDENTITY,'utf8'));
      const fixtureIdentity=receipt.processes.find(row=>receipt.ports.some(p=>p.port===fixturePort&&p.pid===row.pid));
      if(!fixtureIdentity||!receipt.ports.some(p=>p.port===appPort))throw new Error('missing owned server/fixture ports');
      runtime.fixturePid=fixtureIdentity.pid;
      const observations=validateObservations(result.observations);
      runs.push({target,runtime,observations});
      fs.writeFileSync(path.join(output,'observations-'+index+'.json.gz'),require('node:zlib').gzipSync(JSON.stringify({target,runtime,observations})));
      if(treeBytes(output,scratch)>2097152)throw new Error('2 MiB output artifact bound');
      fs.rmSync(runDir,{recursive:true,force:true});
    }
    compareRuns(runs,targets.length===2);
    fs.writeFileSync(path.join(output,'native-result.json'),JSON.stringify({status:'PASS',runs:runs.map((run,index)=>({target:run.target,runtime:run.runtime,observations:'observations-'+index+'.json.gz'}))}));
  } catch(error) {
    primaryError=error;
    throw error;
  } finally {
    try {
      let identityError=null;
      try{after=inputIdentity(cwd,targets)}catch(error){identityError=String(error)}
      const terminal=cleanup.every(r=>r.clean);
      if(terminal)fs.rmSync(scratch,{recursive:true,force:true});
      fs.writeFileSync(path.join(output,'native-cleanup.json'),JSON.stringify({removed:!fs.existsSync(scratch),before,after:after??null,identityError,primaryError:primaryError?String(primaryError):null,immutable:identityError===null&&JSON.stringify(before)===JSON.stringify(after),invocations:cleanup}));
      if(treeBytes(output)>2097152)throw new Error('2 MiB output artifact bound including receipts');
      if(identityError)throw new Error(identityError);
      if(!terminal)throw new Error('owned runtime not proven terminal; scratch retained');
    } catch(cleanupError) {
      if(primaryError)process.stderr.write('secondary cleanup failure: '+String(cleanupError)+'\n');
      else throw cleanupError;
    }
  }
}
if(require.main===module) {
  (async()=>{
    if(process.argv[2]==='--native')return nativeRun(path.resolve(process.argv[3]));
    if(process.argv[2]==='--namespace-inner')return namespaceInner();
    if(process.argv[2]==='--baseline') {
      const cp=require('node:child_process'),cwd=process.cwd(),artifact=path.resolve(process.argv[3]),revision=process.argv[4];
      if(cp.execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim()!==revision)throw new Error('false source revision');
      cp.execFileSync('git',['diff','--exit-code','HEAD','--','src','next.config.ts','package.json','pnpm-lock.yaml'],{cwd,stdio:'pipe'});
      const input={label:'baseline',phase:'baseline',artifact,revision,artifactSha256:artifactDigest(artifact),instrumentation:digest(INSTRUMENTATION.map(f=>path.join(cwd,f))),runtime:process.version,clock:CLOCK_EPOCH};
      const file=path.resolve(process.env.FEE_DEMAND_OUTPUT||'test-results/fee-demand','baseline-input.json');
      fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify([input]));
      return nativeRun(file);
    }
    throw new Error('explicit --native INPUT or --baseline READ_ONLY_ARTIFACT REVISION required');
  })().catch(error=>{process.stderr.write(String(error.stack)+'\n');process.exitCode=1});
}
function installClock(file) {
  const { mock } = require('node:test');
  const realInterval = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let now = Number(fs.readFileSync(file,'utf8'));
  if (now !== CLOCK_EPOCH) throw new Error('clock must begin at the admitted epoch');
  mock.timers.enable({ apis: ['Date','setTimeout','setInterval'], now });
  const poll = realInterval(() => {
    const next = Number(fs.readFileSync(file,'utf8'));
    if (!Number.isSafeInteger(next) || next < now || next > CLOCK_EPOCH + 3600000) throw new Error('invalid shared clock advance');
    mock.timers.tick(next-now); now=next;
  }, 10);
  poll.unref();
  return () => { realClear(poll); mock.timers.reset(); };
}
Object.assign(module.exports,{GUARD_SCRIPT_SHA256,GUARD_CONTROLS,GUARD_CONTROL_SHA256,GUARD_NA,namespaceConfig,frozenArgv,identityReadback,checkIdentity,checkBoundary,runNamespace,runGuardControls,judgeGuard,boundedLog,buildTrailer,homeUnexpected,assertNoPrivateVault,writableBudget,artifactDigest,digest,validateInputs,installClock,CLOCK_EPOCH,INSTRUMENTATION,runOwned,nativeRun,validateObservations,compareRuns,EXPECTED_SCENARIOS,treeBytes,inputIdentity,processTable});
if (process.env.FEE_OWNERSHIP_FILE) {
  const ownership=process.env.FEE_OWNERSHIP_FILE;
  const record=event=>fs.appendFileSync(ownership,JSON.stringify(event)+'\n');
  record({pid:process.pid,ppid:process.ppid});
  const childProcess=require('node:child_process'),spawn=childProcess.spawn;
  childProcess.spawn=function(...args){const child=spawn.apply(this,args);child.once('spawn',()=>record({pid:child.pid,ppid:process.pid}));return child;};
  const emit=net.Server.prototype.emit;
  net.Server.prototype.emit=function(event,...args){
    if(event==='listening'){const address=this.address();if(address&&typeof address==='object')record({pid:process.pid,port:address.port});}
    return emit.call(this,event,...args);
  };
}
if (process.env.FEE_CLOCK_FILE && process.env.FEE_SERVER_INPUT &&
    path.resolve(process.argv[1]||'')===path.join(JSON.parse(fs.readFileSync(process.env.FEE_SERVER_INPUT,'utf8')).artifact,'server.js')) {
  const target = validateInputs([JSON.parse(fs.readFileSync(process.env.FEE_SERVER_INPUT,'utf8'))],process.cwd(),true)[0];
  if (path.resolve(process.argv[1]) !== path.join(target.artifact,'server.js')) throw new Error('runtime entry differs from frozen input');
  installClock(process.env.FEE_CLOCK_FILE);
  fs.writeFileSync(process.env.FEE_RUNTIME_IDENTITY,JSON.stringify({pid:process.pid,processStart:processTable().find(row=>row.pid===process.pid).start,invocation:process.env.FEE_INVOCATION,cache:process.env.HOME,entry:process.argv[1],...target}));
}
