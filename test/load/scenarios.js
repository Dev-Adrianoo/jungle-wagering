// k6 script with three scenarios, run one after the other against the load balancer, the
// one that writes the most last so the outbox backlog is measured right after it:
// spread (each virtual user bets on its own wallet), contended (every virtual user bets on
// the same wallet) and duplicates (every virtual user resends one identical request).
// Amounts are always strings. The summary is printed as one JSON document on stdout so the
// runner can read it without sharing a folder with the container.
import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://nginx';
const VUS = Number(__ENV.VUS || 50);
const SECONDS = Number(__ENV.SECONDS || 30);
const SCENARIOS = ['duplicates', 'contended', 'spread'];
const OUTCOME_COUNTERS = ['wager_applied', 'wager_rejected', 'wager_replayed', 'wager_transient'];

const applied = new Counter('wager_applied');
const rejected = new Counter('wager_rejected');
const replayed = new Counter('wager_replayed');
const transient = new Counter('wager_transient');
const unexpected = new Counter('wager_unexpected');

http.setResponseCallback(http.expectedStatuses(200, 201, 422));

function scenario(name, index) {
  return {
    executor: 'constant-vus',
    exec: name,
    vus: VUS,
    duration: `${SECONDS}s`,
    startTime: `${index * (SECONDS + 5)}s`,
    gracefulStop: '5s',
  };
}

// k6 only reports a metric per scenario when a threshold names that scenario, so these
// always-true thresholds exist to make the per-scenario numbers appear in the summary.
function exposedPerScenario() {
  const thresholds = { wager_unexpected: ['count==0'] };
  for (const name of SCENARIOS) {
    thresholds[`http_req_duration{scenario:${name}}`] = ['max>=0'];
    thresholds[`http_reqs{scenario:${name}}`] = ['count>=0'];
    thresholds[`http_req_failed{scenario:${name}}`] = ['rate>=0'];
    for (const counter of OUTCOME_COUNTERS) {
      thresholds[`${counter}{scenario:${name}}`] = ['count>=0'];
    }
  }
  return thresholds;
}

export const options = {
  scenarios: Object.fromEntries(SCENARIOS.map((name, index) => [name, scenario(name, index)])),
  thresholds: exposedPerScenario(),
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

function openWallet(amount) {
  const playerId = uuid();
  const response = http.post(
    `${BASE_URL}/wallets`,
    JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
    { headers: JSON_HEADERS },
  );
  if (response.status !== 201) {
    throw new Error(`could not open a wallet: ${response.status} ${response.body}`);
  }
  return { id: response.json('id'), playerId };
}

export function setup() {
  const spread = [];
  for (let index = 0; index < VUS; index += 1) {
    spread.push(openWallet('1000000.00'));
  }
  return {
    run: uuid(),
    spread,
    contended: openWallet('1000000.00'),
    duplicates: openWallet('1000000.00'),
  };
}

function bet(wallet, externalTransactionId) {
  const response = http.post(
    `${BASE_URL}/wagering/transactions`,
    JSON.stringify({
      providerId: 'load-test',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    }),
    { headers: { ...JSON_HEADERS, 'Idempotency-Key': `load-test:${externalTransactionId}` } },
  );
  if (response.status === 201) {
    applied.add(1);
  } else if (response.status === 200) {
    replayed.add(1);
  } else if (response.status === 422) {
    rejected.add(1);
  } else if (response.status === 503) {
    transient.add(1);
  } else {
    unexpected.add(1);
  }
  check(response, {
    'answered with an expected status': (answer) => [200, 201, 422, 503].includes(answer.status),
  });
}

function uniqueId(data) {
  return `${data.run}-${exec.scenario.name}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`;
}

export function spread(data) {
  bet(data.spread[(exec.vu.idInTest - 1) % data.spread.length], uniqueId(data));
}

export function contended(data) {
  bet(data.contended, uniqueId(data));
}

export function duplicates(data) {
  bet(data.duplicates, `${data.run}-duplicate`);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({
      metrics: data.metrics,
      wallets: data.setup_data,
      seconds: SECONDS,
      vus: VUS,
    }),
  };
}
