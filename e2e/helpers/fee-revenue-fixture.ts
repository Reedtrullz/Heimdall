import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Authored, offline upstream fixture for the Portfolio fee-demand measurement.
 * It stands in for the primary Midgard, fallback Midgard and THORNode
 * endpoints so the real Next proxy work is observable without external network.
 */

export type FeeFixtureMode = 'ok' | 'malformed' | 'stale' | 'source-failure' | 'rate-limit' | 'pending';

export interface FeeFixtureRequest {
  kind: string;
  path: string;
  mode: FeeFixtureMode;
  status: number;
  bytes: number;
  at: number;
}

export interface FeeFixtureSnapshot {
  clock: string;
  seed: number;
  mode: FeeFixtureMode;
  total: number;
  upstreamBytes: number;
  attempts: Record<string, number>;
  bytesByKey: Record<string, number>;
  unhandled: number;
  limitExceeded: boolean;
  pending: number;
  requests: FeeFixtureRequest[];
  truncated: boolean;
}

export interface FeeFixture {
  origin: string;
  port: number;
  getMode(): FeeFixtureMode;
  setMode(mode: FeeFixtureMode): void;
  reset(): void;
  snapshot(): FeeFixtureSnapshot;
  advance(ms: number): void;
  close(): Promise<void>;
}

export const FEE_FIXTURE_CLOCK = '2026-10-26T00:00:00.000Z';
export const FEE_FIXTURE_SEED = 46;
export const FEE_EARNINGS_PROXY_PATH = '/api/midgard/v2/history/earnings';

export const FEE_ADDRESS_A = 'thor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq4yeyjz';
export const FEE_ADDRESS_B = 'thor1qyqszqgpqyqszqgpqyqszqgpqyqszqgp55c9cr';
export const FEE_ADDRESS_INVALID = 'thor1not-a-valid-thorchain-address';

// Reused verbatim from the authored public Portfolio e2e fixture.
export const FEE_EARNINGS_HISTORY = {
  meta: {
    startTime: '1699990000000000000',
    endTime: '1700010000000000000',
    liquidityFees: '100000000',
    blockRewards: '50000000',
    earnings: '150000000',
    bondingEarnings: '50000000',
    liquidityEarnings: '100000000',
    avgNodeCount: '2',
    runePriceUSD: '1.50',
    pools: [],
  },
  intervals: [
    {
      startTime: '1699990000000000000',
      endTime: '1700010000000000000',
      liquidityFees: '100000000',
      blockRewards: '50000000',
      earnings: '150000000',
      bondingEarnings: '50000000',
      liquidityEarnings: '100000000',
      avgNodeCount: '2',
      runePriceUSD: '1.50',
      pools: [],
    },
  ],
};

export const FEE_STALE_EARNINGS_HISTORY = {
  ...FEE_EARNINGS_HISTORY,
  intervals: [],
};

const MIDGARD_PREFIXES = ['/midgard-primary', '/midgard-fallback'];
const THORNODE_PREFIX = '/thornode';
const MAX_LOG = 200;
const MAX_BODY_BYTES = 256 * 1024;

const mockNodes = [
  {
    node_address: 'thor1nodeportfolio123456789abcdef',
    status: 'Active',
    pub_key_set: {
      secp256k1: '03a2bcde3f45678901234567890123456789012345678901234567890123456',
      ed25519: '02b3e5ef789012345678901234567890123456789012345678901234567890123',
    },
    validator_cons_pub_key: 'thorvalconspub1zcjduepq2w6r4z2h3ujnsn3e8qjjjl7r2h9u2d4z2h3ujnsn3e8qjjjl7r2h9u2d',
    peer_id: '16Uvh8Eh8J3fG3YDCK4f4W2c5b6d7e8f9a0b1c2d3e4f',
    active_block_height: 12345678,
    status_since: 1700000000,
    node_operator_address: 'thor1operator123456789abcdef',
    total_bond: '2500000000000',
    bond_providers: {
      node_operator_fee: '2000',
      providers: [
        { bond_address: FEE_ADDRESS_A, bond: '1250000000000' },
        { bond_address: FEE_ADDRESS_B, bond: '750000000000' },
      ],
    },
    signer_membership: ['02a1bcde3f45678901234567890123456789012345678901234567890123456'],
    requested_to_leave: false,
    forced_to_leave: false,
    leave_height: 0,
    ip_address: '10.0.0.1',
    version: '3.19.0',
    slash_points: 25,
    jail: {},
    current_award: '250000000',
    observe_chains: [{ chain: 'BTC', height: 850000 }],
    preflight_status: { status: 'ok', reason: '', code: 0 },
    maintenance: false,
    missing_blocks: 0,
  },
];

