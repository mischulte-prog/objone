/**
 * Proxy Manager - CloudClusters Compatible Edition
 * =====================================================================
 * Dirancang untuk CloudClusters Node.js hosting (free tier):
 *   - PORT 8080 (sesuai template CloudClusters)
 *   - Tidak butuh `npm install` (node_modules sudah pre-packaged)
 *   - Tidak butuh shell access (semua konfigurasi via env var di control panel)
 *   - Database: JSON file storage (tanpa native module)
 *
 * Konfigurasi via Environment Variables (set di CloudClusters control panel):
 *   - ADMIN_USERNAME (default: TatangS)
 *   - ADMIN_PASSWORD (default: LuntangLantungLantang89)
 *   - SESSION_SECRET (default: CHANGE_ME_...)
 *   - DB_FILE (default: ./data/proxies.json)
 *
 * Cara deploy:
 *   1. Upload zip via CloudClusters file manager
 *   2. Extract (jika perlu)
 *   3. Set env vars di control panel (Settings → Environment Variables)
 *   4. Restart aplikasi
 *   5. Akses via URL yang diberikan CloudClusters
 */

'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');
const { parseProxyContent, formatProxyString } = require('./proxy-parser');
const { testProxy } = require('./proxy-tester');
const {
  listProxies, getProxy, createProxy, updateProxy, deleteProxy, deleteProxies, getStats, findDuplicate,
  listApiKeys, findApiKey, createApiKey, deleteApiKey, toggleApiKey, markApiKeyUsed,
  listAdsterraSafeProxies, listAdsterraSafeProxiesByRange, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE,
} = require('./database');

// ============================================================
// Configuration (via env vars — set in CloudClusters control panel)
// ============================================================
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'TatangS';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'LuntangLantungLantang89';
const SESSION_SECRET = process.env.SESSION_SECRET || 'proxy-manager-change-this-secret-2026';

// ============================================================
// External API access — ADSTERRA SAFE proxies untuk Python app
// ============================================================
const HARDCODED_API_KEY = process.env.EXTERNAL_API_KEY || '';
const EXTERNAL_API_MAX_PER_PAGE = Math.min(1000, Math.max(10, parseInt(process.env.EXTERNAL_API_MAX_PER_PAGE || '500', 10)));
// Batas maksimum proxy yang dapat diuji dalam satu batch test (default 50 untuk hindari timeout)
const MAX_BATCH_TEST = Math.min(500, Math.max(1, parseInt(process.env.MAX_BATCH_TEST || '50', 10)));
// Timeout per-proxy dalam ms — jika proxy lambat, batch test akan memakan waktu
// Rumus estimasi total: (count / concurrency) * per-proxy-timeout + buffer
const BATCH_PER_PROXY_TIMEOUT_MS = Math.min(60000, Math.max(5000, parseInt(process.env.BATCH_PER_PROXY_TIMEOUT_MS || '12000', 10)));
// Buffer tambahan untuk HTTP timeout (overhead network, dsb.)
const BATCH_HTTP_TIMEOUT_BUFFER_MS = parseInt(process.env.BATCH_HTTP_TIMEOUT_BUFFER_MS || '10000', 10);

/**
 * Hitung estimasi total waktu yang dibutuhkan untuk batch test.
 * Digunakan frontend untuk set HTTP timeout yang sesuai.
 * @param {number} count - jumlah proxy yang akan diuji
 * @param {number} concurrency - jumlah concurrent test
 * @returns {number} estimasi total ms
 */
function estimateBatchTestDurationMs(count, concurrency) {
  const conc = Math.max(1, Math.min(12, concurrency || 8));
  const batches = Math.ceil(count / conc);
  return (batches * BATCH_PER_PROXY_TIMEOUT_MS) + BATCH_HTTP_TIMEOUT_BUFFER_MS;
}

// ============================================================
// Auth helpers (inline — no separate auth.js needed)
// ============================================================
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

