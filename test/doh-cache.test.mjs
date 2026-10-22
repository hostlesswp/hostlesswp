import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCached } from '../runtime/src/http.js';

const answer = (json) => ({ status: 200, headers: [], body: btoa(JSON.stringify(json)) });

test('DNS-over-HTTPS answers are kept for their TTL, other requests are not', async () => {
  let calls = 0;
  const fetcher = (json) => async () => (calls++, answer(json));
  const url = 'https://cloudflare-dns.com/dns-query?name=a.example&type=A';
  const ok = fetcher({ Status: 0, Answer: [{ type: 1, TTL: 300, data: '1.2.3.4' }, { type: 1, TTL: 30, data: '1.2.3.5' }] });
  await fetchCached({ url }, ok, 0);
  await fetchCached({ url }, ok, 29000);
  assert.equal(calls, 1, 'within the shortest TTL');
  await fetchCached({ url }, ok, 31000);
  assert.equal(calls, 2, 'after it');

  const nx = 'https://cloudflare-dns.com/dns-query?name=nx.example&type=MX';
  await fetchCached({ url: nx }, fetcher({ Status: 3 }), 0);
  await fetchCached({ url: nx }, fetcher({ Status: 3 }), 59000);
  assert.equal(calls, 3, 'a missing name for a minute');

  const fail = 'https://cloudflare-dns.com/dns-query?name=f.example&type=A';
  await fetchCached({ url: fail }, fetcher({ Status: 2 }), 0);
  await fetchCached({ url: fail }, fetcher({ Status: 2 }), 0);
  assert.equal(calls, 5, 'failures are retried');

  const other = 'https://api.example/x';
  await fetchCached({ url: other }, ok, 0);
  await fetchCached({ url: other }, ok, 0);
  assert.equal(calls, 7);
});