const mockMemberDetails = {
  pools: [
    {
      pool: 'BTC.BTC',
      runeAddress: FEE_ADDRESS_A,
      assetAddress: 'bc1portfolioasset123456',
      liquidityUnits: '1000',
      runeDeposit: '5000000000',
      assetDeposit: '250000000',
      runeAdded: '5000000000',
      assetAdded: '250000000',
      runePending: '0',
      assetPending: '0',
      runeWithdrawn: '0',
      assetWithdrawn: '0',
      dateFirstAdded: '1700000000000000000',
      dateLastAdded: '1700500000000000000',
    },
  ],
};

const mockPools = [
  {
    asset: 'BTC.BTC',
    volume24h: '900000000',
    assetDepth: '500000000000',
    runeDepth: '250000000000',
    assetPrice: '0.75',
    assetPriceUSD: '0.75',
    annualPercentageRate: '0.125',
    poolAPY: '12.5',
    earnings: '0',
    earningsAnnualAsPercentOfDepth: '0',
    lpLuvi: '0',
    saversAPR: '0',
    status: 'available',
    liquidityUnits: '1000',
    synthUnits: '0',
    synthSupply: '0',
    units: '0',
    nativeDecimal: '8',
    saversUnits: '0',
    saversDepth: '0',
    totalCollateral: '0',
    totalDebtTor: '0',
    saversYieldShare: '0',
    depthPlus2Percent: '0',
    depthMinus2Percent: '0',
  },
];

const mockNetwork = {
  activeBonds: ['150000000000000', '100000000000000'],
  activeNodeCount: '2',
  standbyBonds: ['50000000000000'],
  standbyNodeCount: '1',
  totalPooledRune: '100000000000000',
  totalReserve: '45000000000000',
  bondMetrics: {
    totalActiveBond: '200000000000000',
    totalStandbyBond: '50000000000000',
    averageActiveBond: '105000000000000',
    averageStandbyBond: '50000000000000',
    medianActiveBond: '105000000000000',
    minimumActiveBond: '100000000000000',
    maximumActiveBond: '110000000000000',
    bondHardCap: '110000000000000',
  },
  bondingAPY: '0.25',
  liquidityAPY: '0.15',
  blockRewards: {
    blockReward: '14000',
    bondReward: '14000',
    poolReward: '0',
  },
  nextChurnHeight: '25700000',
  poolActivationCountdown: '28800',
};

function authoredBody(kind: string, path: string, url: URL, now: number): unknown | null {
  const address = path.split('/').pop();
  const publicAddress = address === FEE_ADDRESS_A || address === FEE_ADDRESS_B;
  if (address === FEE_ADDRESS_INVALID) {
    if (path === `v2/member/${address}`) return { pools: [] };
    if (path === `v2/bonds/${address}`) return { address, totalBonded: '0', nodes: [] };
    if (path === `v2/thorname/rlookup/${address}`) return { entry: null };
    if (path === `cosmos/bank/v1beta1/balances/${address}`) return { balances: [] };
  }
  if (kind === 'midgard') {
    if (path === 'v2/health') return { lastThorNode: { height: 12345678 } };
    if (path === 'v2/network') return mockNetwork;
    if (path === 'v2/pools') return mockPools;
    if (path === 'v2/churns') return [];
    if (path === 'v2/actions') return { actions: [], count: '0' };
    if (path === 'v2/history/rune') {
      const from = Number(url.searchParams.get('from'));
      const historical = url.searchParams.has('from') && from < now / 1000 - 30 * 86400;
      const start = historical ? from : Math.floor(now / 1000) - 3600;
      const end = historical ? Number(url.searchParams.get('to')) : Math.floor(now / 1000);
      const price = historical ? '0.50' : '1.50';
      return { meta: { startTime: String(start), endTime: String(end), startRunePriceUSD: price, endRunePriceUSD: price },
        intervals: [{ startTime: String(start), endTime: String(end), runePriceUSD: price }] };
    }
    if (path === 'v2/pools/BTC.BTC/history') return { intervals: [{
      startTime: url.searchParams.get('from') ?? '1699990000',
      endTime: url.searchParams.get('to') ?? '1700010000',
      runeDepth: '250000000000', assetDepth: '500000000000', liquidityUnits: '1000',
      synthSupply: '0', synthDepth: '0', lpUnits: '0', membersCount: '1', status: 'available',
    }] };
    if (publicAddress && path === `v2/thorname/rlookup/${address}`) return { entry: null };
    if (publicAddress && path === `v2/member/${address}`) return {
      ...mockMemberDetails, pools: mockMemberDetails.pools.map(pool => ({ ...pool, runeAddress: address })),
    };
    if (publicAddress && path === `v2/bonds/${address}`) return {
      address, totalBonded: address === FEE_ADDRESS_B ? '750000000000' : '1250000000000',
      nodes: [{ address: mockNodes[0].node_address, bond: address === FEE_ADDRESS_B ? '750000000000' : '1250000000000', status: 'Active' }],
    };
    return null;
  }
  if (path === 'nodes') return mockNodes;
  if (path === 'constants') return { int_64_values: { MaxBondProviders: 100 }, bool_values: {}, string_values: {} };
  if (path === 'version') return { current: '3.19.0', next: '3.19.0', querier: '3.19.0' };
  if (publicAddress && path === `cosmos/bank/v1beta1/balances/${address}`) return {
    balances: [{ denom: 'rune', amount: '10000000000' }], pagination: { next_key: null, total: '1' },
  };
  if (publicAddress && path === `pool/BTC.BTC/liquidity_provider/${address}`) return {
    rune_address: address, asset_address: 'bc1portfolioasset123456',
    rune_deposit_value: '5000000000', asset_deposit_value: '250000000',
    rune_redeem_value: '5250000000', asset_redeem_value: '260000000',
    units: '1000', pending_rune: '0', pending_asset: '0', last_add_height: 12340000, last_withdraw_height: 0,
  };
  return null;
}

