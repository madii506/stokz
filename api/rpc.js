// Solana RPC proxy for the Stokz desk. Browsers can't use mainnet-beta directly (403 for
// browser origins) and publicnode refuses indexed calls, so the page talks to this.
// Only the read/send methods the desk needs are allowed. Set RPC_URL to use your own node.
const ALLOW = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenLargestAccounts', 'getTokenAccountsByOwner',
  'getTokenAccountBalance', 'getTokenSupply', 'getLatestBlockhash', 'getMinimumBalanceForRentExemption',
  'getSignatureStatuses', 'getSignaturesForAddress', 'getTransaction', 'sendTransaction', 'simulateTransaction'
]);
const INDEXED = new Set(['getTokenLargestAccounts', 'getSignaturesForAddress', 'getTransaction', 'getTokenAccountsByOwner']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = null } }
  if (!body || !ALLOW.has(body.method) || !Array.isArray(body.params || [])) { res.status(400).json({ error: 'method not allowed' }); return }
  const urls = [process.env.RPC_URL, 'https://api.mainnet-beta.solana.com'];
  if (!INDEXED.has(body.method)) urls.push('https://solana-rpc.publicnode.com');
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: body.method, params: body.params || [] });
  let last = { error: { message: 'rpc unavailable' } };
  for (const u of urls.filter(Boolean)) {
    for (let i = 0; i < 2; i++) {
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 12000);
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: ac.signal });
        if (r.status === 429) { await sleep(700 * (i + 1)); continue }
        const j = await r.json();
        if (j && j.result !== undefined) { res.status(200).json({ result: j.result }); return }
        last = j && j.error ? { error: j.error } : last;
        // a real RPC error from the chain (e.g. simulation or send failure) is the answer, not a reason to retry
        if (j && j.error && j.error.code !== 429 && j.error.code !== 403 && j.error.code !== -32005) { res.status(200).json(last); return }
        break;
      } catch (e) { last = { error: { message: String(e && e.message || e) } } } finally { clearTimeout(to) }
    }
  }
  res.status(502).json(last);
};