function createSessionToken(username) {
  const payload = Buffer.from(username).toString('base64url');
  return `${payload}.${sign(username)}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const username = Buffer.from(parts[0], 'base64url').toString('utf8');
    if (sign(username) !== parts[1]) return null;
    return username;
  } catch { return null; }
}

function verifyCredentials(username, password) {
  return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.proxy_session;
  const user = verifySessionToken(token);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Tidak terautentikasi' });
  }
  req.user = user;
  next();
}

// ============================================================
// API Key auth (untuk akses eksternal — Python app)
// ============================================================
function extractApiKey(req) {
  const h = req.headers || {};
  if (h['x-api-key']) return String(h['x-api-key']).trim();
  const auth = h['authorization'] || h['Authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  if (req.query && req.query.api_key) return String(req.query.api_key).trim();
  return null;
}

function requireApiKey(req, res, next) {
  const rawKey = extractApiKey(req);
  if (!rawKey) {
    return res.status(401).json({
      success: false,
      error: 'API Key wajib diisi. Kirim via header X-API-Key atau Authorization: Bearer <key>.',
    });
  }
  if (HARDCODED_API_KEY && rawKey === HARDCODED_API_KEY) {
    req.apiKey = { id: 'env', name: 'env-key', scope: 'adsterra_safe', active: true };
    return next();
  }
  const k = findApiKey(rawKey);
  if (!k) {
    return res.status(401).json({ success: false, error: 'API Key tidak valid atau nonaktif' });
  }
  if (k.scope !== 'adsterra_safe') {
    return res.status(403).json({ success: false, error: 'API Key tidak memiliki scope adsterra_safe' });
  }
  req.apiKey = k;
  try { markApiKeyUsed(rawKey); } catch (e) { console.error('markApiKeyUsed error:', e); }
  next();
}

// ============================================================
// Express app
// ============================================================
const app = express();

// Middleware
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Static files
app.use(express.static(__dirname, {
  index: 'index.html',
  extensions: ['html'],
}));

// ============================================================
// Auth routes
// ============================================================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username dan password wajib diisi' });
  }
  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ success: false, error: 'Username atau password salah' });
  }
  res.cookie('proxy_session', createSessionToken(username), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ success: true, user: { username } });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('proxy_session', { path: '/' });
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies && req.cookies.proxy_session;
  const user = verifySessionToken(token);
  if (!user) return res.status(401).json({ success: false, authenticated: false });
  res.json({ success: true, authenticated: true, user: { username: user } });
});

// ============================================================
// Proxy CRUD
// ============================================================
app.get('/api/proxies', requireAuth, (req, res) => {
  try {
    const result = listProxies({
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search,
      protocol: req.query.protocol,
      status: req.query.status,
      country: req.query.country,
      adsterraSafe: req.query.adsterraSafe,
      blacklisted: req.query.blacklisted,
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
    });
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (e) {
    console.error('GET /api/proxies error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/proxies/stats', requireAuth, (req, res) => {
  try {
    res.json({ success: true, data: getStats() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/proxies/:id', requireAuth, (req, res) => {
  try {
    const proxy = getProxy(req.params.id);
    if (!proxy) return res.status(404).json({ success: false, error: 'Proxy tidak ditemukan' });
    res.json({ success: true, data: proxy });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/proxies', requireAuth, (req, res) => {
  try {
    const p = req.body.proxy || req.body;
    if (!p.host || !p.port) return res.status(400).json({ success: false, error: 'host dan port wajib diisi' });
    const port = Number(p.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ success: false, error: 'port tidak valid' });
    const validProtocols = ['http', 'https', 'socks4', 'socks5'];
    const protocol = validProtocols.includes(p.protocol) ? p.protocol : 'http';
    try {
      const created = createProxy({
        protocol, host: String(p.host), port,
        username: p.username || null, password: p.password || null,
        country: p.country ? String(p.country).toUpperCase() : null,
        source: p.source || 'manual', status: p.status || 'untested',
        note: p.note || null,
      });
      res.status(201).json({ success: true, data: created });
    } catch (e) {
      if (e.code === 'DUPLICATE') return res.status(409).json({ success: false, error: e.message, duplicate: e.duplicate });
      throw e;
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/proxies/:id', requireAuth, (req, res) => {
  try {
    const existing = getProxy(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Proxy tidak ditemukan' });
    const p = req.body.proxy || req.body;
    const data = {};
    const validProtocols = ['http', 'https', 'socks4', 'socks5'];
    const validStatuses = ['active', 'inactive', 'dead', 'untested'];
    if (p.protocol !== undefined) {
      if (!validProtocols.includes(p.protocol)) return res.status(400).json({ success: false, error: 'Protocol tidak valid' });
      data.protocol = p.protocol;
    }
    if (p.host !== undefined) data.host = String(p.host);
    if (p.port !== undefined) {
      const port = Number(p.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ success: false, error: 'Port tidak valid' });
      data.port = port;
    }
    if (p.username !== undefined) data.username = p.username || null;
    if (p.password !== undefined) data.password = p.password || null;
    if (p.country !== undefined) data.country = p.country ? String(p.country).toUpperCase() : null;
    if (p.source !== undefined) data.source = p.source || null;
    if (p.status !== undefined) {
      if (!validStatuses.includes(p.status)) return res.status(400).json({ success: false, error: 'Status tidak valid' });
      data.status = p.status;
    }
    if (p.note !== undefined) data.note = p.note || null;
    if (p.latencyMs !== undefined) data.latencyMs = p.latencyMs ? Number(p.latencyMs) : null;
    if (p.lastCheck !== undefined) data.lastCheck = p.lastCheck || null;
    if (p.exitIp !== undefined) data.exitIp = p.exitIp || null;
    if (p.exitCountry !== undefined) data.exitCountry = p.exitCountry || null;
    if (p.exitCity !== undefined) data.exitCity = p.exitCity || null;
    if (p.exitIsp !== undefined) data.exitIsp = p.exitIsp || null;
    if (p.anonymity !== undefined) data.anonymity = p.anonymity || null;
    if (p.dnsLeak !== undefined) data.dnsLeak = p.dnsLeak;
    if (p.dnsServer !== undefined) data.dnsServer = p.dnsServer || null;
    if (p.webRtcLeak !== undefined) data.webRtcLeak = p.webRtcLeak;
    if (p.blacklisted !== undefined) data.blacklisted = p.blacklisted;
    if (p.blacklistSources !== undefined) data.blacklistSources = p.blacklistSources || null;
    if (p.adsterraSafe !== undefined) data.adsterraSafe = p.adsterraSafe || null;
    if (p.qualityScore !== undefined) data.qualityScore = p.qualityScore != null ? Number(p.qualityScore) : null;
    if (p.testResultJson !== undefined) data.testResultJson = p.testResultJson || null;
    if (p.testError !== undefined) data.testError = p.testError || null;
    res.json({ success: true, data: updateProxy(req.params.id, data) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/proxies/:id', requireAuth, (req, res) => {
  try {
    const ok = deleteProxy(req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: 'Proxy tidak ditemukan' });
    res.json({ success: true, deleted: 1 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/proxies', requireAuth, (req, res) => {
  try {
    const { ids, all, filter } = req.body || {};
    res.json({ success: true, deleted: deleteProxies({ ids, all, filter }) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// Import / Preview
// ============================================================
app.post('/api/proxies/preview', requireAuth, (req, res) => {
  try {
    const content = String((req.body || {}).content || '');
    const fileName = (req.body || {}).fileName || 'preview';
    if (!content.trim()) return res.status(400).json({ success: false, error: 'Konten kosong' });
    const { proxies, errors } = parseProxyContent(content, fileName);
    res.json({ success: true, proxies, errors, count: proxies.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/proxies/import', requireAuth, (req, res) => {
  try {
    const body = req.body || {};
    const content = String(body.content || '');
    const fileName = body.fileName || 'manual-input';
    const dedupe = body.dedupe !== false;
    if (!content.trim()) return res.status(400).json({ success: false, error: 'Konten file kosong' });

    const { proxies, errors } = parseProxyContent(content, fileName);
    if (proxies.length === 0) return res.status(400).json({ success: false, error: 'Tidak ada proxy valid', parseErrors: errors });

    let toInsert = proxies;
    if (dedupe) {
      const seen = new Set();
      toInsert = [];
      for (const p of proxies) {
        const key = `${p.protocol}|${p.host}|${p.port}|${p.username || ''}|${p.password || ''}`;
        if (!seen.has(key)) { seen.add(key); toInsert.push(p); }
      }
    }

    let inserted = 0, skipped = 0;
    const insertErrors = [];
    for (const p of toInsert) {
      const existing = findDuplicate(p.protocol, p.host, p.port, p.username, p.password);
      if (existing) { skipped++; continue; }
      try {
        createProxy({
          protocol: p.protocol, host: p.host, port: p.port,
          username: p.username || null, password: p.password || null,
          country: p.country || null, source: p.source || fileName,
          status: 'untested', note: p.note || null,
        });
        inserted++;
      } catch (e) {
        if (insertErrors.length < 20) insertErrors.push({ proxy: p, reason: e.message });
        skipped++;
      }
    }

    res.json({
      success: true,
      totalParsed: proxies.length,
      duplicatesRemoved: proxies.length - toInsert.length,
      inserted, skippedExisting: skipped,
      errors: [...errors.map((e) => ({ ...e, type: 'parse' })), ...insertErrors.map((e) => ({ ...e, type: 'insert' }))],
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// Proxy testing
// ============================================================
app.post('/api/proxies/:id/test', requireAuth, async (req, res) => {
  try {
    const proxy = getProxy(req.params.id);
    if (!proxy) return res.status(404).json({ success: false, error: 'Proxy tidak ditemukan' });

    const result = await testProxy({
      protocol: proxy.protocol, host: proxy.host, port: proxy.port,
      username: proxy.username || undefined, password: proxy.password || undefined,
    });

    const updated = updateProxy(req.params.id, {
      status: result.ok ? 'active' : 'dead',
      latencyMs: result.ok ? result.latencyMs : null,
      lastCheck: new Date().toISOString(),
      exitIp: result.exitIp, exitCountry: result.exitCountry,
      exitCity: result.exitCity, exitIsp: result.exitIsp,
      anonymity: result.anonymity, dnsLeak: result.dnsLeak,
      dnsServer: result.dnsServer, webRtcLeak: result.webRtcLeak,
      blacklisted: result.blacklisted,
      blacklistSources: result.blacklistSources.length > 0 ? JSON.stringify(result.blacklistSources) : null,
      adsterraSafe: result.adsterraSafe, qualityScore: result.qualityScore,
      testResultJson: JSON.stringify(result.raw), testError: result.error,
    });

    res.json({ success: true, data: updated, testResult: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/proxies/test-batch', requireAuth, async (req, res) => {
  const startedAt = Date.now();
  try {
    const body = req.body || {};
    const { ids, concurrency = 8, filter } = body;

    let proxies = [];
    if (Array.isArray(ids) && ids.length > 0) {
      const result = listProxies({ page: 1, pageSize: 1000 });
      proxies = result.items.filter((p) => ids.includes(p.id));
    } else if (filter) {
      const result = listProxies({
        page: 1, pageSize: 1000,
        protocol: filter.protocol, status: filter.status,
        country: filter.country, adsterraSafe: filter.adsterraSafe,
        search: filter.search,
      });
      proxies = result.items;
    } else {
      return res.status(400).json({ success: false, error: "Berikan 'ids' atau 'filter'" });
    }

    if (proxies.length === 0) return res.status(404).json({ success: false, error: 'Tidak ada proxy yang cocok' });

    const MAX_BATCH = MAX_BATCH_TEST;
    const toTest = proxies.slice(0, MAX_BATCH);
    const skipped = proxies.length - toTest.length;
    const conc = Math.max(1, Math.min(12, concurrency));
    const results = [];

    for (let i = 0; i < toTest.length; i += conc) {
      const chunk = toTest.slice(i, i + conc);
      const chunkResults = await Promise.allSettled(chunk.map(async (p) => {
        const r = await testProxy({
          protocol: p.protocol, host: p.host, port: p.port,
          username: p.username || undefined, password: p.password || undefined,
        });
        try {
          updateProxy(p.id, {
            status: r.ok ? 'active' : 'dead',
            latencyMs: r.ok ? r.latencyMs : null,
            lastCheck: new Date().toISOString(),
            exitIp: r.exitIp, exitCountry: r.exitCountry,
            exitCity: r.exitCity, exitIsp: r.exitIsp,
            anonymity: r.anonymity, dnsLeak: r.dnsLeak,
            dnsServer: r.dnsServer, webRtcLeak: r.webRtcLeak,
            blacklisted: r.blacklisted,
            blacklistSources: r.blacklistSources.length > 0 ? JSON.stringify(r.blacklistSources) : null,
            adsterraSafe: r.adsterraSafe, qualityScore: r.qualityScore,
            testResultJson: JSON.stringify(r.raw), testError: r.error,
          });
        } catch (e) { console.error('Persist test result failed:', p.id, e); }
        return {
          id: p.id, host: p.host, port: p.port,
          ok: r.ok, error: r.error, latencyMs: r.latencyMs,
          exitIp: r.exitIp, exitCountry: r.exitCountry,
          anonymity: r.anonymity, blacklisted: r.blacklisted,
          adsterraSafe: r.adsterraSafe, qualityScore: r.qualityScore,
        };
      }));

      chunkResults.forEach((r, idx) => {
        const p = chunk[idx];
        if (r.status === 'fulfilled') {
          results.push(r.value);
        } else {
          const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          results.push({
            id: p.id, host: p.host, port: p.port,
            ok: false, error: errMsg, latencyMs: 0,
            exitIp: null, exitCountry: null, anonymity: 'unknown',
            blacklisted: null, adsterraSafe: 'unknown', qualityScore: 0,
          });
        }
      });
    }

    const summary = {
      total: proxies.length, tested: toTest.length, skipped,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      safe: results.filter((r) => r.adsterraSafe === 'safe').length,
      risky: results.filter((r) => r.adsterraSafe === 'risky').length,
      unsafe: results.filter((r) => r.adsterraSafe === 'unsafe').length,
      durationMs: Date.now() - startedAt,
      maxBatchLimit: MAX_BATCH,
      concurrency: conc,
      perProxyTimeoutMs: BATCH_PER_PROXY_TIMEOUT_MS,
      estimatedDurationMs: estimateBatchTestDurationMs(toTest.length, conc),
    };

    res.json({ success: true, summary, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, durationMs: Date.now() - startedAt });
  }
});

// ============================================================
// API Keys management (admin only)
// ============================================================
app.get('/api/apikeys', requireAuth, (req, res) => {
  try {
    const items = listApiKeys().map((k) => ({
      ...k,
      keyMasked: k.key.slice(0, 7) + '••••••••••••••••' + k.key.slice(-4),
      key: undefined,
    }));
    res.json({ success: true, data: items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/apikeys', requireAuth, (req, res) => {
  try {
    const { name, scope = 'adsterra_safe', note } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'name wajib diisi' });
    }
    if (scope !== 'adsterra_safe') {
      return res.status(400).json({ success: false, error: 'scope saat ini hanya mendukung: adsterra_safe' });
    }
    const created = createApiKey({ name: String(name).trim(), scope, note: note || null });
    res.status(201).json({ success: true, data: created, warning: 'Simpan key ini baik-baik. Key tidak akan ditampilkan lengkap lagi.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/apikeys/:id', requireAuth, (req, res) => {
  try {
    const ok = deleteApiKey(req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: 'API Key tidak ditemukan' });
    res.json({ success: true, deleted: 1 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/apikeys/:id', requireAuth, (req, res) => {
  try {
    const { active } = req.body || {};
    if (active === undefined) return res.status(400).json({ success: false, error: 'active wajib diisi' });
    const updated = toggleApiKey(req.params.id, !!active);
    if (!updated) return res.status(404).json({ success: false, error: 'API Key tidak ditemukan' });
    res.json({ success: true, data: { ...updated, keyMasked: updated.key.slice(0, 7) + '••••••••••••••••' + updated.key.slice(-4), key: undefined } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// External API (untuk Python app) — proxy ADSTERRA SAFE
// ============================================================
function formatProxyLine(p) {
  let s = `${p.protocol}://`;
  if (p.username) {
    s += encodeURIComponent(p.username);
    if (p.password) s += ':' + encodeURIComponent(p.password);
    s += '@';
  }
  s += `${p.host}:${p.port}`;
  return s;
}

