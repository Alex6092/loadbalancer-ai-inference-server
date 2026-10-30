// Node 24 : API_BASE=http://127.0.0.1:3000 API_KEY=... MODEL=... node examples/async-job.js
import { randomUUID } from 'node:crypto';

const base = process.env.API_BASE || 'http://127.0.0.1:3000';
const headers = {
  Authorization: `Bearer ${process.env.API_KEY}`,
  'Content-Type': 'application/json',
  'X-End-User-ID': process.env.USER_ID || 'demo-user',
};
const response = await fetch(`${base}/v1/jobs`, {
  method: 'POST',
  headers: { ...headers, 'Idempotency-Key': randomUUID() },
  body: JSON.stringify({
    model: process.env.MODEL,
    messages: [{ role: 'user', content: 'Explique le routage IP en trois phrases.' }],
    max_tokens: 256,
    ...(process.env.CALLBACK_URL ? { callbackURL: process.env.CALLBACK_URL } : {}),
  }),
});
let job = await response.json();
if (!response.ok) throw new Error(JSON.stringify(job));
console.log('Job accepté :', job.id);
while (['queued', 'running'].includes(job.status)) {
  if (job.queue)
    console.log('Jobs avant départ (estimation) :', job.queue.estimated_jobs_ahead, job.queue.reason);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const poll = await fetch(`${base}${job.links.self}`, { headers });
  job = await poll.json();
  if (!poll.ok) throw new Error(JSON.stringify(job));
}
console.log(JSON.stringify(job, null, 2));
