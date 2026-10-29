/* stokz · OTC for StonkFun stocks, in one transaction.
   An offer = a legacy Solana transaction [advance nonce, create buyer ATA (idempotent),
   transferChecked seller->buyer, SOL transfer buyer->seller + reference key], pre-signed by
   the maker against a durable nonce and completed by the counterparty. No custody anywhere. */
(() => {
'use strict';
const W3 = window.solanaWeb3;
const { PublicKey, Transaction, SystemProgram, TransactionInstruction } = W3;
const SF = 'https://www.stonkfun.xyz';
const REF = new PublicKey('8mgrwvPCSagZVkYEBhvDpJdEkJRAzVjPraCKexAnxLVr');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const NONCE_LEN = 80;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = a => a ? (a = String(a), a.slice(0, 4) + '…' + a.slice(-4)) : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtUsd = (n, d) => { if (n == null || !isFinite(n)) return '—'; const a = Math.abs(n); if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (a >= 1e4) return '$' + (n / 1e3).toFixed(1) + 'K'; if (a >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: d ?? 2 }); if (a === 0) return '$0'; return '$' + n.toPrecision(3) };
const fmtNum = n => { if (n == null || !isFinite(n)) return '—'; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K'; return n.toLocaleString('en-US', { maximumFractionDigits: a >= 1 ? 2 : 6 }) };
const fmtSol = n => n == null || !isFinite(n) ? '—' : (n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toFixed(4)).replace(/\.?0+$/, '') + ' SOL';
const pct = (n, d = 1) => n == null || !isFinite(n) ? '—' : (n * 100).toFixed(d) + '%';
const ago = t => { const s = Math.max(1, (Date.now() - t) / 1000); if (s < 60) return Math.floor(s) + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago' };
const solscan = (k, t = 'account') => `https://solscan.io/${t}/${k}`;
const abs = u => !u ? '' : u.startsWith('http') ? u : SF + u;
let toastT; const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3600) };
const copy = async (s, m = 'Copied') => { try { await navigator.clipboard.writeText(s); toast(m) } catch { toast('Copy failed, select it manually') } };

/* ---------- base58 / base64url ---------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } for (const b of bytes) { if (b === 0) s = '1' + s; else break } return s }
const toB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s) };
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = u8 => toB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

/* ---------- network ---------- */
async function get(u, ms = 12000) { const ac = new AbortController(); const to = setTimeout(() => ac.abort(), ms); try { const r = await fetch(u, { cache: 'no-store', signal: ac.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json() } finally { clearTimeout(to) } }
async function rpc(method, params = []) {
  const r = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
  let j; try { j = await r.json() } catch { throw new Error('RPC unavailable (' + r.status + ')') }
  if (j.error) { const e = new Error(j.error.message || 'RPC error'); e.data = j.error.data; throw e }
  return j.result;
}

/* ---------- StonkFun + Jupiter data ---------- */
const S = { map: new Map(), total: null, sol: null, sort: 'mcap', q: '', shown: 18 };
function norm(t) {
  const m = t.market || {};
  return {
    mint: t.mint, sym: t.symbol || '?', name: t.name || t.symbol || '', img: abs(t.imageUrl),
    q: t.quote ? { sym: t.quote.symbol, name: t.quote.name, logo: abs(t.quote.logoUrl), cat: t.quote.categoryLabel || '' } : null,
    price: m.priceUsd, mcap: m.marketCapUsd, vol: m.volume24hUsd, chg: m.priceChange24h, liq: m.liquidityUsd || null, peak: m.peakMarketCapUsd,
    fee: t.transferFee && t.transferFee.bps || 0, status: t.status, lp: t.launchpad, created: t.createdAt ? Date.parse(t.createdAt) : 0,
    links: t.links || {}, url: SF + '/token/' + t.mint
  };
}
async function sfList(sort, size, page = 1, q = '') {
  const u = `${SF}/api/public/v1/tokens?sort=${sort}&pageSize=${size}&page=${page}` + (q ? '&q=' + encodeURIComponent(q) : '');
  const j = await get(u); const d = j.data || j;
  if (d.pagination && d.pagination.total) S.total = Math.max(S.total || 0, d.pagination.total);
  return (d.tokens || []).map(norm);
}
async function enrich(list) {
  const need = list.filter(s => !s._j).map(s => s.mint);
  const ids = [SOL_MINT, ...need];
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    try {
      const r = await get('/api/jup?p=' + encodeURIComponent('search?query=' + chunk.join(',')), 15000);
      for (const x of r || []) {
        if (x.id === SOL_MINT) { if (x.usdPrice) S.sol = x.usdPrice; continue }
        const s = S.map.get(x.id); if (!s) continue;
        s._j = 1; if (!s.liq && x.liquidity) s.liq = x.liquidity; if (x.holderCount) s.holders = x.holderCount; if (!s.price && x.usdPrice) s.price = x.usdPrice; if (!s.img && x.icon) s.img = x.icon;
      }
    } catch (e) { console.warn('jup', e) }
  }
  if (!S.sol) { try { const r = await get('/api/jup?p=' + encodeURIComponent('search?query=' + SOL_MINT)); const x = (r || []).find(y => y.id === SOL_MINT); if (x) S.sol = x.usdPrice } catch {} }
}
async function loadStocks() {
  const res = await Promise.allSettled([sfList('marketCap', 60), sfList('volume', 60), sfList('newest', 30)]);
  for (const r of res) if (r.status === 'fulfilled') for (const s of r.value) if (!S.map.has(s.mint)) S.map.set(s.mint, s);
  if (!S.map.size) throw new Error(res.map(r => r.reason && r.reason.message).filter(Boolean)[0] || 'StonkFun unavailable');
  await enrich([...S.map.values()]);
}
async function stockByMint(mint) {
  if (S.map.has(mint)) return S.map.get(mint);
  const l = await sfList('marketCap', 10, 1, mint).catch(() => []);
  const s = l.find(x => x.mint === mint); if (!s) return null;
  S.map.set(mint, s); await enrich([s]); return s;
}
// constant-product estimate: half the pool's USD liquidity sits on each side
function impact(liq, usd) { const x = liq / 2; if (!x || !usd) return null; const slip = usd / (x + usd); return { slip, drop: 1 - Math.pow(x / (x + usd), 2), get: usd * (1 - slip) } }

/* ---------- wallet ---------- */
const WAL = { pk: null, p: null, name: '' };
function providers() {
  const out = [];
  const ph = (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom && window.solana);
  if (ph) out.push(['Phantom', ph]); if (window.solflare && window.solflare.isSolflare !== false) out.push(['Solflare', window.solflare]); if (window.backpack) out.push(['Backpack', window.backpack]);
  return out;
}
function pickWallet(list) {
  return new Promise(res => {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="card"><h3>Connect a wallet</h3><div class="wl">${list.map((w, i) => `<button data-i="${i}">${w[0]}<span class="mut">→</span></button>`).join('')}</div></div>`;
    m.onclick = e => { const b = e.target.closest('button'); if (b) { m.remove(); res(list[+b.dataset.i]) } else if (e.target === m) { m.remove(); res(null) } };
    document.body.appendChild(m);
  });
}
async function connect() {
  if (WAL.pk) return WAL.pk;
  const list = providers();
  if (!list.length) { toast('No Solana wallet found. Install Phantom, Solflare or Backpack.'); throw new Error('No wallet') }
  const w = list.length > 1 ? await pickWallet(list) : list[0]; if (!w) throw new Error('Cancelled');
  const [name, p] = w; const r = await p.connect();
  const k = (r && r.publicKey) || p.publicKey; WAL.pk = new PublicKey(k.toString()); WAL.p = p; WAL.name = name;
  try { localStorage.setItem('stokz.w', name) } catch {}
  if (p.on) p.on('accountChanged', pk => { if (pk) WAL.pk = new PublicKey(pk.toString()); else WAL.pk = null; paintWallet(); route() });
  paintWallet(); return WAL.pk;
}
async function disconnect() { try { await WAL.p && WAL.p.disconnect && WAL.p.disconnect() } catch {} WAL.pk = null; WAL.p = null; try { localStorage.removeItem('stokz.w') } catch {} paintWallet(); route() }
function paintWallet() { const b = $('#wbtn'); if (WAL.pk) { b.classList.add('on'); b.innerHTML = `<i class="dot"></i>${short(WAL.pk.toBase58())}` } else { b.classList.remove('on'); b.textContent = 'Connect wallet' } }
async function signTx(tx) { if (!WAL.p) await connect(); const s = await WAL.p.signTransaction(tx); return s instanceof Transaction ? s : Transaction.from(s.serialize({ requireAllSignatures: false, verifySignatures: false })) }
async function sendRaw(tx) { return rpc('sendTransaction', [toB64(tx.serialize()), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]) }
async function confirmSig(sig, ms = 75000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]).catch(() => null);
    const s = r && r.value && r.value[0];
    if (s) { if (s.err) throw new Error('Transaction failed on-chain: ' + JSON.stringify(s.err)); if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return s }
    await sleep(1500);
  }
  throw new Error('Not confirmed yet. Check ' + short(sig) + ' on Solscan before retrying.');
}

/* ---------- chain reads ---------- */
async function mintInfo(mint) {
  const r = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]); const v = r && r.value; if (!v) throw new Error('Mint not found');
  const info = v.data.parsed.info; const ext = info.extensions || [];
  const fee = ext.find(e => e.extension === 'transferFeeConfig'); const hook = ext.find(e => e.extension === 'transferHook' && e.state && e.state.programId);
  return { program: new PublicKey(v.owner), decimals: info.decimals, supply: Number(info.supply) / 10 ** info.decimals, feeBps: fee ? fee.state.newerTransferFee.transferFeeBasisPoints : 0, hook: !!hook, frozen: ext.some(e => e.extension === 'defaultAccountState' && e.state.accountState === 'frozen') };
}
async function biggestBags(mint) {
  const r = await rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
  const accs = (r.value || []).filter(a => +a.uiAmount > 0);
  if (!accs.length) return [];
  const infos = await rpc('getMultipleAccounts', [accs.map(a => a.address), { encoding: 'jsonParsed' }]);
  return accs.map((a, i) => { const v = infos.value[i]; const owner = v && v.data && v.data.parsed ? v.data.parsed.info.owner : null; let wallet = false; try { wallet = owner && PublicKey.isOnCurve(new PublicKey(owner).toBytes()) } catch {} return { account: a.address, amount: +a.uiAmount, raw: a.amount, owner, wallet, frozen: v && v.data && v.data.parsed && v.data.parsed.info.state === 'frozen' } });
}
async function bagOf(owner, mint) {
  const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const l = (r.value || []).map(a => ({ account: a.pubkey, amount: +a.account.data.parsed.info.tokenAmount.uiAmount, raw: a.account.data.parsed.info.tokenAmount.amount, dec: a.account.data.parsed.info.tokenAmount.decimals, state: a.account.data.parsed.info.state, program: a.account.owner }));
  l.sort((a, b) => b.amount - a.amount); return l[0] || null;
}
const balance = async pk => (await rpc('getBalance', [pk, { commitment: 'confirmed' }])).value / 1e9;

/* ---------- the offer transaction ---------- */
const ataOf = (owner, mint, prog) => PublicKey.findProgramAddressSync([owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA)[0];
const ixAta = (payer, ata, owner, mint, prog) => new TransactionInstruction({ programId: ATA, data: Uint8Array.of(1), keys: [
  { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: false },
  { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: prog, isSigner: false, isWritable: false }] });
function ixTransferChecked(src, mint, dst, owner, amount, dec, prog) {
  const d = new Uint8Array(10); d[0] = 12; new DataView(d.buffer).setBigUint64(1, BigInt(amount), true); d[9] = dec;
  return new TransactionInstruction({ programId: prog, data: d, keys: [{ pubkey: src, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: dst, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }] });
}
// SOL transfer built by hand (web3's bigint encoder needs a global Buffer), tagged with the Stokz reference key
function ixPay(from, to, lamports) {
  const d = new Uint8Array(12); const v = new DataView(d.buffer); v.setUint32(0, 2, true); v.setBigUint64(4, BigInt(lamports), true);
  return new TransactionInstruction({ programId: SystemProgram.programId, data: d, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: REF, isSigner: false, isWritable: false }] });
}
function buildTrade({ maker, seller, buyer, src, mint, prog, dec, raw, lamports, nonce }) {
  const tx = new Transaction(); tx.feePayer = maker;
  if (nonce) tx.add(SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: maker }));
  const dst = ataOf(buyer, mint, prog);
  tx.add(ixAta(buyer, dst, buyer, mint, prog));
  tx.add(ixTransferChecked(src, mint, dst, seller, raw, dec, prog));
  tx.add(ixPay(buyer, seller, lamports));
  return tx;
}
const u32 = (d, o) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
const u64 = (d, o) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
function parseOffer(tx) {
  const ix = tx.instructions.filter(i => i.programId.toBase58() !== LIGHTHOUSE);
  const bad = m => { throw new Error('This link is not a valid Stokz offer (' + m + ')') };
  if (ix.length !== 4) bad('shape');
  const [adv, ata, xfer, pay] = ix, sys = SystemProgram.programId;
  if (!adv.programId.equals(sys) || u32(adv.data, 0) !== 4) bad('nonce');
  if (!ata.programId.equals(ATA)) bad('account');
  if (!(xfer.programId.equals(TOKEN) || xfer.programId.equals(TOKEN22)) || xfer.data[0] !== 12) bad('transfer');
  if (!pay.programId.equals(sys) || u32(pay.data, 0) !== 2 || !pay.keys[2] || !pay.keys[2].pubkey.equals(REF)) bad('payment');
  const maker = tx.feePayer, nonce = adv.keys[0].pubkey, auth = adv.keys[2].pubkey;
  const src = xfer.keys[0].pubkey, mint = xfer.keys[1].pubkey, dst = xfer.keys[2].pubkey, seller = xfer.keys[3].pubkey;
  const buyer = pay.keys[0].pubkey, payee = pay.keys[1].pubkey;
  if (!auth.equals(maker) || !payee.equals(seller) || !ata.keys[2].pubkey.equals(buyer) || !ata.keys[1].pubkey.equals(dst)) bad('parties');
  if (!dst.equals(ataOf(buyer, mint, xfer.programId))) bad('destination');
  if (!(maker.equals(buyer) || maker.equals(seller)) || buyer.equals(seller)) bad('maker');
  const ms = tx.signatures.find(s => s.publicKey.equals(maker));
  if (!ms || !ms.signature) bad('unsigned');
  let sigOk = false; try { sigOk = tx.verifySignatures(false) } catch {}
  if (!sigOk) bad('signature');
  const side = maker.equals(buyer) ? 'buy' : 'sell';
  return { tx, side, maker, buyer, seller, taker: side === 'buy' ? seller : buyer, nonce, src, dst, mint, prog: xfer.programId, raw: u64(xfer.data, 1), dec: xfer.data[9], lamports: Number(u64(pay.data, 4)), sig: b58(ms.signature), blockhash: tx.recentBlockhash, extra: tx.instructions.length - 4 };
}
async function offerState(o) {
  const st = await rpc('getSignatureStatuses', [[o.sig], { searchTransactionHistory: true }]).catch(() => null);
  const s = st && st.value && st.value[0];
  if (s && !s.err) return { state: 'filled', label: 'Filled', slot: s.slot };
  const n = await rpc('getAccountInfo', [o.nonce.toBase58(), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const v = n && n.value;
  if (!v) return { state: 'dead', label: 'Cancelled' };
  const info = v.data && v.data.parsed && v.data.parsed.info;
  if (!info || info.blockhash !== o.blockhash) return { state: 'dead', label: 'Cancelled or replaced' };
  return { state: 'open', label: 'Open', nonceLamports: v.lamports };
}
async function simulate(tx) {
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const r = await rpc('simulateTransaction', [toB64(bytes), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }]);
  return r.value;
}
const simError = v => { if (!v || !v.err) return null; const logs = (v.logs || []).join('\n'); if (/insufficient lamports|Insufficient funds|0x1\b/.test(logs)) return 'Not enough SOL or tokens on one side to settle.'; if (/frozen/i.test(logs)) return 'A token account is frozen.'; return 'Simulation failed: ' + JSON.stringify(v.err) };

/* ---------- my offers (this browser) ---------- */
const MY = { get() { try { return JSON.parse(localStorage.getItem('stokz.offers') || '[]') } catch { return [] } }, set(l) { try { localStorage.setItem('stokz.offers', JSON.stringify(l.slice(0, 200))) } catch {} }, add(o) { const l = MY.get().filter(x => x.sig !== o.sig && x.nonce !== o.nonce); l.unshift(o); MY.set(l) }, patch(nonce, p) { MY.set(MY.get().map(x => x.nonce === nonce ? { ...x, ...p } : x)) } };

/* ---------- rendering helpers ---------- */
const coin = (s, big) => `<div class="co"><img src="${esc(s.img || 'assets/img/favicon.png')}" alt="" loading="lazy" onerror="this.src='assets/img/favicon.png'"><div class="nm"><b>${esc(s.name)} <span class="mut" style="font-weight:600">$${esc(s.sym)}</span></b><small>${s.q ? `paired with <img src="${esc(s.q.logo)}" alt="" onerror="this.remove()">${esc(s.q.sym)}` : 'StonkFun'}${big ? '' : ''}</small></div></div>`;
function sorted() {
  let l = [...S.map.values()];
  const q = S.q.trim().toLowerCase();
  if (q) l = l.filter(s => s.mint.toLowerCase() === q || s.sym.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (s.q && s.q.sym && s.q.sym.toLowerCase() === q));
  const k = { mcap: s => s.mcap || 0, vol: s => s.vol || 0, liq: s => s.liq || 0, new: s => s.created || 0 }[S.sort];
  return l.sort((a, b) => k(b) - k(a));
}
function paintGrid() {
  const l = sorted(), g = $('#grid');
  if (!l.length) { g.innerHTML = `<div class="empty" style="grid-column:1/-1">${S.q ? 'No stock matches “' + esc(S.q) + '” in the loaded list. Paste a contract address to look it up.' : 'No stocks loaded.'}</div>`; $('#moreBtn').hidden = true; return }
  g.innerHTML = l.slice(0, S.shown).map(s => { const im = s.liq ? impact(s.liq, 10000) : null; return `<a class="card sc" href="#/s/${s.mint}">${s.q && s.q.logo ? `<img class="qlogo" src="${esc(s.q.logo)}" alt="" onerror="this.remove()">` : ''}${coin(s)}<div class="mc num">${fmtUsd(s.mcap)}</div><span class="${s.chg >= 0 ? 'up' : 'dn'} num" style="font-size:13px;font-weight:600">${s.chg != null ? (s.chg >= 0 ? '+' : '') + s.chg.toFixed(1) + '% 24h' : '&nbsp;'}</span><div class="kv num"><div><span>24h volume</span><b>${fmtUsd(s.vol)}</b></div><div><span>Liquidity</span><b>${fmtUsd(s.liq)}</b></div><div><span>$10K market sell</span><b class="dn">${im ? '−' + pct(im.drop) : '—'}</b></div><div><span>Via Stokz</span><b class="up">0.0%</b></div></div></a>` }).join('');
  $('#moreBtn').hidden = l.length <= S.shown;
}
function paintImpact() {
  const size = +($('#impSize .on') || {}).dataset?.v || 10000;
  const l = [...S.map.values()].filter(s => s.liq > 0).sort((a, b) => (b.mcap || 0) - (a.mcap || 0)).slice(0, 10);
  const mx = Math.max(...l.map(s => impact(s.liq, size).drop), 0.0001);
  const rows = l.map(s => { const im = impact(s.liq, size); return `<a class="row" href="#/s/${s.mint}">${coin(s)}<span class="num">${fmtUsd(s.price)}</span><span class="num">${fmtUsd(s.liq)}</span><span class="num dn"><b>−${pct(im.drop)}</b><div class="bar"><i style="width:${(im.drop / mx * 100).toFixed(1)}%"></i></div></span><span class="num dn">${fmtUsd(size * im.slip, 0)}</span><span class="num up"><b>0.0%</b></span><span><span class="btn sm ghost">Bags →</span></span></a>` }).join('');
  $('#imp').innerHTML = `<div class="row h"><span>Stock</span><span>Price</span><span>Liquidity</span><span>Price drop</span><span>You lose</span><span>Via Stokz</span><span></span></div>` + (rows || '<div class="empty" style="border:0">No liquidity data right now.</div>');
}
let heroSize = 25000, heroStock = null;
function paintHeroCard() {
  const s = heroStock; if (!s) return;
  const im = s.liq ? impact(s.liq, heroSize) : null;
  $('#hcard').innerHTML = `<div class="h"><img src="${esc(s.img)}" alt="" onerror="this.src='assets/img/favicon.png'"><div><b>$${esc(s.sym)} <span class="mut" style="font-weight:600">${esc(s.name !== s.sym ? s.name : '')}</span></b><small>${s.q ? 'paired with ' + esc(s.q.sym) + ' · ' : ''}${fmtUsd(s.mcap)} market cap</small></div><a class="go" href="#/s/${s.mint}">Bags →</a></div>
  <div class="hsize">${[5000, 25000, 100000].map(v => `<button data-v="${v}" class="${v === heroSize ? 'on' : ''}">Sell ${fmtUsd(v).replace('.0K', 'K')}</button>`).join('')}</div>
  <div class="hrow"><span>Market sell into the pool</span><strong class="dn num">${im ? '−' + pct(im.drop) + ' price' : '—'}</strong></div>
  <div class="hrow"><span>You'd get back</span><strong class="num">${im ? fmtUsd(im.get) : '—'}</strong></div>
  <div class="hrow"><span>Same bag through Stokz</span><strong class="up num">0.0% price move</strong></div>`;
  $$('.hsize button', $('#hcard')).forEach(b => b.onclick = () => { heroSize = +b.dataset.v; paintHeroCard() });
}
function paintBand() {
  const l = [...S.map.values()];
  $('#bTotal').textContent = S.total ? S.total.toLocaleString('en-US') : l.length;
  $('#bVol').textContent = fmtUsd(l.reduce((a, s) => a + (s.vol || 0), 0));
  $('#bLiq').textContent = fmtUsd(l.reduce((a, s) => a + (s.liq || 0), 0));
}

/* ---------- fills feed (by reference key) ---------- */
const FILLS = { list: null, err: null };
async function loadFills() {
  try {
    const sigs = (await rpc('getSignaturesForAddress', [REF.toBase58(), { limit: 50, commitment: 'confirmed' }])).filter(s => !s.err);
    const out = [];
    for (const s of sigs.slice(0, 20)) {
      const t = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      if (!t) continue;
      const ins = t.transaction.message.instructions.map(i => i.parsed).filter(Boolean);
      const tk = ins.find(p => p.type === 'transferChecked'), pay = ins.find(p => p.type === 'transfer' && p.info && p.info.lamports);
      if (!tk || !pay) continue;
      out.push({ sig: s.signature, t: (t.blockTime || s.blockTime) * 1000, mint: tk.info.mint, amount: tk.info.tokenAmount.uiAmount, seller: tk.info.authority || tk.info.multisigAuthority, buyer: pay.info.source, sol: pay.info.lamports / 1e9 });
    }
    FILLS.list = out; FILLS.count = sigs.length;
  } catch (e) { FILLS.err = e.message }
  paintFills();
}
function paintFills() {
  const el = $('#fillList');
  if (FILLS.err && !FILLS.list) { el.innerHTML = `<div class="empty">Couldn't read the chain right now (${esc(FILLS.err)}). Every fill is public: <a class="ice" href="${solscan(REF.toBase58())}" target="_blank" rel="noopener">reference key on Solscan</a>.</div>`; $('#bFills').textContent = '—'; $('#bSol').textContent = '—'; return }
  if (!FILLS.list) return;
  $('#bFills').textContent = FILLS.count; $('#bSol').textContent = FILLS.list.length ? fmtSol(FILLS.list.reduce((a, f) => a + f.sol, 0)) : '0 SOL';
  if (!FILLS.list.length) { el.innerHTML = '<div class="empty">No fills yet. The first settled offer lights up here.</div>'; return }
  el.innerHTML = FILLS.list.map(f => { const s = S.map.get(f.mint); return `<div class="fl"><div>${s ? coin(s) : `<span class="mono">${short(f.mint)}</span>`}</div><div class="num"><b>${fmtNum(f.amount)}</b><div class="mut" style="font-size:12px">${s ? '$' + esc(s.sym) : 'tokens'}</div></div><div class="num"><b>${fmtSol(f.sol)}</b><div class="mut" style="font-size:12px">${s && s.price && S.sol ? 'mkt ' + fmtUsd(f.amount * s.price) : ''}</div></div><div class="mut" style="font-size:12.5px">${short(f.seller)} → ${short(f.buyer)}</div><a class="btn sm ghost" href="${solscan(f.sig, 'tx')}" target="_blank" rel="noopener">${ago(f.t)} ↗</a></div>` }).join('');
}

/* ---------- stock view ---------- */
async function viewStock(mint) {
  const el = $('#v-stock'); el.innerHTML = `<a class="back" href="#desk">← The desk</a><div class="skel" style="min-height:140px"></div>`;
  let s; try { s = await stockByMint(mint) } catch {}
  if (!s) { el.innerHTML = `<a class="back" href="#desk">← The desk</a><div class="empty">That isn't a StonkFun stock (or StonkFun didn't answer). <a class="ice" href="#desk">Back to the desk</a></div>`; return }
  if (location.hash !== '#/s/' + mint) return;
  el.innerHTML = `<a class="back" href="#desk">← The desk</a>
  <div class="card shead"><img src="${esc(s.img)}" alt="" onerror="this.src='assets/img/favicon.png'"><div><h1>${esc(s.name)} <span class="mut">$${esc(s.sym)}</span></h1><div class="sub">${s.q ? `<span class="pill">paired with ${esc(s.q.sym)}${s.q.cat ? ' · ' + esc(s.q.cat) : ''}</span>` : ''}<a class="mono lt" href="${solscan(s.mint, 'token')}" target="_blank" rel="noopener">${short(s.mint)} ↗</a><a class="lt" href="${s.url}" target="_blank" rel="noopener">StonkFun page ↗</a></div></div>
  <div class="cta"><button class="btn" id="sellBtn">Sell yours OTC</button><a class="btn ghost" href="#/new?m=${s.mint}&side=buy">Offer on a wallet</a></div></div>
  <div class="card stats num"><div><span>Price</span><b>${fmtUsd(s.price)}</b></div><div><span>Market cap</span><b>${fmtUsd(s.mcap)}</b></div><div><span>24h volume</span><b>${fmtUsd(s.vol)}</b></div><div><span>Liquidity</span><b>${fmtUsd(s.liq)}</b></div><div><span>24h change</span><b class="${s.chg >= 0 ? 'up' : 'dn'}">${s.chg != null ? (s.chg >= 0 ? '+' : '') + s.chg.toFixed(1) + '%' : '—'}</b></div></div>
  <div class="two"><div class="card panel"><div class="ph"><div><h3>Biggest bags</h3><p>Top holders, read live from the chain. Pick one and make an offer.</p></div></div><div id="bags"><div class="skel" style="min-height:300px"></div></div></div>
  <div class="card panel calc"><h3>Dump it, or Stokz it</h3><p class="mut" style="font-size:13px;margin:4px 0 14px">What a market sell would do to this pool right now.</p><label><span>Sell size</span><b class="num" id="cSize"></b></label><input type="range" id="cRange" min="0" max="100" value="45"><div class="res num"><div><span>Price drop</span><b class="dn" id="cDrop">—</b></div><div><span>You get</span><b id="cGet">—</b></div><div><span>Lost to slippage</span><b class="dn" id="cLost">—</b></div><div><span>Via Stokz</span><b class="up">0.0%</b></div></div><p class="mut" style="font-size:12px;margin:12px 0 0">Constant-product estimate from ${fmtUsd(s.liq)} pool liquidity. Real fills also pay pool fees.</p></div></div>`;
  const sizeAt = v => Math.round(Math.pow(10, 2 + v / 100 * 3.7) / 100) * 100;
  const calc = () => { const usd = sizeAt(+$('#cRange').value); $('#cSize').textContent = fmtUsd(usd); const im = s.liq ? impact(s.liq, usd) : null; $('#cDrop').textContent = im ? '−' + pct(im.drop) : '—'; $('#cGet').textContent = im ? fmtUsd(im.get) : '—'; $('#cLost').textContent = im ? fmtUsd(usd - im.get) : '—' };
  $('#cRange').oninput = calc; calc();
  $('#sellBtn').onclick = () => { location.hash = `#/new?m=${s.mint}&side=sell` };
  try {
    const [bags, mi] = await Promise.all([biggestBags(s.mint), mintInfo(s.mint)]);
    if (location.hash !== '#/s/' + mint) return;
    if (!bags.length) { $('#bags').innerHTML = '<div class="empty">No holders found.</div>'; return }
    $('#bags').innerHTML = bags.map((b, i) => `<div class="hold num"><span class="rk">${i + 1}</span><div>${b.wallet ? `<a class="w mono" href="${solscan(b.owner)}" target="_blank" rel="noopener">${short(b.owner)}</a>` : `<span class="mono mut">${short(b.owner || b.account)}</span>`}${!b.wallet ? ' <span class="pill">pool / program</span>' : b.frozen ? ' <span class="pill r">frozen</span>' : ''}</div><div><b>${fmtNum(b.amount)}</b><div class="mut" style="font-size:12px">${s.price ? fmtUsd(b.amount * s.price) : ''}</div></div><span class="mut">${mi.supply ? pct(b.amount / mi.supply) : ''}</span>${b.wallet && !b.frozen ? `<a class="btn sm" href="#/new?m=${s.mint}&side=buy&to=${b.owner}">Make offer</a>` : '<span></span>'}</div>`).join('');
  } catch (e) { $('#bags').innerHTML = `<div class="empty">Couldn't read holders right now (${esc(e.message)}). You can still <a class="ice" href="#/new?m=${s.mint}&side=buy">offer on a wallet you know</a>.</div>` }
}

/* ---------- composer ---------- */
async function viewNew(params) {
  const el = $('#v-new'); const mint = params.get('m'); let side = params.get('side') === 'sell' ? 'sell' : 'buy';
  el.innerHTML = `<a class="back" href="#/s/${esc(mint)}">← Back</a><div class="skel" style="min-height:300px"></div>`;
  const s = mint && await stockByMint(mint).catch(() => null);
  if (!s) { el.innerHTML = `<a class="back" href="#desk">← The desk</a><div class="empty">Pick a StonkFun stock first. <a class="ice" href="#desk">Open the desk</a></div>`; return }
  let mi; try { mi = await mintInfo(mint) } catch (e) { el.innerHTML = `<a class="back" href="#/s/${mint}">← Back</a><div class="empty">Couldn't read the token from the chain (${esc(e.message)}). Try again in a moment.</div>`; return }
  const st = { side, to: params.get('to') || '', amount: 0, prem: 0, bag: null, myBag: null };
  el.innerHTML = `<a class="back" href="#/s/${s.mint}">← ${esc(s.name)}</a><div class="two" style="margin-top:0">
  <div class="card panel"><div class="ph"><div><h3>New offer</h3><p>You sign first. They sign to settle. Nothing moves until both of you have.</p></div></div>
    <div class="seg" id="nSide"><button data-v="buy">Buy their bag</button><button data-v="sell">Sell my bag</button></div>
    <div class="field"><span><b id="nToL"></b><em class="mut" id="nToH"></em></span><div class="inp"><input id="nTo" placeholder="Solana wallet address" spellcheck="false" autocomplete="off"></div></div>
    <div class="field"><span><b>Amount of $${esc(s.sym)}</b><em class="mut" id="nBag"></em></span><div class="inp"><input id="nAmt" inputmode="decimal" placeholder="0"><em>$${esc(s.sym)}</em></div><div class="quick">${[10, 25, 50, 100].map(p => `<button data-p="${p}">${p}%</button>`).join('')}</div></div>
    <div class="field"><span><b>Your price vs market</b><em class="num" id="nPremL">0%</em></span><input type="range" id="nPrem" min="-50" max="50" value="0" step="1"></div>
    <div class="sum num" id="nSum"></div>
    <div id="nNote"></div>
    <div class="go-row"><button class="btn" id="nGo">Sign offer</button></div>
    <ul class="prog" id="nProg" hidden><li data-k="nonce"><i></i>Create your one-time nonce (≈0.0015 SOL, refundable)</li><li data-k="sign"><i></i>Sign your half of the trade</li><li data-k="link"><i></i>Get your offer link</li></ul>
    <div id="nDone"></div>
  </div>
  <div class="card panel"><h3>${esc(s.name)} <span class="mut">$${esc(s.sym)}</span></h3><p class="mut" style="font-size:13px;margin:4px 0 16px">${fmtUsd(s.price)} · ${fmtUsd(s.mcap)} mcap · ${fmtUsd(s.liq)} liquidity</p>
    <div class="res num"><div><span>Market sell of this size</span><b class="dn" id="nDrop">—</b></div><div><span>Seller would get</span><b id="nMkt">—</b></div><div><span>Your offer pays</span><b id="nPay">—</b></div><div><span>vs dumping it</span><b id="nEdge">—</b></div></div>
    ${mi.feeBps ? `<div class="note">$${esc(s.sym)} has a ${(mi.feeBps / 100).toFixed(2)}% token transfer fee. The buyer receives the amount minus that fee.</div>` : ''}
    ${mi.hook ? `<div class="note warn">This token uses a transfer hook, which Stokz offers don't support yet.</div>` : ''}
    <div class="note">The price is locked in SOL when you sign. SOL at ${S.sol ? fmtUsd(S.sol) : '—'}.</div></div></div>`;
  const amtIn = $('#nAmt'), toIn = $('#nTo');
  toIn.value = st.to;
  const setSide = v => { st.side = v; $$('#nSide button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); $('#nToL').textContent = v === 'buy' ? 'Their wallet (the holder)' : 'Buyer wallet'; $('#nToH').textContent = v === 'buy' ? 'they sign to sell' : 'they sign to pay'; loadBags() };
  async function loadBags() {
    st.bag = null; $('#nBag').textContent = '';
    if (st.side === 'buy') { let to; try { to = new PublicKey(toIn.value.trim()) } catch { paint(); return } $('#nBag').textContent = 'reading their bag…'; try { st.bag = await bagOf(to.toBase58(), mint) } catch {} $('#nBag').textContent = st.bag ? 'their bag: ' + fmtNum(st.bag.amount) : 'no $' + s.sym + ' in that wallet' }
    else if (WAL.pk) { $('#nBag').textContent = 'reading your bag…'; try { st.myBag = st.bag = await bagOf(WAL.pk.toBase58(), mint) } catch {} $('#nBag').textContent = st.bag ? 'your bag: ' + fmtNum(st.bag.amount) : 'no $' + s.sym + ' in your wallet' }
    else $('#nBag').innerHTML = '<a class="ice" href="javascript:void 0" id="nConn">connect to read your bag</a>';
    const c = $('#nConn'); if (c) c.onclick = () => connect().then(loadBags).catch(() => {});
    paint();
  }
  function totals() {
    const amt = parseFloat(String(amtIn.value).replace(/,/g, '')) || 0; const pxu = (s.price || 0) * (1 + st.prem / 100);
    const usd = amt * pxu, sol = S.sol ? usd / S.sol : 0; const im = s.liq && amt ? impact(s.liq, amt * (s.price || 0)) : null;
    return { amt, pxu, usd, sol, lamports: Math.round(sol * 1e9), im, raw: amt ? BigInt(Math.round(amt * 10 ** Math.min(mi.decimals, 9))) * 10n ** BigInt(Math.max(0, mi.decimals - 9)) : 0n };
  }
  function paint() {
    const t = totals(); $('#nPremL').textContent = (st.prem > 0 ? '+' : '') + st.prem + '%';
    $('#nSum').innerHTML = `<div><span>${st.side === 'buy' ? 'You receive' : 'You send'}</span><b>${t.amt ? fmtNum(t.amt) : '—'} $${esc(s.sym)}</b></div><div><span>Price per token</span><b>${fmtUsd(t.pxu)}</b></div><div><span>${st.side === 'buy' ? 'You pay' : 'You receive'}</span><b>${t.lamports ? fmtSol(t.lamports / 1e9) : '—'} <span class="mut">${t.usd ? '≈ ' + fmtUsd(t.usd) : ''}</span></b></div><div><span>Counterparty</span><b class="mono">${short(toIn.value.trim()) || '—'}</b></div>`;
    $('#nDrop').textContent = t.im ? '−' + pct(t.im.drop) : '—'; $('#nMkt').textContent = t.im ? fmtUsd(t.im.get) : '—'; $('#nPay').textContent = t.usd ? fmtUsd(t.usd) : '—';
    const edge = t.im && t.im.get ? t.usd / t.im.get - 1 : null; const ed = $('#nEdge'); ed.textContent = edge == null ? '—' : (edge >= 0 ? '+' : '') + pct(edge); ed.className = edge == null ? '' : edge >= 0 ? 'up' : 'dn';
    const notes = [];
    if (st.bag && t.amt > st.bag.amount) notes.push(['warn', `That's more than ${st.side === 'buy' ? 'their' : 'your'} bag (${fmtNum(st.bag.amount)}).`]);
    if (st.bag && st.bag.state === 'frozen') notes.push(['warn', 'That token account is frozen, so it can\'t be traded.']);
    if (WAL.pk && toIn.value.trim() === WAL.pk.toBase58()) notes.push(['warn', 'The counterparty is your own wallet.']);
    $('#nNote').innerHTML = notes.map(n => `<div class="note ${n[0]}">${esc(n[1])}</div>`).join('');
    $('#nGo').textContent = WAL.pk ? 'Sign offer' : 'Connect wallet to sign';
  }
  $$('#nSide button').forEach(b => b.onclick = () => setSide(b.dataset.v));
  $$('.quick button', el).forEach(b => b.onclick = () => { if (!st.bag) { toast(st.side === 'buy' ? 'Enter a wallet that holds the stock first' : 'Connect a wallet that holds the stock'); return } const v = st.bag.amount * (+b.dataset.p) / 100; amtIn.value = +v.toFixed(Math.min(mi.decimals, 6)); paint() });
  amtIn.oninput = paint; let tt; toIn.oninput = () => { clearTimeout(tt); tt = setTimeout(loadBags, 350); paint() };
  $('#nPrem').oninput = e => { st.prem = +e.target.value; paint() };
  $('#nGo').onclick = () => createOffer(s, mi, st, totals()).catch(e => { $('#nNote').innerHTML = `<div class="note warn">${esc(e.message || e)}</div>`; $('#nGo').disabled = false; $$('#nProg li.on').forEach(li => li.classList.remove('on')) });
  setSide(side);
}
async function createOffer(s, mi, st, t) {
  const maker = await connect(); const go = $('#nGo');
  let cp; try { cp = new PublicKey($('#nTo').value.trim()) } catch { throw new Error('Enter a valid counterparty wallet.') }
  if (cp.equals(maker)) throw new Error("You can't trade with yourself.");
  if (!t.amt || !t.lamports) throw new Error('Set an amount' + (S.sol ? '' : ' (SOL price unavailable, try again shortly)') + '.');
  if (mi.hook) throw new Error('Transfer-hook tokens are not supported yet.');
  const seller = st.side === 'buy' ? cp : maker, buyer = st.side === 'buy' ? maker : cp;
  const bag = await bagOf(seller.toBase58(), s.mint);
  if (!bag || bag.amount < t.amt) throw new Error((st.side === 'buy' ? 'They hold' : 'You hold') + ' ' + (bag ? fmtNum(bag.amount) : 'no') + ' $' + s.sym + ', less than the offer.');
  if (bag.state === 'frozen') throw new Error('That token account is frozen.');
  const rent = await rpc('getMinimumBalanceForRentExemption', [NONCE_LEN]);
  const myBal = await balance(maker.toBase58());
  const need = rent / 1e9 + 0.00002 + (st.side === 'buy' ? t.lamports / 1e9 + 0.0021 : 0);
  if (myBal < need) throw new Error(`You need about ${fmtSol(need)} in this wallet (you have ${fmtSol(myBal)}).`);
  go.disabled = true; $('#nProg').hidden = false; const step = (k, c) => { const li = $(`#nProg li[data-k="${k}"]`); li.classList.remove('on', 'done'); if (c) li.classList.add(c) };
  // 1. durable nonce, derived from the maker's own key (no extra keypair)
  step('nonce', 'on');
  const seed = 'stokz' + Date.now().toString(36);
  const nonce = await PublicKey.createWithSeed(maker, seed, SystemProgram.programId);
  const ntx = SystemProgram.createNonceAccount({ fromPubkey: maker, noncePubkey: nonce, basePubkey: maker, seed, authorizedPubkey: maker, lamports: rent });
  ntx.feePayer = maker; ntx.recentBlockhash = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const nsig = await sendRaw(await signTx(ntx));
  MY.add({ nonce: nonce.toBase58(), seed, maker: maker.toBase58(), mint: s.mint, sym: s.sym, side: st.side, cp: cp.toBase58(), amt: t.amt, sol: t.lamports / 1e9, t: Date.now(), pending: true });
  await confirmSig(nsig);
  let nv = null; for (let i = 0; i < 20 && !nv; i++) { const r = await rpc('getAccountInfo', [nonce.toBase58(), { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => null); nv = r && r.value && r.value.data.parsed && r.value.data.parsed.info.blockhash; if (!nv) await sleep(1000) }
  if (!nv) throw new Error('Nonce created but not readable yet. Reclaim it from My offers and try again.');
  step('nonce', 'done'); step('sign', 'on');
  // 2. the trade, signed by the maker only
  const tx = buildTrade({ maker, seller, buyer, src: new PublicKey(bag.account), mint: new PublicKey(s.mint), prog: mi.program, dec: mi.decimals, raw: t.raw, lamports: t.lamports, nonce });
  tx.recentBlockhash = nv;
  const signed = await signTx(tx);
  const o = parseOffer(signed);
  step('sign', 'done'); step('link', 'on');
  const link = location.origin + location.pathname + '#/o/' + b64url(signed.serialize({ requireAllSignatures: false, verifySignatures: false }));
  MY.add({ nonce: nonce.toBase58(), seed, maker: maker.toBase58(), mint: s.mint, sym: s.sym, side: st.side, cp: cp.toBase58(), amt: t.amt, sol: t.lamports / 1e9, t: Date.now(), sig: o.sig, link, blockhash: nv });
  step('link', 'done');
  const tw = `${st.side === 'buy' ? 'I just made an offer on your' : 'Selling my'} $${s.sym} bag OTC on stokz: ${fmtNum(t.amt)} $${s.sym} for ${fmtSol(t.lamports / 1e9)}. One transaction, the chart never moves.\n\n`;
  $('#nDone').innerHTML = `<div class="note ok">Offer signed. Send this link to ${short(cp.toBase58())}. It settles the moment they sign.</div><div class="link"><input readonly value="${esc(link)}"><button class="btn sm" id="cpL">Copy</button></div><div class="go-row"><a class="btn ghost" target="_blank" rel="noopener" href="https://x.com/intent/tweet?text=${encodeURIComponent(tw)}&url=${encodeURIComponent(link)}">Post on X</a><a class="btn ghost" href="#/o/${link.split('#/o/')[1]}">Open offer</a></div>`;
  $('#cpL').onclick = () => copy(link, 'Offer link copied');
  go.hidden = true;
}

/* ---------- offer view ---------- */
async function viewOffer(payload) {
  const el = $('#v-offer'); el.innerHTML = `<a class="back" href="#desk">← The desk</a><div class="skel" style="min-height:300px"></div>`;
  let o; try { o = parseOffer(Transaction.from(fromB64url(payload))) } catch (e) { el.innerHTML = `<a class="back" href="#desk">← The desk</a><div class="empty">${esc(e.message || 'Invalid offer link')}</div>`; return }
  const s = await stockByMint(o.mint.toBase58()).catch(() => null);
  const mi = await mintInfo(o.mint.toBase58()).catch(() => null);
  const dec = o.dec, amt = Number(o.raw) / 10 ** dec, sym = s ? s.sym : short(o.mint.toBase58());
  const sol = o.lamports / 1e9, mktUsd = s && s.price ? amt * s.price : null, offUsd = S.sol ? sol * S.sol : null;
  const prem = mktUsd && offUsd ? offUsd / mktUsd - 1 : null;
  el.innerHTML = `<a class="back" href="#desk">← The desk</a>
  <div class="card panel" style="padding:28px"><div class="ph"><div><div class="eyebrow">${o.side === 'buy' ? 'Offer to buy a bag' : 'Offer to sell a bag'}</div><h3 style="font-size:30px;margin-top:8px">${s ? esc(s.name) : 'Token'} <span class="mut">$${esc(sym)}</span></h3></div><span class="status" id="oSt">Checking…</span></div>
  <div class="deal num"><div class="side"><span>Seller sends</span><b>${fmtNum(amt)}</b><small>$${esc(sym)}${mktUsd ? ' · mkt ' + fmtUsd(mktUsd) : ''}</small><div class="mono mut" style="margin-top:8px">${short(o.seller.toBase58())}</div></div>
  <svg viewBox="0 0 60 40"><path d="M6,14 H50 M42,6 L50,14 L42,22" fill="none" stroke="#90d8f0" stroke-width="2.5"/><path d="M54,28 H10 M18,20 L10,28 L18,36" fill="none" stroke="#39d6a3" stroke-width="2.5"/></svg>
  <div class="side"><span>Buyer pays</span><b>${fmtSol(sol)}</b><small>${offUsd ? '≈ ' + fmtUsd(offUsd) : ''}${prem != null ? ` · <span class="${prem >= 0 ? 'up' : 'dn'}">${(prem >= 0 ? '+' : '') + pct(prem)} vs market</span>` : ''}</small><div class="mono mut" style="margin-top:8px">${short(o.buyer.toBase58())}</div></div></div>
  <div class="sum"><div><span>Made by</span><b class="mono">${short(o.maker.toBase58())} (${o.side === 'buy' ? 'buyer' : 'seller'})</b></div><div><span>Waiting on</span><b class="mono">${short(o.taker.toBase58())} (${o.side === 'buy' ? 'seller' : 'buyer'})</b></div><div><span>Settles as</span><b class="mono">${short(o.sig)}</b></div>${mi && mi.feeBps ? `<div><span>Token transfer fee</span><b>${(mi.feeBps / 100).toFixed(2)}% of the tokens</b></div>` : ''}${o.extra ? `<div><span>Wallet safety checks</span><b>${o.extra} extra instruction${o.extra > 1 ? 's' : ''} added by the maker's wallet</b></div>` : ''}</div>
  <div id="oNote"></div><div class="go-row" id="oActs"></div></div>`;
  const acts = $('#oActs'), note = (c, m) => $('#oNote').insertAdjacentHTML('beforeend', `<div class="note ${c}">${m}</div>`);
  let state; try { state = await offerState(o) } catch (e) { $('#oSt').textContent = 'Unknown'; note('warn', 'Couldn\'t check the chain: ' + esc(e.message)); return }
  const stEl = $('#oSt'); stEl.textContent = state.label; stEl.className = 'status ' + state.state;
  if (state.state === 'filled') { note('ok', `Settled on-chain. <a class="ice" href="${solscan(o.sig, 'tx')}" target="_blank" rel="noopener">View the transaction ↗</a>`); return }
  if (state.state === 'dead') { note('warn', 'This offer was cancelled by the maker, so it can no longer settle.'); return }
  const sim = await simulate(o.tx).catch(e => ({ err: e.message }));
  const se = simError(sim);
  if (se) note('warn', esc(se) + ' The offer stays open, so it can still settle once both sides have the funds.'); else note('ok', 'Simulated against the live chain just now: it settles as signed.');
  const me = WAL.pk;
  if (!me) { acts.innerHTML = `<button class="btn" id="oConn">Connect wallet</button>`; $('#oConn').onclick = () => connect().then(() => viewOffer(payload)).catch(() => {}); return }
  if (me.equals(o.taker)) {
    acts.innerHTML = `<button class="btn" id="oAcc">${o.side === 'buy' ? 'Accept and sell' : 'Accept and buy'}</button>`;
    $('#oAcc').onclick = async () => {
      const b = $('#oAcc'); b.disabled = true; b.textContent = 'Waiting for your signature…';
      try { const signed = await signTx(o.tx); b.textContent = 'Settling…'; const sig = await sendRaw(signed); await confirmSig(sig); toast('Filled. One transaction, chart untouched.'); viewOffer(payload); loadFills() }
      catch (e) { b.disabled = false; b.textContent = 'Try again'; note('warn', esc(e.message || e)) }
    };
  } else if (me.equals(o.maker)) {
    acts.innerHTML = `<button class="btn ghost" id="oCopy">Copy link</button><button class="btn ghost" id="oCancel">Cancel offer and reclaim rent</button>`;
    $('#oCopy').onclick = () => copy(location.href, 'Offer link copied');
    $('#oCancel').onclick = () => cancelNonce(o.nonce.toBase58()).then(() => viewOffer(payload)).catch(e => note('warn', esc(e.message)));
  } else note('', `Only ${short(o.taker.toBase58())} can accept this offer. You're connected as ${short(me.toBase58())}.`);
}
async function cancelNonce(nonce) {
  const me = await connect();
  const r = await rpc('getAccountInfo', [nonce, { encoding: 'jsonParsed', commitment: 'confirmed' }]); const v = r && r.value;
  if (!v) { MY.patch(nonce, { reclaimed: true }); toast('Already closed'); return }
  if (v.data.parsed.info.authority !== me.toBase58()) throw new Error('Only the wallet that made the offer can cancel it.');
  const tx = new Transaction().add(SystemProgram.nonceWithdraw({ noncePubkey: new PublicKey(nonce), authorizedPubkey: me, toPubkey: me, lamports: v.lamports }));
  tx.feePayer = me; tx.recentBlockhash = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const sig = await sendRaw(await signTx(tx)); await confirmSig(sig);
  MY.patch(nonce, { reclaimed: true }); toast('Offer cancelled, rent returned');
}

/* ---------- my offers ---------- */
async function viewMe() {
  const el = $('#v-me'); const l = MY.get();
  el.innerHTML = `<div class="sec" style="padding-top:40px"><div class="hd"><div><div class="eyebrow">My offers</div><h2>Offers made in this browser</h2><p>Offer links live in your link and on-chain, not on a server. This list is kept on this device.</p></div></div><div class="card my" id="myList">${l.length ? '' : '<div class="empty">No offers yet. <a class="ice" href="#desk">Make your first one</a>.</div>'}</div></div>`;
  if (!l.length) return;
  $('#myList').innerHTML = l.map((o, i) => `<div class="mo num" data-i="${i}"><div><b>${o.side === 'buy' ? 'Buy' : 'Sell'} ${fmtNum(o.amt)} $${esc(o.sym)}</b><div class="mut" style="font-size:12px">${ago(o.t)} · with <span class="mono">${short(o.cp)}</span></div></div><div><b>${fmtSol(o.sol)}</b></div><div><span class="status" data-st>${o.reclaimed ? 'Closed' : 'Checking…'}</span></div><div class="mut mono" style="font-size:12px">${o.sig ? short(o.sig) : 'not signed'}</div><div class="acts"></div></div>`).join('');
  for (const [i, o] of l.entries()) {
    const row = $(`.mo[data-i="${i}"]`), stE = $('[data-st]', row), acts = $('.acts', row);
    let st = null;
    if (o.sig && o.blockhash) { try { st = await offerState({ sig: o.sig, nonce: new PublicKey(o.nonce), blockhash: o.blockhash }) } catch {} }
    let alive = false; try { const r = await rpc('getAccountInfo', [o.nonce, { encoding: 'jsonParsed', commitment: 'confirmed' }]); alive = !!(r && r.value) } catch {}
    if (st) { stE.textContent = st.state === 'dead' && !alive ? 'Closed' : st.label; stE.className = 'status ' + st.state } else { stE.textContent = alive ? 'Unsigned (rent locked)' : 'Closed'; stE.className = 'status dead' }
    if (o.link && st && st.state === 'open') acts.insertAdjacentHTML('beforeend', `<button class="btn sm ghost" data-a="copy">Copy link</button><a class="btn sm ghost" href="#/o/${o.link.split('#/o/')[1]}">Open</a>`);
    if (st && st.state === 'filled') acts.insertAdjacentHTML('beforeend', `<a class="btn sm ghost" href="${solscan(o.sig, 'tx')}" target="_blank" rel="noopener">Fill ↗</a>`);
    if (alive) acts.insertAdjacentHTML('beforeend', `<button class="btn sm" data-a="cancel">${st && st.state === 'open' ? 'Cancel' : 'Reclaim rent'}</button>`);
    acts.onclick = e => { const a = e.target.closest('[data-a]'); if (!a) return; if (a.dataset.a === 'copy') copy(o.link, 'Offer link copied'); if (a.dataset.a === 'cancel') { a.disabled = true; cancelNonce(o.nonce).then(viewMe).catch(err => { a.disabled = false; toast(err.message) }) } };
  }
}

/* ---------- router ---------- */
const VIEWS = ['home', 'stock', 'new', 'offer', 'me'];
function show(v) { VIEWS.forEach(x => { $('#v-' + x).hidden = x !== v }); $$('#nav a').forEach(a => a.classList.toggle('on', (v === 'me' && a.getAttribute('href') === '#/me'))) }
function route() {
  const h = location.hash || '';
  if (h.startsWith('#/s/')) { show('stock'); scrollTo(0, 0); viewStock(h.slice(4)) }
  else if (h.startsWith('#/new')) { show('new'); scrollTo(0, 0); viewNew(new URLSearchParams(h.split('?')[1] || '')) }
  else if (h.startsWith('#/o/')) { show('offer'); scrollTo(0, 0); viewOffer(h.slice(4)) }
  else if (h === '#/me') { show('me'); scrollTo(0, 0); viewMe() }
  else { const was = $('#v-home').hidden; show('home'); const id = h.replace('#', ''); const t = id && !id.startsWith('/') && document.getElementById(id); if (t) setTimeout(() => t.scrollIntoView({ behavior: was ? 'auto' : 'smooth' }), was ? 30 : 0); else if (h === '#/' || was) scrollTo(0, 0) }
}

/* ---------- hero chart: a wavy chart that goes flat where the two halves meet ---------- */
function heroChart() {
  const svg = $('#hchart'); const NS = 'http://www.w3.org/2000/svg';
  svg.innerHTML = `<defs><linearGradient id="hl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f3f8f8" stop-opacity=".15"/><stop offset=".6" stop-color="#f3f8f8" stop-opacity=".7"/><stop offset="1" stop-color="#f3f8f8" stop-opacity=".35"/></linearGradient><radialGradient id="hg"><stop offset="0" stop-color="#90d8f0" stop-opacity=".35"/><stop offset="1" stop-color="#90d8f0" stop-opacity="0"/></radialGradient></defs>
  <circle cx="300" cy="150" r="150" fill="url(#hg)"/><path id="hpath" fill="none" stroke="url(#hl)" stroke-width="3" stroke-dasharray="12 10" stroke-linecap="round"/>
  <g id="hdome"><path d="M-78,0 A78,78 0 0 1 78,0 Z" fill="url(#gSide)" transform="translate(4,9)"/><path d="M-78,0 A78,78 0 0 1 78,0 Z" fill="url(#gTop)"/></g>
  <g id="hbowl"><path d="M-78,0 A78,78 0 0 0 78,0 Z" fill="url(#gSide)" transform="translate(4,9)"/><path d="M-78,0 A78,78 0 0 0 78,0 Z" fill="url(#gTop)"/></g>
  <circle id="hring" cx="300" cy="150" r="84" fill="none" stroke="#39d6a3" stroke-width="2" opacity="0"/><circle id="hdot" r="6" fill="#39d6a3"/>`;
  const P = $('#hpath'), D = $('#hdome'), B = $('#hbowl'), R = $('#hring'), dot = $('#hdot');
  const Y = 150, ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const wave = (x, a, ph = 0) => Y + a * (Math.sin((x + ph) / 38) * 30 + Math.sin((x + ph) / 17 + 1) * 10) * Math.max(0, Math.min(1, (190 - x) / 110));
  let t0 = performance.now(), vis = true;
  new IntersectionObserver(e => { vis = e[0].isIntersecting }).observe(svg);
  function frame(now) {
    requestAnimationFrame(frame); if (!vis || document.hidden) return;
    const T = ((now - t0) / 1000) % 6.4; // 0-2 apart, 2-3 meet, 3-4.6 locked, 4.6-6.4 part
    const meet = T < 2 ? 0 : T < 3 ? ease(T - 2) : T < 4.6 ? 1 : T < 5.8 ? 1 - ease((T - 4.6) / 1.2) : 0;
    const a = 1 - meet * 0.15;
    let d = ''; for (let x = -20; x <= 600; x += 8) d += (x === -20 ? 'M' : 'L') + x + ',' + wave(x, a, now / 30).toFixed(1);
    P.setAttribute('d', d);
    const gap = 120 * (1 - meet) + 4;
    D.setAttribute('transform', `translate(${300 - gap * .9},${Y - 2 - gap * .32})`);
    B.setAttribute('transform', `translate(${300 + gap * .9},${Y + 2 + gap * .32})`);
    const flash = T >= 3 && T < 4.6 ? Math.max(0, 1 - (T - 3) / 1.2) : 0;
    R.setAttribute('opacity', flash.toFixed(2)); R.setAttribute('r', (84 + (1 - flash) * 34).toFixed(1));
    const dx = 40 + ((now / 16) % 520); dot.setAttribute('cx', dx); dot.setAttribute('cy', wave(dx, a, now / 30));
  }
  requestAnimationFrame(frame);
}

/* ---------- intro: two halves of a deal meet on the chart, the line goes flat ---------- */
function intro() {
  const el = $('#intro'); const freeze = new URLSearchParams(location.search).get('it');
  const done = () => { if (el.classList.contains('out')) return; el.classList.add('out'); document.body.classList.remove('locked'); setTimeout(() => el.remove(), 800) };
  if (location.hash.length > 2 && location.hash !== '#/' && freeze == null) { el.remove(); document.body.classList.remove('locked'); return }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches && freeze == null) { done(); return }
  $('#skip').onclick = done;
  const svg = $('#isvg');
  svg.innerHTML = `<defs><radialGradient id="ig"><stop offset="0" stop-color="#90d8f0" stop-opacity=".45"/><stop offset="1" stop-color="#90d8f0" stop-opacity="0"/></radialGradient></defs>
  <circle id="iglow" cx="550" cy="260" r="260" fill="url(#ig)" opacity="0"/>
  <path id="iline" fill="none" stroke="#f3f8f8" stroke-opacity=".55" stroke-width="3" stroke-dasharray="14 11" stroke-linecap="round"/>
  <g id="idome"><path d="M-110,0 A110,110 0 0 1 110,0 Z" fill="url(#gSide)" transform="translate(6,12)"/><path d="M-110,0 A110,110 0 0 1 110,0 Z" fill="url(#gTop)"/></g>
  <g id="ibowl"><path d="M-110,0 A110,110 0 0 0 110,0 Z" fill="url(#gSide)" transform="translate(6,12)"/><path d="M-110,0 A110,110 0 0 0 110,0 Z" fill="url(#gTop)"/></g>
  <circle id="iring" cx="550" cy="260" r="118" fill="none" stroke="#39d6a3" stroke-width="3" opacity="0"/>
  <text id="ifill" x="550" y="430" text-anchor="middle" fill="#39d6a3" font-family="Sora" font-weight="700" font-size="15" letter-spacing="4" opacity="0">FILLED · PRICE MOVE 0.00%</text>
  <text id="iword" x="580" y="294" fill="#f3f8f8" font-family="Sora" font-weight="800" font-size="104" letter-spacing="-6" opacity="0">stokz</text>`;
  const L = $('#iline'), Dm = $('#idome'), Bw = $('#ibowl'), Rg = $('#iring'), Fl = $('#ifill'), Wd = $('#iword'), Gl = $('#iglow'), cap = $('#icap');
  const Y = 260, ease = t => t <= 0 ? 0 : t >= 1 ? 1 : t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, cl = (a, b, t) => Math.max(0, Math.min(1, (t - a) / (b - a)));
  const wave = (x, a) => Y + a * (Math.sin(x / 50) * 70 + Math.sin(x / 21 + 2) * 22);
  const END = 4.9; let t0 = performance.now();
  function draw(T) {
    const draw = ease(cl(0, 1.1, T)), flat = ease(cl(2.05, 2.75, T)), meet = ease(cl(0.7, 2.0, T)), split = ease(cl(3.15, 4.0, T));
    let d = ''; const xmax = -40 + draw * 1180;
    for (let x = -40; x <= xmax; x += 10) d += (x === -40 ? 'M' : 'L') + x + ',' + wave(x, 1 - flat).toFixed(1);
    L.setAttribute('d', d || 'M0,0'); L.setAttribute('stroke-opacity', (.55 * (1 - split * .7)).toFixed(2));
    const gap = 520 * (1 - meet) + 6, lerp = (a, b) => a + (b - a) * split;
    Dm.setAttribute('transform', `translate(${lerp(550 - gap, 326)},${Y - 3}) scale(${1 - split * .42})`);
    Bw.setAttribute('transform', `translate(${lerp(550 + gap * .9, 474)},${Y + 3}) scale(${1 - split * .42})`);
    Dm.style.opacity = Bw.style.opacity = Math.min(1, cl(0.5, 0.9, T)).toFixed(2);
    const fl = T > 2.0 && T < 3.6 ? Math.sin(Math.PI * cl(2.0, 3.6, T)) : 0;
    Rg.setAttribute('opacity', fl.toFixed(2)); Rg.setAttribute('r', (118 + cl(2.0, 3.6, T) * 60).toFixed(1)); Gl.setAttribute('opacity', (fl * .9 + split * .3).toFixed(2));
    Fl.setAttribute('opacity', (T > 2.2 && T < 3.3 ? Math.min(1, (T - 2.2) * 4) * Math.min(1, (3.3 - T) * 4) : 0).toFixed(2));
    Wd.setAttribute('opacity', ease(cl(3.5, 4.1, T)).toFixed(2)); Wd.setAttribute('x', (580 + (1 - ease(cl(3.5, 4.1, T))) * 30).toFixed(1));
    cap.classList.toggle('on', T > 3.7);
  }
  if (freeze != null) { draw(+freeze); return }
  function frame(now) { const T = (now - t0) / 1000; draw(T); if (T < END) requestAnimationFrame(frame); else done() }
  requestAnimationFrame(frame);
}

/* ---------- reveal on scroll ---------- */
function reveals() { const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('shown'); io.unobserve(e.target) } }), { threshold: .08 }); $$('.reveal').forEach(x => io.observe(x)) }