function escapeCsv(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/api/external/proxies/adsterra-safe', requireApiKey, (req, res) => {
  try {
    const format = String(req.query.format || 'json').toLowerCase();
    const page = req.query.page || 1;
    const pageSize = Math.min(EXTERNAL_API_MAX_PER_PAGE, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE);
    const protocol = req.query.protocol || '';
    const country = req.query.country || '';
    const minScore = req.query.minScore || 0;
    const sortBy = req.query.sortBy || 'qualityScore';
    const sortOrder = req.query.sortOrder || 'desc';

    const result = listAdsterraSafeProxies({
      page, pageSize, protocol, country, minScore, sortBy, sortOrder,
    });

    if (format === 'txt' || format === 'plain') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Total-Count', String(result.pagination.total));
      res.setHeader('X-Page', String(result.pagination.page));
      res.setHeader('X-Page-Size', String(result.pagination.pageSize));
      res.setHeader('X-Total-Pages', String(result.pagination.totalPages));
      return res.send(result.items.map(formatProxyLine).join('\n') + (result.items.length > 0 ? '\n' : ''));
    }

    if (format === 'csv') {
      const header = 'protocol,host,port,username,password,exitIp,exitCountry,qualityScore,latencyMs';
      const rows = result.items.map((p) => [
        p.protocol, p.host, p.port, p.username || '', p.password || '',
        p.exitIp || '', p.exitCountry || '',
        p.qualityScore != null ? p.qualityScore : '',
        p.latencyMs != null ? p.latencyMs : '',
      ].map(escapeCsv).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="adsterra-safe-proxies.csv"');
      res.setHeader('X-Total-Count', String(result.pagination.total));
      return res.send([header, ...rows].join('\n'));
    }

    if (format === 'jsonl') {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('X-Total-Count', String(result.pagination.total));
      return res.send(result.items.map((p) => JSON.stringify(p)).join('\n') + (result.items.length > 0 ? '\n' : ''));
    }

    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      filter: { protocol, country, minScore: Number(minScore) || 0, sortBy, sortOrder },
      format: 'json',
      apiKey: { id: req.apiKey.id, name: req.apiKey.name, scope: req.apiKey.scope },
    });
  } catch (e) {
    console.error('External API error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// External API — RANGE-based access (untuk Python app)
// ============================================================
// Endpoint ini memungkinkan Python app mengambil proxy berdasarkan RENTANG INDEX
// (1-based, inclusive) — alternatif yang lebih sederhana dari pagination.
//
// Contoh penggunaan:
//   GET /api/external/proxies/range/1-50          → proxy urutan 1 sampai 50
//   GET /api/external/proxies/range/51-100        → proxy urutan 51 sampai 100
//   GET /api/external/proxies/range/1-50?format=txt&minScore=70
//   GET /api/external/proxies/range/1-50?protocol=socks5&country=US
//
// Jika hanya "from" yang diberikan (mis. /range/1), default to = from + 49 (50 record).
// Format path: /range/:from-:to  atau  /range/:from
//
app.get('/api/external/proxies/range/:from', requireApiKey, (req, res) => {
  try {
    // Parse "from-to" atau "from" saja
    const pathParam = String(req.params.from || '1');
    let fromNum, toNum;
    if (pathParam.includes('-')) {
      const parts = pathParam.split('-');
      fromNum = parseInt(parts[0], 10);
      toNum = parseInt(parts[1], 10);
    } else {
      fromNum = parseInt(pathParam, 10);
      toNum = null; // akan default ke from + 49
    }

    if (!Number.isFinite(fromNum) || fromNum < 1) {
      return res.status(400).json({
        success: false,
        error: 'Parameter "from" tidak valid. Harus bilangan bulat positif (1-based).',
      });
    }
    if (toNum != null && (!Number.isFinite(toNum) || toNum < fromNum)) {
      return res.status(400).json({
        success: false,
        error: 'Parameter "to" tidak valid. Harus >= from.',
      });
    }

    const format = String(req.query.format || 'json').toLowerCase();
    const protocol = req.query.protocol || '';
    const country = req.query.country || '';
    const minScore = req.query.minScore || 0;
    const sortBy = req.query.sortBy || 'qualityScore';
    const sortOrder = req.query.sortOrder || 'desc';

    const result = listAdsterraSafeProxiesByRange({
      from: fromNum, to: toNum,
      protocol, country, minScore, sortBy, sortOrder,
    });

    if (format === 'txt' || format === 'plain') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Range-From', String(result.range.from));
      res.setHeader('X-Range-To', String(result.range.to));
      res.setHeader('X-Total-Count', String(result.range.total));
      res.setHeader('X-Returned', String(result.range.returned));
      res.setHeader('X-Has-More', result.range.hasMore ? '1' : '0');
      return res.send(result.items.map(formatProxyLine).join('\n') + (result.items.length > 0 ? '\n' : ''));
    }

    if (format === 'csv') {
      const header = 'protocol,host,port,username,password,exitIp,exitCountry,qualityScore,latencyMs';
      const rows = result.items.map((p) => [
        p.protocol, p.host, p.port, p.username || '', p.password || '',
        p.exitIp || '', p.exitCountry || '',
        p.qualityScore != null ? p.qualityScore : '',
        p.latencyMs != null ? p.latencyMs : '',
      ].map(escapeCsv).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="adsterra-safe-range-${result.range.from}-${result.range.to}.csv"`);
      res.setHeader('X-Total-Count', String(result.range.total));
      return res.send([header, ...rows].join('\n'));
    }

    if (format === 'jsonl') {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('X-Range-From', String(result.range.from));
      res.setHeader('X-Range-To', String(result.range.to));
      res.setHeader('X-Total-Count', String(result.range.total));
      res.setHeader('X-Has-More', result.range.hasMore ? '1' : '0');
      return res.send(result.items.map((p) => JSON.stringify(p)).join('\n') + (result.items.length > 0 ? '\n' : ''));
    }

    // Default: JSON
    res.json({
      success: true,
      data: result.items,
      range: result.range,
      filter: { protocol, country, minScore: Number(minScore) || 0, sortBy, sortOrder },
      format: 'json',
      apiKey: { id: req.apiKey.id, name: req.apiKey.name, scope: req.apiKey.scope },
    });
  } catch (e) {
    console.error('External Range API error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/external/whoami', requireApiKey, (req, res) => {
  res.json({
    success: true,
    data: {
      id: req.apiKey.id,
      name: req.apiKey.name,
      scope: req.apiKey.scope,
      active: true,
      serverTime: new Date().toISOString(),
    },
  });
});

app.get('/api/external/info', (req, res) => {
  res.json({
    success: true,
    data: {
      name: 'Proxy Manager — External API',
      version: '2.1',
      description: 'Akses proxy dengan kategori ADSTERRA SAFE untuk Python app',
      auth: {
        methods: ['X-API-Key header', 'Authorization: Bearer <key>', '?api_key=<key>'],
        scope: 'adsterra_safe',
      },
      endpoints: {
        list: 'GET /api/external/proxies/adsterra-safe',
        range: 'GET /api/external/proxies/range/:from-:to  (1-based, inclusive)',
        rangeExample: 'GET /api/external/proxies/range/1-50  → proxy urutan 1-50',
        whoami: 'GET /api/external/whoami',
      },
      formats: ['json', 'txt', 'csv', 'jsonl'],
      pagination: {
        defaultPageSize: DEFAULT_PAGE_SIZE,
        maxPageSize: EXTERNAL_API_MAX_PER_PAGE,
      },
      range: {
        description: 'Ambil proxy berdasarkan rentang index 1-based (alternatif pagination)',
        defaultRangeSize: 50,
        maxRangeSize: MAX_PAGE_SIZE,
        examples: [
          'GET /api/external/proxies/range/1-50',
          'GET /api/external/proxies/range/51-100',
          'GET /api/external/proxies/range/201',
        ],
      },
      batchTest: {
        maxBatchLimit: MAX_BATCH_TEST,
        perProxyTimeoutMs: BATCH_PER_PROXY_TIMEOUT_MS,
        httpTimeoutBufferMs: BATCH_HTTP_TIMEOUT_BUFFER_MS,
        note: 'Estimasi total waktu batch test = ceil(count/concurrency) * perProxyTimeout + buffer',
      },
    },
  });
});

// ============================================================
// SPA fallback
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// ============================================================
// Start server
// ============================================================
app.listen(PORT, HOST, () => {
  console.log('============================================================');
  console.log('  Proxy Manager (CloudClusters Edition) v2.1');
  console.log('============================================================');
  console.log(`  Port:           ${PORT}`);
  console.log(`  Host:           ${HOST}`);
  console.log(`  Node:           ${process.version}`);
  console.log(`  Admin:          ${ADMIN_USERNAME}`);
  console.log(`  Database:       ${process.env.DB_FILE || './data/proxies.json'}`);
  console.log(`  Page size:      default=${DEFAULT_PAGE_SIZE}, max=${MAX_PAGE_SIZE}`);
  console.log(`  Batch test:     max ${MAX_BATCH_TEST} per request (env: MAX_BATCH_TEST)`);
  console.log(`                  per-proxy timeout: ${BATCH_PER_PROXY_TIMEOUT_MS}ms (env: BATCH_PER_PROXY_TIMEOUT_MS)`);
  console.log(`  External API:   ${HARDCODED_API_KEY ? 'env-key ON' : 'database-managed keys'}`);
  console.log(`                  max per request: ${EXTERNAL_API_MAX_PER_PAGE}`);
  console.log('  External endpoints:');
  console.log('    GET /api/external/info                              (public, no auth)');
  console.log('    GET /api/external/whoami                            (API key required)');
  console.log('    GET /api/external/proxies/adsterra-safe             (API key required, pagination)');
  console.log('    GET /api/external/proxies/range/:from-:to          (API key required, range-based)');
  console.log('============================================================');
  console.log('');
  console.log(`  → http://${HOST}:${PORT}`);
  console.log('');
});
