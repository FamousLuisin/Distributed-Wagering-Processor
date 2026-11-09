import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';
import { performance } from 'node:perf_hooks';

interface WalletResponse {
  id?: string;
  playerId?: string;
}

interface LoadWallet {
  id: string;
  playerId: string;
}

interface JsonResponse {
  status?: string;
  code?: string;
  consistent?: boolean;
}

interface RequestResult {
  latencyMs: number;
  httpStatus: number;
  transactionStatus?: string;
  errorCode?: string;
}

interface MetricsSnapshot {
  lockConflicts: number;
  duplicates: number;
  outboxPending?: number;
  outboxLagSeconds?: number;
}

interface ScenarioReport {
  name: string;
  requests: number;
  concurrency: number;
  walletCount: number;
  durationSeconds: number;
  throughputAttemptedRps: number;
  throughputSuccessfulRps: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  errors: number;
  errorRatePercent: number;
  httpStatuses: Record<string, number>;
  transactionStatuses: Record<string, number>;
  conflictObservations: {
    http409: number;
    databaseLockConflicts: number;
    idempotentDuplicates: number;
  };
  outbox: {
    maxObservedLagSeconds: number | null;
    lagAfterDrainSeconds: number | null;
    pendingAfterDrain: number | null;
    samples: number;
    sampleErrors: number;
    drainDurationSeconds: number;
    drained: boolean;
  };
  reconciledWallets: number;
  reconciliationConsistent: boolean;
}

const baseUrl = (process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000').replace(
  /\/$/,
  '',
);
const requestsPerScenario = readPositiveInt(
  'LOAD_REQUESTS_PER_SCENARIO',
  500,
  20_000,
);
const concurrency = readPositiveInt('LOAD_CONCURRENCY', 32, 500);
const distributedWalletCount = readPositiveInt(
  'LOAD_DISTRIBUTED_WALLETS',
  10,
  500,
);
const outboxDrainTimeoutMs = readPositiveInt(
  'LOAD_OUTBOX_DRAIN_TIMEOUT_MS',
  90_000,
  600_000,
);
const metricsSampleIntervalMs = readPositiveInt(
  'LOAD_METRICS_SAMPLE_INTERVAL_MS',
  250,
  10_000,
);
const runId = randomUUID();
const providerId = `load-test-${runId}`;