/* ---------- top bar extras ---------- */
function topbar() {
  const c = window.STOKZ || {}; const tr = $('#tright');
  if (c.x) tr.insertAdjacentHTML('afterbegin', `<a class="icon-btn" href="${esc(c.x)}" target="_blank" rel="noopener" aria-label="X"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2H22l-7.4 8.5L23 22h-6.8l-5.3-6.9L4.8 22H1.7l7.9-9.1L1 2h7l4.8 6.3zm-1.2 18h1.9L7.4 4H5.4z"/></svg></a>`);
  if (c.ca) { tr.insertAdjacentHTML('afterbegin', `<span class="ca">CA <b class="mono">${short(c.ca)}</b><button id="caCopy">COPY</button></span>`); $('#caCopy').onclick = () => copy(c.ca, 'Contract address copied') }
  $('#wbtn').onclick = () => WAL.pk ? (confirm('Disconnect ' + short(WAL.pk.toBase58()) + '?') && disconnect()) : connect().then(route).catch(() => {});
  const rl = $('#refLink'); rl.href = solscan(REF.toBase58()); rl.textContent = REF.toBase58() + ' ↗';
}

/* ---------- debug: simulate a trade between any two wallets (no signatures) ---------- */
window.__stokzSim = async (mint, seller, buyer, uiAmount, sol) => {
  const mi = await mintInfo(mint); const bag = await bagOf(seller, mint); if (!bag) return 'seller has no bag';
  const raw = BigInt(Math.round(uiAmount * 10 ** Math.min(mi.decimals, 9))) * 10n ** BigInt(Math.max(0, mi.decimals - 9));
  const tx = buildTrade({ maker: new PublicKey(buyer), seller: new PublicKey(seller), buyer: new PublicKey(buyer), src: new PublicKey(bag.account), mint: new PublicKey(mint), prog: mi.program, dec: mi.decimals, raw, lamports: Math.round(sol * 1e9) });
  tx.recentBlockhash = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const r = await rpc('simulateTransaction', [toB64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }]);
  return { err: r.value.err, logs: r.value.logs, units: r.value.unitsConsumed, program: mi.program.toBase58(), size: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length };
};
window.__stokz = { parseOffer, buildTrade, b64url, fromB64url, S };

