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
        if (j && j.error && body.method !== 'getTokenLargestAccounts' && j.error.code !== 429 && j.error.code !== 403 && j.error.code !== -32005) { res.status(200).json(last); return }
        break;
      } catch (e) { last = { error: { message: String(e && e.message || e) } } } finally { clearTimeout(to) }
    }
  }
  // Public mainnet RPC won't serve getTokenLargestAccounts, so rebuild it from the token accounts themselves.
  if (body.method === 'getTokenLargestAccounts') {
    try { const v = await largestViaScan(urls.filter(Boolean), String((body.params || [])[0] || '')); res.status(200).json({ result: { context: {}, value: v } }); return }
    catch (e) { last = { error: { message: 'holders unavailable: ' + (e && e.message || e) } } }
  }
  res.status(502).json(last);
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) { let n = 0n; for (const b of buf) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } for (const b of buf) { if (b === 0) s = '1' + s; else break } return s }
async function call(urls, method, params, ms = 25000) {
  let err = 'no rpc';
  for (const u of urls) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal });
      const j = await r.json().catch(() => null);
      if (j && j.result !== undefined) return j.result;
      err = (j && j.error && j.error.message) || ('HTTP ' + r.status);
    } catch (e) { err = String(e && e.message || e) } finally { clearTimeout(to) }
  }
  throw new Error(err);
}
async function largestViaScan(urls, mint) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('bad mint');
  const mi = await call(urls, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  if (!mi || !mi.value) throw new Error('mint not found');
  const prog = mi.value.owner, dec = mi.value.data.parsed.info.decimals;
  const filters = [{ memcmp: { offset: 0, bytes: mint } }];
  if (prog === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') filters.push({ dataSize: 165 });
  const accs = await call(urls, 'getProgramAccounts', [prog, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 32, length: 40 }, filters }], 28000);
  const rows = [];
  for (const a of accs) {
    const d = Buffer.from(a.account.data[0], 'base64'); if (d.length < 40) continue;
    const amount = d.readBigUInt64LE(32); if (amount === 0n) continue;
    rows.push({ address: a.pubkey, owner: b58(d.subarray(0, 32)), amt: amount });
  }
  rows.sort((x, y) => (y.amt > x.amt ? 1 : y.amt < x.amt ? -1 : 0));
  return rows.slice(0, 20).map(r => ({ address: r.address, owner: r.owner, amount: r.amt.toString(), decimals: dec, uiAmount: Number(r.amt) / 10 ** dec, uiAmountString: String(Number(r.amt) / 10 ** dec) }));
}