async function main(): Promise<void> {
  const readyResponse = await fetch(`${baseUrl}/health/ready`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!readyResponse.ok) {
    const body = await readyResponse.text();
    throw new Error(
      `API is not ready (HTTP ${readyResponse.status}). Start PostgreSQL, LocalStack, configure all SQS queue URLs and start the API. Readiness: ${body}`,
    );
  }

  const scenarios: ScenarioReport[] = [];
  const hotWallets = await createWallets(1, requestsPerScenario);
  await waitForOutboxDrain(outboxDrainTimeoutMs);
  scenarios.push(
    await runScenario('single-hot-wallet', hotWallets, requestsPerScenario),
  );

  const distributedWallets = await createWallets(
    Math.min(distributedWalletCount, requestsPerScenario),
    requestsPerScenario,
  );
  await waitForOutboxDrain(outboxDrainTimeoutMs);
  scenarios.push(
    await runScenario(
      'distributed-wallets',
      distributedWallets,
      requestsPerScenario,
    ),
  );

  const report = {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      architecture: arch(),
      cpuCount: cpus().length,
      nodeVersion: process.versions.node,
      bunVersion: process.versions.bun ?? null,
    },
    methodology: {
      description:
        'HTTP load against the running API with PostgreSQL and SQS readiness required. Two scenarios use unique BET transactions and real wallets: all requests share one wallet, then requests are distributed round-robin over several wallets.',
      requestsPerScenario,
      configuredConcurrency: concurrency,
      distributedWalletCount: distributedWallets.length,
      amountPerTransaction: '0.01 BRL',
      warmupRequests: 0,
      setupExcludedFromLatencyAndThroughput: true,
      metricsSamplingIntervalMs: metricsSampleIntervalMs,
      metricsSamplingOverheadIncludedInDuration: true,
      outboxDrainTimeoutMs,
      note: 'The database and append-only ledger are not cleaned up. Each run creates distinct players, wallets, transactions, ledger entries and outbox events.',
    },
    scenarios,
  };

  const reportPath =
    process.env.LOAD_REPORT_PATH ?? `load-test-results/${runId}.json`;
  await mkdir(
    reportPath.slice(0, Math.max(reportPath.lastIndexOf('/'), 0)) || '.',
    {
      recursive: true,
    },
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Load report saved to ${reportPath}\n`);

  if (
    scenarios.some(
      (scenario) =>
        scenario.errors > 0 ||
        !scenario.outbox.drained ||
        !scenario.reconciliationConsistent,
    )
  ) {
    process.exitCode = 1;
  }
}

async function createWallets(
  count: number,
  requests: number,
): Promise<LoadWallet[]> {
  const requestsPerWallet = Math.ceil(requests / count);
  const balance = formatMoneyCents(BigInt(requestsPerWallet + 100));
  const wallets: LoadWallet[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: randomUUID(),
        initialBalance: { amount: balance, currency: 'BRL' },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as WalletResponse;
    if (!response.ok || !body.id || !body.playerId) {
      throw new Error(
        `Could not create load-test wallet (HTTP ${response.status})`,
      );
    }
    wallets.push({ id: body.id, playerId: body.playerId });
  }
  return wallets;
}

async function runScenario(
  name: string,
  wallets: LoadWallet[],
  requestCount: number,
): Promise<ScenarioReport> {
  const baseline = await readMetrics();
  const latencies: number[] = [];
  const httpStatuses: Record<string, number> = {};
  const transactionStatuses: Record<string, number> = {};
  const results: RequestResult[] = [];
  let nextRequest = 0;
  let stopSampler = false;
  let maxObservedLag = baseline.outboxLagSeconds ?? 0;
  let samples = 0;
  let sampleErrors = 0;
  const sampler = (async () => {
    while (!stopSampler) {
      try {
        const snapshot = await readMetrics();
        if (snapshot.outboxLagSeconds !== undefined) {
          maxObservedLag = Math.max(maxObservedLag, snapshot.outboxLagSeconds);
          samples += 1;
        }
      } catch {
        sampleErrors += 1;
      }
      await delay(metricsSampleIntervalMs);
    }
  })();

  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requestCount) }, async () => {
      while (true) {
        const index = nextRequest;
        nextRequest += 1;
        if (index >= requestCount) return;
        const wallet = wallets[index % wallets.length];
        const startedRequest = performance.now();
        try {
          const response = await fetch(`${baseUrl}/wagering/transactions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `${runId}:${name}:${index}`,
            },
            body: JSON.stringify({
              providerId,
              externalTransactionId: `${name}:${index}`,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: `${runId}:${index}`,
              gameId: 'load-test',
              kind: 'BET',
              money: { amount: '0.01', currency: 'BRL' },
            }),
            signal: AbortSignal.timeout(30_000),
          });
          const body = (await response
            .json()
            .catch(() => ({}))) as JsonResponse;
          const result: RequestResult = {
            latencyMs: performance.now() - startedRequest,
            httpStatus: response.status,
            ...(body.status ? { transactionStatus: body.status } : {}),
            ...(!response.ok && body.code ? { errorCode: body.code } : {}),
          };
          results.push(result);
          latencies.push(result.latencyMs);
          increment(httpStatuses, String(response.status));
          if (body.status) increment(transactionStatuses, body.status);
        } catch (error) {
          const result: RequestResult = {
            latencyMs: performance.now() - startedRequest,
            httpStatus: 0,
            errorCode: error instanceof Error ? error.name : 'UnknownError',
          };
          results.push(result);
          latencies.push(result.latencyMs);
          increment(httpStatuses, 'network_error');
        }
      }
    }),
  );
  const measuredDurationSeconds = (performance.now() - startedAt) / 1_000;
  stopSampler = true;
  await sampler;

  const errors = results.filter(
    ({ httpStatus }) => httpStatus < 200 || httpStatus >= 300,
  ).length;
  const http409 = results.filter(({ httpStatus }) => httpStatus === 409).length;
  const outboxDrainStartedAt = performance.now();
  const drainedMetrics = await waitForOutboxDrain(outboxDrainTimeoutMs);
  const drainDurationSeconds =
    (performance.now() - outboxDrainStartedAt) / 1_000;
  maxObservedLag = Math.max(maxObservedLag, drainedMetrics.maxLagSeconds);
  samples += drainedMetrics.samples;
  sampleErrors += drainedMetrics.sampleErrors;

  const after = await readMetrics();
  const reconciliations = await Promise.all(
    wallets.map(async ({ id: walletId }) => {
      const response = await fetch(
        `${baseUrl}/wallets/${walletId}/reconciliation`,
        { method: 'POST', signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return false;
      const body = (await response.json()) as JsonResponse;
      return body.consistent === true;
    }),
  );
  const sorted = [...latencies].sort((a, b) => a - b);
  const successfulRequests = results.length - errors;
  return {
    name,
    requests: results.length,
    concurrency: Math.min(concurrency, requestCount),
    walletCount: wallets.length,
    durationSeconds: round(measuredDurationSeconds, 3),
    throughputAttemptedRps: round(results.length / measuredDurationSeconds, 2),
    throughputSuccessfulRps: round(
      successfulRequests / measuredDurationSeconds,
      2,
    ),
    latencyMs: {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: round(sorted.at(-1) ?? 0, 2),
    },
    errors,
    errorRatePercent: round((errors / results.length) * 100, 3),
    httpStatuses,
    transactionStatuses,
    conflictObservations: {
      http409,
      databaseLockConflicts: Math.max(
        0,
        after.lockConflicts - baseline.lockConflicts,
      ),
      idempotentDuplicates: Math.max(0, after.duplicates - baseline.duplicates),
    },
    outbox: {
      maxObservedLagSeconds: round(maxObservedLag, 3),
      lagAfterDrainSeconds: drainedMetrics.finalLagSeconds,
      pendingAfterDrain: drainedMetrics.pending,
      samples,
      sampleErrors,
      drainDurationSeconds: round(drainDurationSeconds, 3),
      drained: drainedMetrics.drained,
    },
    reconciledWallets: reconciliations.filter(Boolean).length,
    reconciliationConsistent:
      reconciliations.length === wallets.length &&
      reconciliations.every(Boolean),
  };
}

async function waitForOutboxDrain(timeoutMs: number): Promise<{
  drained: boolean;
  pending: number | null;
  finalLagSeconds: number | null;
  maxLagSeconds: number;
  samples: number;
  sampleErrors: number;
}> {
  const deadline = Date.now() + timeoutMs;
  let maxLagSeconds = 0;
  let samples = 0;
  let sampleErrors = 0;
  let snapshot: MetricsSnapshot = { lockConflicts: 0, duplicates: 0 };
  let zeroPendingSince: number | undefined;
  while (Date.now() < deadline) {
    try {
      snapshot = await readMetrics();
      if (snapshot.outboxLagSeconds !== undefined) {
        maxLagSeconds = Math.max(maxLagSeconds, snapshot.outboxLagSeconds);
        samples += 1;
      }
      if (snapshot.outboxPending === 0) {
        zeroPendingSince ??= Date.now();
        if (Date.now() - zeroPendingSince >= 1_500) {
          return {
            drained: true,
            pending: 0,
            finalLagSeconds: snapshot.outboxLagSeconds ?? null,
            maxLagSeconds,
            samples,
            sampleErrors,
          };
        }
      } else {
        zeroPendingSince = undefined;
      }
    } catch {
      sampleErrors += 1;
    }
    await delay(300);
  }
  return {
    drained: false,
    pending: snapshot.outboxPending ?? null,
    finalLagSeconds: snapshot.outboxLagSeconds ?? null,
    maxLagSeconds,
    samples,
    sampleErrors,
  };
}

async function readMetrics(): Promise<MetricsSnapshot> {
  const response = await fetch(`${baseUrl}/health/metrics`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Metrics endpoint returned ${response.status}`);
  const text = await response.text();
  return {
    lockConflicts: metricSum(text, 'database_lock_conflicts_total') ?? 0,
    duplicates: metricSum(text, 'wagering_duplicates_total') ?? 0,
    outboxPending: metricSum(text, 'outbox_pending_messages'),
    outboxLagSeconds: metricSum(text, 'outbox_oldest_unpublished_seconds'),
  };
}

function metricSum(text: string, name: string): number | undefined {
  const values = text
    .split('\n')
    .filter(
      (line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`),
    )
    .map((line) => Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1)))
    .filter(Number.isFinite);
  return values.length === 0
    ? undefined
    : values.reduce((sum, value) => sum + value, 0);
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(
    0,
    Math.ceil(percentileValue * sortedValues.length) - 1,
  );
  return round(sortedValues[index] ?? 0, 2);
}

function readPositiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > max ||
    String(value) !== raw
  ) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function formatMoneyCents(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