/* ---------- boot ---------- */
async function boot() {
  intro(); topbar(); heroChart(); reveals();
  window.addEventListener('hashchange', route); route();
  $$('#impSize button').forEach(b => b.onclick = () => { $$('#impSize button').forEach(x => x.classList.toggle('on', x === b)); paintImpact() });
  $$('.tools .chip').forEach(b => b.onclick = () => { $$('.tools .chip').forEach(x => x.classList.toggle('on', x === b)); S.sort = b.dataset.sort; S.shown = 18; paintGrid() });
  $('#moreBtn').onclick = () => { S.shown += 18; paintGrid() };
  let qt; $('#q').oninput = e => { S.q = e.target.value; S.shown = 18; paintGrid(); clearTimeout(qt); const v = S.q.trim(); if (v.length >= 32) qt = setTimeout(async () => { const s = await stockByMint(v).catch(() => null); if (s) paintGrid() }, 300) };
  const last = (() => { try { return localStorage.getItem('stokz.w') } catch { return null } })();
  if (last) { const w = providers().find(p => p[0] === last); if (w) w[1].connect({ onlyIfTrusted: true }).then(r => { const k = (r && r.publicKey) || w[1].publicKey; if (k) { WAL.pk = new PublicKey(k.toString()); WAL.p = w[1]; WAL.name = w[0]; paintWallet(); if (location.hash.startsWith('#/')) route() } }).catch(() => {}) }
  try { await loadStocks() } catch (e) { $('#grid').innerHTML = `<div class="empty" style="grid-column:1/-1">StonkFun didn't answer (${esc(e.message)}). Refresh in a moment.</div>`; $('#hcard').innerHTML = '<div class="h"><div><b>StonkFun is not answering right now</b><small>Refresh in a moment</small></div></div>'; return }
  heroStock = [...S.map.values()].filter(s => s.liq > 0 && s.img).sort((a, b) => (b.mcap || 0) - (a.mcap || 0))[0] || [...S.map.values()][0];
  paintHeroCard(); paintBand(); paintImpact(); paintGrid(); paintFills();
  loadFills();
  setInterval(async () => { try { const fresh = await sfList('marketCap', 60); for (const s of fresh) { const o = S.map.get(s.mint); if (o) Object.assign(o, { price: s.price, mcap: s.mcap, vol: s.vol, chg: s.chg, liq: s.liq || o.liq }) } paintBand(); paintImpact(); paintHeroCard(); if (!S.q) paintGrid() } catch {} }, 60000);
}
boot();
})();
