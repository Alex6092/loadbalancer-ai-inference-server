// Node 24. Le serveur applicatif conserve la clé ; ne pas l’exposer dans le navigateur de l’élève.
const base = process.env.API_BASE || 'http://127.0.0.1:3000';
const headers = {
  Authorization: `Bearer ${process.env.API_KEY}`,
  'Content-Type': 'application/json',
  'X-End-User-ID': process.env.USER_ID || 'demo-user',
};
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const response = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers,
  signal: controller.signal,
  body: JSON.stringify({
    model: process.env.MODEL,
    messages: [{ role: 'user', content: 'Explique simplement le DNS.' }],
    max_tokens: 256,
    stream: true,
  }),
});
if (!response.ok) throw new Error(await response.text());
const id = response.headers.get('x-job-id');
const follow = setInterval(async () => {
  try {
    const status = await fetch(`${base}/v1/jobs/${id}`, { headers, signal: controller.signal });
    const job = await status.json();
    if (job.queue) console.error('Attente :', job.queue.estimated_jobs_ahead, 'job(s), estimation.');
    else clearInterval(follow);
  } catch {
    clearInterval(follow);
  }
}, 2000);
let buffer = '';
const decoder = new TextDecoder();
try {
  for await (const chunk of response.body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let separator;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      const payload = JSON.parse(data);
      if (payload.error) throw new Error(payload.error.message);
      for (const choice of payload.choices || [])
        if (choice.delta?.content) process.stdout.write(choice.delta.content);
    }
  }
  process.stdout.write('\n');
} finally {
  clearInterval(follow);
}