function classify(url: string): { kind: string; path: string } | null {
  const pathname = url.split('?')[0];
  for (const prefix of MIDGARD_PREFIXES) {
    if (pathname.startsWith(`${prefix}/`)) {
      return { kind: 'midgard', path: pathname.slice(prefix.length + 1) };
    }
  }
  if (pathname.startsWith(`${THORNODE_PREFIX}/`)) {
    const rest = pathname.slice(THORNODE_PREFIX.length + 1);
    return { kind: 'thornode', path: rest.startsWith('thorchain/') ? rest.slice('thorchain/'.length) : rest };
  }
  return null;
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve({});
      }
    });
    request.on('error', reject);
  });
}

export async function startFeeRevenueFixture(
  options: { port?: number; host?: string; mode?: FeeFixtureMode } = {}
): Promise<FeeFixture> {
  let mode: FeeFixtureMode = options.mode ?? 'ok';
  let requests: FeeFixtureRequest[] = [];
  let truncated = false;
  let upstreamBytes = 0;
  let total = 0;
  let unhandled = 0;
  let attempts: Record<string, number> = {};
  let bytesByKey: Record<string, number> = {};
  let now = Date.parse(FEE_FIXTURE_CLOCK);
  let limitExceeded = false;
  const pending = new Set<ServerResponse>();

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  function send(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body)),
      ...headers,
    });
    response.end(body);
  }

  function record(kind: string, path: string, status: number, bytes: number) {
    const key = `${kind}:${path}`;
    total += 1;
    if (total > 1000) limitExceeded = true;
    attempts[key] = (attempts[key] ?? 0) + 1;
    if (kind === 'unhandled') unhandled += 1;
    accountBytes(key, bytes);
    if (requests.length >= MAX_LOG) {
      truncated = true;
      return;
    }
    requests.push({ kind, path, mode, status, bytes, at: now });
  }

  function accountBytes(key: string, bytes: number) {
    upstreamBytes += bytes;
    bytesByKey[key] = (bytesByKey[key] ?? 0) + bytes;
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (process.env.FEE_CLOCK_FILE) now = Number(readFileSync(process.env.FEE_CLOCK_FILE, 'utf8'));
    const url = request.url ?? '/';
    const pathname = url.split('?')[0];

    if (pathname === '/-/ready') {
      send(response, 200, JSON.stringify({ ready: true, clock: FEE_FIXTURE_CLOCK, seed: FEE_FIXTURE_SEED }));
      return;
    }
    if (pathname === '/-/snapshot') {
      send(response, 200, JSON.stringify(snapshot()));
      return;
    }
    if (pathname === '/-/mode' && request.method === 'POST') {
      const body = await readJson(request);
      const next = body.mode;
      if (next === 'ok' || next === 'malformed' || next === 'stale' || next === 'source-failure' || next === 'rate-limit' || next === 'pending') {
        mode = next;
        send(response, 200, JSON.stringify({ mode }));
        return;
      }
      send(response, 400, JSON.stringify({ error: 'unknown fixture mode' }));
      return;
    }
    if (pathname === '/-/reset' && request.method === 'POST') {
      if (pending.size) { send(response, 409, JSON.stringify({ error: 'pending requests must be released first' })); return; }
      reset();
      send(response, 200, JSON.stringify({ reset: true }));
      return;
    }
    if (pathname === '/-/release' && request.method === 'POST') {
      const body = JSON.stringify(FEE_EARNINGS_HISTORY);
      for (const held of pending) {
        if (!held.destroyed) {
          accountBytes('midgard:v2/history/earnings', Buffer.byteLength(body));
          send(held, 200, body);
        }
      }
      pending.clear();
      mode = 'ok';
      send(response, 200, JSON.stringify({ released: true }));
      return;
    }
    if (pathname === '/-/advance' && request.method === 'POST') {
      const body = await readJson(request);
      if (!Number.isSafeInteger(body.ms) || Number(body.ms) < 0 || Number(body.ms) > 600000) {
        send(response, 400, JSON.stringify({ error: 'invalid clock advance' }));
        return;
      }
      advance(Number(body.ms));
      send(response, 200, JSON.stringify({ now }));
      return;
    }

    const target = classify(url);
    if (!target) {
      const body = JSON.stringify({ error: 'fixture path not authored', path: pathname });
      record('unhandled', pathname, 404, Buffer.byteLength(body));
      send(response, 404, body);
      return;
    }
    if (total >= 1000) {
      limitExceeded = true;
      const body = JSON.stringify({ error: 'fixture request bound exceeded' });
      record(target.kind, target.path, 507, Buffer.byteLength(body));
      send(response, 507, body);
      return;
    }

    const isEarnings = target.kind === 'midgard' && target.path === 'v2/history/earnings';
    if (isEarnings && mode === 'pending') {
      record(target.kind, target.path, 0, 0);
      pending.add(response);
      response.once('close', () => pending.delete(response));
      return;
    }

    if (mode === 'rate-limit') {
      const body = JSON.stringify({ error: 'fixture rate limited' });
      record(target.kind, target.path, 429, Buffer.byteLength(body));
      send(response, 429, body, { 'retry-after': '2' });
      return;
    }
    if (mode === 'source-failure') {
      const body = JSON.stringify({ error: 'fixture upstream unavailable' });
      record(target.kind, target.path, 503, Buffer.byteLength(body));
      send(response, 503, body);
      return;
    }
    if (isEarnings) {
      if (mode === 'malformed') {
        const body = '{"meta":{"startTime":"1699990000000000000"},"intervals":[{"startTime":';
        record(target.kind, target.path, 200, Buffer.byteLength(body));
        send(response, 200, body);
        return;
      }
      const payload = mode === 'stale' ? FEE_STALE_EARNINGS_HISTORY : FEE_EARNINGS_HISTORY;
      const body = JSON.stringify(payload);
      record(target.kind, target.path, 200, Buffer.byteLength(body));
      send(response, 200, body);
      return;
    }

    const authored = authoredBody(target.kind, target.path, new URL(url, 'http://fixture'), now);
    if (authored === null) {
      const body = JSON.stringify({ error: 'fixture path not authored', path: target.path });
      record('unhandled', `${target.kind}:${target.path}`, 404, Buffer.byteLength(body));
      send(response, 404, body);
      return;
    }
    const body = JSON.stringify(authored);
    record(target.kind, target.path, 200, Buffer.byteLength(body));
    send(response, 200, body);
  }

  function reset() {
    requests = [];
    upstreamBytes = 0;
    truncated = false;
    total = 0;
    unhandled = 0;
    attempts = {};
    bytesByKey = {};
    limitExceeded = false;
  }

  function advance(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 600000) throw new Error('invalid clock advance');
    now += ms;
    if (process.env.FEE_CLOCK_FILE) writeFileSync(process.env.FEE_CLOCK_FILE, String(now));
  }

  function snapshot(): FeeFixtureSnapshot {
    return {
      clock: new Date(now).toISOString(),
      seed: FEE_FIXTURE_SEED,
      mode,
      total,
      upstreamBytes,
      attempts: { ...attempts },
      bytesByKey: { ...bytesByKey },
      unhandled,
      limitExceeded,
      pending: pending.size,
      requests: requests.map((entry) => ({ ...entry })),
      truncated,
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    getMode: () => mode,
    setMode: (next) => {
      mode = next;
    },
    reset,
    snapshot,
    advance,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

async function startFromEnv() {
  const port = Number(process.env.FEE_FIXTURE_PORT ?? '4321');
  const fixture = await startFeeRevenueFixture({ port });
  process.stdout.write(`${JSON.stringify({ event: 'fee-fixture-ready', origin: fixture.origin })}\n`);

  const shutdown = () => {
    void fixture.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.env.FEE_FIXTURE_AUTOSTART === '1') {
  void startFromEnv().catch((error: unknown) => {
    process.stderr.write(`fee fixture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
