// Runs the k6 scenarios in a container attached to the Compose network and adds what k6
// cannot see: the application metrics of every instance before and after, how long the
// outbox takes to drain once the load stops, and a reconciliation of every wallet used.
// It fails when a wallet balance differs from its ledger or when k6 saw an unexpected status.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitFor } from '../support/wait-for';

const project = process.env.COMPOSE_PROJECT ?? 'jungle-wagering';
const instances = ['app-1', 'app-2', 'app-3'];
const docker = process.platform === 'win32' ? ['wsl', '-d', 'Ubuntu', '--', 'docker'] : ['docker'];
const here = import.meta.dir;
const scenarioNames = ['duplicates', 'contended', 'spread'];

interface Wallet {
  id: string;
  playerId: string;
}

interface Summary {
  metrics: Record<string, { values: Record<string, number> }>;
  wallets: { spread: Wallet[]; contended: Wallet; duplicates: Wallet };
  seconds: number;
  vus: number;
}

async function run(command: string[], stdin?: Blob): Promise<string> {
  const child = Bun.spawn(command, {
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0 && output.trim() === '') {
    throw new Error(`${command.join(' ')} exited with ${exitCode}`);
  }
  return output;
}

function insideInstance(instance: string, script: string): Promise<string> {
  return run([...docker, 'exec', `${project}-${instance}-1`, 'bun', '-e', script]);
}

async function metricsOf(instance: string): Promise<Map<string, number>> {
  const text = await insideInstance(
    instance,
    "console.log(await (await fetch('http://localhost:3000/metrics')).text())",
  );
  const totals = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^([a-z_]+)(\{[^}]*\})? ([0-9.e+-]+)$/.exec(line);
    if (match?.[1] && match[3] && !match[1].endsWith('_bucket')) {
      totals.set(match[1], (totals.get(match[1]) ?? 0) + Number(match[3]));
    }
  }
  return totals;
}

async function clusterMetrics(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const instance of instances) {
    for (const [name, value] of await metricsOf(instance)) {
      totals.set(name, (totals.get(name) ?? 0) + value);
    }
  }
  return totals;
}

async function outboxPending(): Promise<number> {
  return (await metricsOf('app-1')).get('outbox_pending') ?? 0;
}

async function divergentWallets(wallets: Wallet[]): Promise<string[]> {
  const ids = JSON.stringify(wallets.map((wallet) => wallet.id));
  const script = [
    'const divergent = [];',
    `for (const id of ${ids}) {`,
    "  const response = await fetch('http://localhost:3000/wallets/' + id + '/reconciliation', { method: 'POST' });",
    '  const body = await response.json();',
    '  if (response.status !== 200 || body.consistent !== true) divergent.push(id);',
    '}',
    'console.log(JSON.stringify(divergent));',
  ].join('\n');
  return JSON.parse(await insideInstance('app-1', script)) as string[];
}

function stat(summary: Summary, metric: string, name: string): number {
  return summary.metrics[metric]?.values[name] ?? 0;
}

function scenarioRow(summary: Summary, name: string) {
  const tagged = (metric: string) => `${metric}{scenario:${name}}`;
  const requests = stat(summary, tagged('http_reqs'), 'count');
  const milliseconds = (statName: string) =>
    Number(stat(summary, tagged('http_req_duration'), statName).toFixed(1));
  return {
    scenario: name,
    requests,
    perSecond: Number((requests / summary.seconds).toFixed(1)),
    p50Ms: milliseconds('med'),
    p95Ms: milliseconds('p(95)'),
    p99Ms: milliseconds('p(99)'),
    maxMs: milliseconds('max'),
    applied: stat(summary, tagged('wager_applied'), 'count'),
    replayed: stat(summary, tagged('wager_replayed'), 'count'),
    rejected: stat(summary, tagged('wager_rejected'), 'count'),
    transient503: stat(summary, tagged('wager_transient'), 'count'),
    errorRate: stat(summary, tagged('http_req_failed'), 'rate'),
  };
}

const before = await clusterMetrics();
const k6Output = await run(
  [
    ...docker,
    'run',
    '--rm',
    '-i',
    '--network',
    `${project}_default`,
    '-e',
    'BASE_URL=http://nginx',
    '-e',
    `VUS=${process.env.VUS ?? '50'}`,
    '-e',
    `SECONDS=${process.env.SECONDS ?? '30'}`,
    'grafana/k6:1.3.0',
    'run',
    '--quiet',
    '-',
  ],
  Bun.file(resolve(here, 'scenarios.js')),
);
const summaryStart = k6Output.indexOf('{"metrics"');
if (summaryStart < 0) {
  throw new Error(`k6 did not print a summary:\n${k6Output.slice(-2000)}`);
}
const summary = JSON.parse(k6Output.slice(summaryStart)) as Summary;

const drainStartedAt = performance.now();
const pendingWhenLoadStopped = await outboxPending();
await waitFor(async () => (await outboxPending()) === 0, {
  timeoutMs: 300_000,
  intervalMs: 500,
  description: 'the outbox to drain after the load',
});
const drainSeconds = Number(((performance.now() - drainStartedAt) / 1000).toFixed(1));
const after = await clusterMetrics();
const delta = (name: string) => (after.get(name) ?? 0) - (before.get(name) ?? 0);

const wallets = [...summary.wallets.spread, summary.wallets.contended, summary.wallets.duplicates];
const divergent = await divergentWallets(wallets);
const unexpectedStatuses = stat(summary, 'wager_unexpected', 'count');

const result = {
  virtualUsers: summary.vus,
  secondsPerScenario: summary.seconds,
  scenarios: scenarioNames.map((name) => scenarioRow(summary, name)),
  application: {
    transactionsRecorded: delta('wager_transactions_total'),
    duplicatesDetected: delta('wager_duplicates_total'),
    idempotencyConflicts: delta('wager_idempotency_conflicts_total'),
    walletLockConflicts: delta('wallet_lock_conflicts_total'),
    outboxPendingWhenLoadStopped: pendingWhenLoadStopped,
    outboxDrainSeconds: drainSeconds,
  },
  reconciliation: { walletsChecked: wallets.length, divergent },
  unexpectedStatuses,
};

mkdirSync(resolve(here, 'out'), { recursive: true });
writeFileSync(resolve(here, 'out/result.json'), `${JSON.stringify(result, null, 2)}\n`);
console.table(result.scenarios);
console.log(JSON.stringify({ ...result, scenarios: undefined }, null, 2));

if (divergent.length > 0 || unexpectedStatuses > 0) {
  console.error('load test failed: a wallet diverged from its ledger or a status was unexpected');
  process.exit(1);
}
