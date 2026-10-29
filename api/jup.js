// Cached proxy for Jupiter's public token API, so every visitor shares one
// edge-cached response instead of each browser hitting Jupiter's per-IP limit.
// /api/jup?p=recent | toptrending/1h?limit=100 | toporganicscore/1h?limit=100 | search?query=...
const BASE = 'https://lite-api.jup.ag/tokens/v2/';
const ALLOW = /^(recent|toptrending\/(5m|1h|6h|24h)|toporganicscore\/(5m|1h|6h|24h)|toptraded\/(5m|1h|6h|24h)|search)(\?[A-Za-z0-9_=&,%.\-]*)?$/;
const TTL = p => p.startsWith('recent') ? 6 : p.startsWith('search') ? 20 : 25;
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  const p = String(req.query.p || '');
  if (!ALLOW.test(p) || p.length > 6000) { res.setHeader('cache-control', 'no-store'); res.status(400).json({ error: 'bad path' }); return }
  let last = 0;
  for (let i = 0; i < 3; i++) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(BASE + p, { signal: ac.signal, headers: { accept: 'application/json', 'user-agent': 'aura-pad/1.0' } });
      last = r.status;
      if (r.status === 429) { await sleep(900 * (i + 1)); continue }
      if (!r.ok) break;
      const body = await r.text();
      const t = TTL(p);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', `public, max-age=0, s-maxage=${t}, stale-while-revalidate=${t * 10}, stale-if-error=600`);
      res.status(200).send(body); return;
    } catch (e) { last = 504 } finally { clearTimeout(to) }
  }
  res.setHeader('cache-control', 'no-store');
  res.status(last === 429 ? 429 : 502).json({ error: 'jupiter unavailable', status: last });
};
