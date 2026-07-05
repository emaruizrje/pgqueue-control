/**
 * Demo producer for Absurd (earendil-works/absurd): durable workflows on Postgres.
 *
 * Generates realistic traffic across two queues so every task state exists:
 * - "agent-workflows": research-agent tasks with plan/search/summarize checkpoints.
 *   Some are flaky (fail mid-step, retry from last checkpoint), some fail permanently.
 *   human-review tasks sleep for a long time -> stay in 'sleeping'.
 * - "data-pipelines": etl-run tasks with extract/transform/load checkpoints.
 * - "email-campaigns": send-campaign tasks (render/send/record) plus
 *   drip-sequence tasks that awaitEvent() a user click -> stay suspended
 *   until the event is emitted (a few are woken by emitEvent below).
 * - "report-generation": gather/aggregate/render-pdf, some with a broken
 *   data source that exhausts retries.
 *
 * After the workers drain, a few extra tasks are spawned with no worker running
 * (stay 'pending') and a couple are cancelled via absurd.cancel_task().
 */
import { Absurd } from 'absurd-sdk';
import pg from 'pg';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/appdb';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

/** Volume multiplier: SCALE=4 spawns 4x the base traffic. */
const SCALE = Math.max(1, Number(process.env.SCALE ?? 1));

/**
 * Throw a demo failure WITHOUT a stack trace. Absurd persists err.stack into
 * failure_reason, and a real stack leaks local filesystem paths into the
 * (potentially public) dashboard. The message alone tells the demo story.
 */
function fail(message: string): never {
  const err = new Error(message);
  err.stack = `Error: ${message}`;
  throw err;
}

