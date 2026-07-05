/**
 * Demo producer: simulates realistic AI-agent job traffic on pg-boss.
 * - "agent-tasks": long-ish jobs, some fail and retry, some fail permanently -> DLQ
 * - "embeddings": fast jobs, high volume
 * - "notifications": always succeed
 */
import { PgBoss } from 'pg-boss';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/appdb';

async function main() {
  const boss = new PgBoss(connectionString);
  boss.on('error', (err) => console.error('[pg-boss]', err.message));
  await boss.start();

  // Queues (v10+ requires explicit queue creation). DLQ must exist first.
  await boss.createQueue('agent-tasks-dlq');
  await boss.createQueue('agent-tasks', {
    retryLimit: 2,
    retryDelay: 2,
    deadLetter: 'agent-tasks-dlq',
  });
  await boss.createQueue('embeddings', { retryLimit: 1 });
  await boss.createQueue('notifications');

  // Workers
  await boss.work('agent-tasks', { batchSize: 3 }, async (jobs) => {
    for (const job of jobs) {
      const { behavior } = job.data as { behavior: string };
      await sleep(300 + Math.random() * 700);
      if (behavior === 'fail-always') throw new Error('LLM provider returned 429 repeatedly');
      if (behavior === 'flaky' && Math.random() < 0.5) throw new Error('Transient network error');
    }
  });

  await boss.work('embeddings', { batchSize: 10 }, async (jobs) => {
    await sleep(100);
    if (Math.random() < 0.1) throw new Error('Embedding API timeout');
    return jobs.map(() => ({ vectors: 1536 }));
  });

  await boss.work('notifications', async () => {
    await sleep(50);
  });

  // Continuous traffic
  console.log('Producing jobs… (Ctrl+C to stop)');
  const iterations = Number(process.env.ITERATIONS ?? 0) || Infinity;
  for (let i = 0; i < iterations; i++) {
    await boss.send('agent-tasks', { behavior: pick(['ok', 'ok', 'flaky', 'fail-always']), prompt: `task #${i}` });
    await boss.send('embeddings', { docId: i });
    if (i % 3 === 0) await boss.send('notifications', { user: `user-${i}` });
    await sleep(400);
  }

  // Give workers time to drain, then exit (finite mode only)
  await sleep(15000);
  await boss.stop({ graceful: true });
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