async function main() {
  const agents = new Absurd({ db: connectionString, queueName: 'agent-workflows' });
  const pipelines = new Absurd({ db: connectionString, queueName: 'data-pipelines' });
  const emails = new Absurd({ db: connectionString, queueName: 'email-campaigns' });
  const reports = new Absurd({ db: connectionString, queueName: 'report-generation' });

  // Idempotent: the producer bootstraps its own queues.
  await agents.createQueue();
  await pipelines.createQueue();
  await emails.createQueue();
  await reports.createQueue();

  agents.registerTask({ name: 'research-agent', defaultMaxAttempts: 2 }, async (params: any, ctx) => {
    const plan = await ctx.step('plan', async () => {
      return { steps: ['search', 'summarize'], topic: params.topic };
    });

    const results = await ctx.step('search', async () => {
      await sleep(50 + Math.random() * 150);
      if (params.behavior === 'fail-always') {
        fail('LLM provider returned 429 repeatedly');
      }
      if (params.behavior === 'flaky' && Math.random() < 0.6) {
        fail('Transient network error during search');
      }
      return { hits: Math.ceil(Math.random() * 20), plan: plan.topic };
    });

    return await ctx.step('summarize', async () => {
      await sleep(50);
      return { summary: `Found ${results.hits} results for ${params.topic}` };
    });
  });

  agents.registerTask({ name: 'human-review' }, async (params: any, ctx) => {
    await ctx.step('prepare-review', async () => ({ document: params.docId }));
    // Long sleep: these stay in 'sleeping' state for the demo
    await ctx.sleepFor('wait-for-reviewer', 3600);
    return { approved: true };
  });

  pipelines.registerTask({ name: 'etl-run', defaultMaxAttempts: 3 }, async (params: any, ctx) => {
    const raw = await ctx.step('extract', async () => {
      await sleep(30);
      return { rows: Math.ceil(Math.random() * 5000) };
    });
    const clean = await ctx.step('transform', async () => {
      await sleep(30);
      if (params.behavior === 'bad-data') fail('Schema validation failed: null in NOT NULL column');
      return { rows: raw.rows, dropped: Math.floor(raw.rows * 0.02) };
    });
    return await ctx.step('load', async () => {
      await sleep(30);
      return { loaded: clean.rows - clean.dropped };
    });
  });

  emails.registerTask({ name: 'send-campaign', defaultMaxAttempts: 3 }, async (params: any, ctx) => {
    const rendered = await ctx.step('render-template', async () => {
      await sleep(40);
      return { template: params.template, recipients: Math.ceil(Math.random() * 800) };
    });
    const sent = await ctx.step('send-batch', async () => {
      await sleep(60);
      if (params.behavior === 'smtp-down') fail('SMTP relay connection refused');
      if (Math.random() < 0.15) fail('Rate limited by email provider');
      return { delivered: rendered.recipients - Math.floor(Math.random() * 10) };
    });
    return await ctx.step('record-stats', async () => ({ delivered: sent.delivered }));
  });

  emails.registerTask({ name: 'drip-sequence' }, async (params: any, ctx) => {
    await ctx.step('send-first-touch', async () => ({ user: params.userId }));
    // Suspends until the click event arrives — no worker slot held while waiting
    const click = await ctx.awaitEvent(`user.clicked:${params.userId}`, { timeout: 7200 });
    return await ctx.step('send-follow-up', async () => ({ clicked: click }));
  });

  reports.registerTask({ name: 'generate-report', defaultMaxAttempts: 2 }, async (params: any, ctx) => {
    const data = await ctx.step('gather-data', async () => {
      await sleep(50);
      if (params.behavior === 'bad-source') fail('Upstream warehouse returned 503');
      return { rows: Math.ceil(Math.random() * 20000) };
    });
    const agg = await ctx.step('aggregate', async () => {
      await sleep(40);
      return { series: Math.ceil(data.rows / 1000) };
    });
    return await ctx.step('render-pdf', async () => {
      await sleep(80);
      return { pages: agg.series + 2 };
    });
  });

  const agentWorker = await agents.startWorker({ concurrency: 5, pollInterval: 0.5 });
  const pipelineWorker = await pipelines.startWorker({ concurrency: 5, pollInterval: 0.5 });
  const emailWorker = await emails.startWorker({ concurrency: 5, pollInterval: 0.5 });
  const reportWorker = await reports.startWorker({ concurrency: 5, pollInterval: 0.5 });

  console.log('Spawning tasks…');
  const spawns: Promise<unknown>[] = [];
  for (let i = 0; i < 30 * SCALE; i++) {
    const behavior = pick(['ok', 'ok', 'ok', 'flaky', 'fail-always']);
    // Slow retries stay visible as pending-with-attempts ("retry"); fast ones re-run and finish.
    const retryStrategy =
      behavior === 'flaky' && i % 2 === 0
        ? { kind: 'fixed' as const, baseSeconds: 600 }
        : { kind: 'fixed' as const, baseSeconds: 1 };
    spawns.push(
      agents.spawn('research-agent', { topic: `topic-${i}`, behavior }, { retryStrategy }),
    );
  }
  for (let i = 0; i < 5 * SCALE; i++) {
    spawns.push(agents.spawn('human-review', { docId: `doc-${i}` }));
  }
  for (let i = 0; i < 25 * SCALE; i++) {
    const behavior = pick(['ok', 'ok', 'ok', 'ok', 'bad-data']);
    spawns.push(pipelines.spawn('etl-run', { dataset: `ds-${i}`, behavior }));
  }
  for (let i = 0; i < 20 * SCALE; i++) {
    const behavior = pick(['ok', 'ok', 'ok', 'smtp-down']);
    spawns.push(emails.spawn('send-campaign', { template: `campaign-${i}`, behavior }));
  }
  for (let i = 0; i < 8 * SCALE; i++) {
    spawns.push(emails.spawn('drip-sequence', { userId: `user-${i}` }));
  }
  for (let i = 0; i < 15 * SCALE; i++) {
    const behavior = pick(['ok', 'ok', 'ok', 'bad-source']);
    spawns.push(reports.spawn('generate-report', { report: `weekly-${i}`, behavior }));
  }
  await Promise.all(spawns);

  // Wake a few drip sequences: 3 users "click", the other 5 keep waiting
  await sleep(4000);
  for (let i = 0; i < 3; i++) {
    await emails.emitEvent(`user.clicked:user-${i}`, { at: new Date().toISOString() });
  }

  const drainSeconds = Number(process.env.DRAIN_SECONDS ?? 30);
  console.log(`Letting workers process for ${drainSeconds}s…`);
  await sleep(drainSeconds * 1000);

  await agentWorker.close();
  await pipelineWorker.close();
  await emailWorker.close();
  await reportWorker.close();

  // Spawned with no worker running: these stay 'pending'
  for (let i = 0; i < 6; i++) {
    await agents.spawn('research-agent', { topic: `backlog-${i}`, behavior: 'ok' });
  }
  for (let i = 0; i < 4; i++) {
    await pipelines.spawn('etl-run', { dataset: `backlog-ds-${i}`, behavior: 'ok' });
  }
  for (let i = 0; i < 3; i++) {
    await emails.spawn('send-campaign', { template: `backlog-campaign-${i}`, behavior: 'ok' });
    await reports.spawn('generate-report', { report: `backlog-report-${i}`, behavior: 'ok' });
  }

  // Cancel a couple of the pending backlog tasks so 'cancelled' exists too
  const pool = new pg.Pool({ connectionString, max: 1 });
  await pool.query(`
    SELECT absurd.cancel_task('agent-workflows', task_id)
    FROM absurd."t_agent-workflows"
    WHERE state = 'pending' AND params->>'topic' LIKE 'backlog-%'
    LIMIT 2
  `);
  await pool.end();

  await agents.close();
  await pipelines.close();
  await emails.close();
  await reports.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
