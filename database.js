/**
 * Database helper — JSON file-based storage
 * =====================================================================
 * Dirancang untuk lingkungan tanpa akses shell (CloudClusters free tier).
 * Tidak menggunakan native module (better-sqlite3) yang butuh compilation.
 * Data disimpan dalam file JSON tunggal: data/proxies.json
 *
 * Trade-off: cocok untuk < 5000 proxy. Untuk beban lebih, gunakan MySQL.
 *
 * Upgrade v2.0:
 *   - Flexible pagination: pageSize dapat di-override via env var
 *     (DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
 *   - API Keys storage: simpan API Key untuk akses eksternal
 *     (scope: adsterra_safe) — dipakai oleh Python app
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'proxies.json');

// Batas maksimum page size — dapat di-override via env var
const MAX_PAGE_SIZE = Math.min(1000, Math.max(50, parseInt(process.env.MAX_PAGE_SIZE || '500', 10)));
const DEFAULT_PAGE_SIZE = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(process.env.DEFAULT_PAGE_SIZE || '20', 10)));

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

// In-memory cache
let db = { proxies: [], apiKeys: [], meta: { lastId: 0, lastApiKeyId: 0 } };
let writeTimer = null;

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.proxies)) {
        db = parsed;
        // Migrasi: pastikan field apiKeys & meta terisi
        if (!Array.isArray(db.apiKeys)) db.apiKeys = [];
        if (!db.meta) db.meta = { lastId: 0, lastApiKeyId: 0 };
        if (db.meta.lastApiKeyId == null) db.meta.lastApiKeyId = 0;
      }
    }
  } catch (e) {
    console.error('DB load error:', e.message);
  }
}

function saveDbImmediate() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('DB save error:', e.message);
  }
}

function saveDb() {
  // Debounce writes to avoid excessive I/O
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    saveDbImmediate();
    writeTimer = null;
  }, 100);
}

// Load on startup
loadDb();

// ============================================================
// Helpers
// ============================================================
function genId() {
  db.meta.lastId = (db.meta.lastId || 0) + 1;
  return 'p' + db.meta.lastId;
}

function now() {
  return new Date().toISOString();
}

function normalizeProxy(p) {
  return {
    id: p.id,
    protocol: p.protocol || 'http',
    host: p.host,
    port: p.port,
    username: p.username || null,
    password: p.password || null,
    country: p.country || null,
    source: p.source || null,
    status: p.status || 'untested',
    note: p.note || null,
    latencyMs: p.latencyMs != null ? p.latencyMs : null,
    lastCheck: p.lastCheck || null,
    exitIp: p.exitIp || null,
    exitCountry: p.exitCountry || null,
    exitCity: p.exitCity || null,
    exitIsp: p.exitIsp || null,
    anonymity: p.anonymity || null,
    dnsLeak: p.dnsLeak == null ? null : !!p.dnsLeak,
    dnsServer: p.dnsServer || null,
    webRtcLeak: p.webRtcLeak == null ? null : !!p.webRtcLeak,
    blacklisted: p.blacklisted == null ? null : !!p.blacklisted,
    blacklistSources: p.blacklistSources || null,
    adsterraSafe: p.adsterraSafe || null,
    qualityScore: p.qualityScore != null ? p.qualityScore : null,
    testResultJson: p.testResultJson || null,
    testError: p.testError || null,
    createdAt: p.createdAt || now(),
    updatedAt: p.updatedAt || now(),
  };
}

function findDuplicate(protocol, host, port, username, password) {
  return db.proxies.find((p) =>
    p.protocol === protocol &&
    p.host === host &&
    p.port === port &&
    (p.username || '') === (username || '') &&
    (p.password || '') === (password || '')
  );
}

// ============================================================
// CRUD
// ============================================================
function listProxies(opts) {
  const {
    page = 1, pageSize = DEFAULT_PAGE_SIZE,
    search = '', protocol = '', status = '', country = '',
    adsterraSafe = '', blacklisted = '',
    sortBy = 'createdAt', sortOrder = 'desc',
  } = opts || {};

  const p = Math.max(1, parseInt(page, 10) || 1);
  // Flexible page size: minimum 1, maximum MAX_PAGE_SIZE (default 500)
  const requestedPs = parseInt(pageSize, 10);
  const ps = Number.isFinite(requestedPs) && requestedPs > 0
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPs))
    : DEFAULT_PAGE_SIZE;
  const offset = (p - 1) * ps;

  let filtered = db.proxies.slice();

  if (protocol) filtered = filtered.filter((x) => x.protocol === protocol);
  if (status) filtered = filtered.filter((x) => x.status === status);
  if (country) filtered = filtered.filter((x) => (x.country || '').toUpperCase() === country.toUpperCase());
  if (adsterraSafe) filtered = filtered.filter((x) => x.adsterraSafe === adsterraSafe);
  if (blacklisted === 'true') filtered = filtered.filter((x) => x.blacklisted === true);
  if (blacklisted === 'false') filtered = filtered.filter((x) => x.blacklisted === false);
  if (search) {
    const s = search.toLowerCase();
    const portNum = parseInt(search, 10);
    filtered = filtered.filter((x) =>
      (x.host || '').toLowerCase().includes(s) ||
      (x.username || '').toLowerCase().includes(s) ||
      (x.source || '').toLowerCase().includes(s) ||
      (x.note || '').toLowerCase().includes(s) ||
      (!isNaN(portNum) && x.port === portNum)
    );
  }

  // Sort
  const allowedSort = ['createdAt', 'updatedAt', 'host', 'port', 'protocol', 'status', 'country', 'latencyMs', 'qualityScore', 'adsterraSafe', 'blacklisted', 'lastCheck'];
  const sortField = allowedSort.includes(sortBy) ? sortBy : 'createdAt';
  const order = sortOrder === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -order;
    if (av > bv) return order;
    return 0;
  });

  const total = filtered.length;
  const items = filtered.slice(offset, offset + ps).map(normalizeProxy);

  return {
    items,
    pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) },
  };
}

function getProxy(id) {
  const p = db.proxies.find((x) => x.id === id);
  return p ? normalizeProxy(p) : null;
}

function createProxy(p) {
  const existing = findDuplicate(p.protocol, p.host, p.port, p.username, p.password);
  if (existing) {
    const err = new Error('Proxy dengan kombinasi yang sama sudah ada');
    err.code = 'DUPLICATE';
    err.duplicate = normalizeProxy(existing);
    throw err;
  }
  const newProxy = normalizeProxy({
    id: genId(),
    protocol: p.protocol || 'http',
    host: p.host,
    port: p.port,
    username: p.username || null,
    password: p.password || null,
    country: p.country || null,
    source: p.source || null,
    status: p.status || 'untested',
    note: p.note || null,
    createdAt: now(),
    updatedAt: now(),
  });
  db.proxies.push(newProxy);
  saveDb();
  return normalizeProxy(newProxy);
}

function updateProxy(id, data) {
  const idx = db.proxies.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  const existing = db.proxies[idx];
  const updated = { ...existing, ...data, id: existing.id, updatedAt: now() };
  db.proxies[idx] = updated;
  saveDb();
  return normalizeProxy(updated);
}

function deleteProxy(id) {
  const idx = db.proxies.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  db.proxies.splice(idx, 1);
  saveDb();
  return true;
}

function deleteProxies(opts) {
  const { ids, all, filter } = opts || {};
  if (all) {
    const count = db.proxies.length;
    db.proxies = [];
    saveDb();
    return count;
  }
  if (Array.isArray(ids) && ids.length > 0) {
    const idSet = new Set(ids);
    const before = db.proxies.length;
    db.proxies = db.proxies.filter((x) => !idSet.has(x.id));
    const after = db.proxies.length;
    saveDb();
    return before - after;
  }
  if (filter) {
    let toDelete = db.proxies.slice();
    if (filter.protocol) toDelete = toDelete.filter((x) => x.protocol === filter.protocol);
    if (filter.status) toDelete = toDelete.filter((x) => x.status === filter.status);
    if (filter.country) toDelete = toDelete.filter((x) => (x.country || '').toUpperCase() === String(filter.country).toUpperCase());
    if (filter.adsterraSafe) toDelete = toDelete.filter((x) => x.adsterraSafe === filter.adsterraSafe);
    if (filter.search) {
      const s = filter.search.toLowerCase();
      toDelete = toDelete.filter((x) =>
        (x.host || '').toLowerCase().includes(s) ||
        (x.username || '').toLowerCase().includes(s) ||
        (x.source || '').toLowerCase().includes(s)
      );
    }
    const deleteIds = new Set(toDelete.map((x) => x.id));
    const before = db.proxies.length;
    db.proxies = db.proxies.filter((x) => !deleteIds.has(x.id));
    const after = db.proxies.length;
    saveDb();
    return before - after;
  }
  return 0;
}

function getStats() {
  const proxies = db.proxies;
  const total = proxies.length;

  const byProtocol = {};
  const byStatus = {};
  const byAdsterra = {};
  const byAnonymity = {};
  const countryMap = {};
  const sourceMap = {};

  let blacklistedCount = 0, cleanCount = 0, testedCount = 0, untestedCount = 0;

  for (const p of proxies) {
    byProtocol[p.protocol] = (byProtocol[p.protocol] || 0) + 1;
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    const aKey = p.adsterraSafe || 'unknown';
    byAdsterra[aKey] = (byAdsterra[aKey] || 0) + 1;
    const nKey = p.anonymity || 'unknown';
    byAnonymity[nKey] = (byAnonymity[nKey] || 0) + 1;
    if (p.country) countryMap[p.country] = (countryMap[p.country] || 0) + 1;
    const src = p.source || 'unknown';
    sourceMap[src] = (sourceMap[src] || 0) + 1;
    if (p.blacklisted === true) blacklistedCount++;
    if (p.blacklisted === false) cleanCount++;
    if (p.lastCheck) testedCount++; else untestedCount++;
  }

  const byCountry = Object.entries(countryMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([country, count]) => ({ country, count }));

  const bySource = Object.entries(sourceMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source, count]) => ({ source, count }));

  return {
    total, byProtocol, byStatus, byCountry, bySource,
    byAdsterra, byAnonymity,
    blacklistedCount, cleanCount, testedCount, untestedCount,
  };
}

// ============================================================
// API Keys (untuk akses eksternal — kategori ADSTERRA SAFE)
// ============================================================
function genApiKey() {
  return 'pm_' + crypto.randomBytes(16).toString('hex');
}

function genApiKeyId() {
  db.meta.lastApiKeyId = (db.meta.lastApiKeyId || 0) + 1;
  return 'k' + db.meta.lastApiKeyId;
}

function normalizeApiKey(k) {
  return {
    id: k.id,
    name: k.name || 'Unnamed',
    key: k.key,
    scope: k.scope || 'adsterra_safe',
    active: k.active !== false,
    createdAt: k.createdAt || now(),
    lastUsedAt: k.lastUsedAt || null,
    useCount: k.useCount || 0,
    note: k.note || null,
  };
}

function listApiKeys() {
  return (db.apiKeys || []).map(normalizeApiKey);
}

function findApiKey(rawKey) {
  if (!rawKey) return null;
  return (db.apiKeys || []).find((k) => k.key === rawKey && k.active !== false) || null;
}

function createApiKey({ name, scope = 'adsterra_safe', note = null }) {
  const rec = normalizeApiKey({
    id: genApiKeyId(),
    name: name || 'API Key',
    key: genApiKey(),
    scope,
    active: true,
    createdAt: now(),
    lastUsedAt: null,
    useCount: 0,
    note,
  });
  if (!Array.isArray(db.apiKeys)) db.apiKeys = [];
  db.apiKeys.push(rec);
  saveDb();
  return normalizeApiKey(rec);
}

function deleteApiKey(id) {
  if (!Array.isArray(db.apiKeys)) return false;
  const idx = db.apiKeys.findIndex((k) => k.id === id);
  if (idx < 0) return false;
  db.apiKeys.splice(idx, 1);
  saveDb();
  return true;
}

function toggleApiKey(id, active) {
  if (!Array.isArray(db.apiKeys)) return null;
  const k = db.apiKeys.find((x) => x.id === id);
  if (!k) return null;
  k.active = !!active;
  saveDb();
  return normalizeApiKey(k);
}

function markApiKeyUsed(rawKey) {
  if (!Array.isArray(db.apiKeys)) return;
  const k = db.apiKeys.find((x) => x.key === rawKey);
  if (!k) return;
  k.lastUsedAt = now();
  k.useCount = (k.useCount || 0) + 1;
  saveDb();
}

function listAdsterraSafeProxies(opts) {
  const {
    page = 1, pageSize = DEFAULT_PAGE_SIZE,
    protocol = '', country = '',
    minScore = 0, format = 'json',
    sortBy = 'qualityScore', sortOrder = 'desc',
  } = opts || {};

  const p = Math.max(1, parseInt(page, 10) || 1);
  const requestedPs = parseInt(pageSize, 10);
  const ps = Number.isFinite(requestedPs) && requestedPs > 0
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPs))
    : DEFAULT_PAGE_SIZE;
  const offset = (p - 1) * ps;
  const minScoreNum = Math.max(0, Math.min(100, parseInt(minScore, 10) || 0));

  let filtered = (db.proxies || []).filter((x) =>
    x.adsterraSafe === 'safe' &&
    x.status === 'active' &&
    (x.qualityScore == null || x.qualityScore >= minScoreNum)
  );

  if (protocol) filtered = filtered.filter((x) => x.protocol === protocol);
  if (country) filtered = filtered.filter((x) => (x.country || '').toUpperCase() === String(country).toUpperCase());

  const allowedSort = ['qualityScore', 'latencyMs', 'createdAt', 'updatedAt', 'lastCheck', 'exitCountry'];
  const sortField = allowedSort.includes(sortBy) ? sortBy : 'qualityScore';
  const order = sortOrder === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -order;
    if (av > bv) return order;
    return 0;
  });

  const total = filtered.length;
  const items = filtered.slice(offset, offset + ps).map(normalizeProxy);

  return {
    items,
    pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) },
  };
}

/**
 * Ambil proxy aman untuk Adsterra berdasarkan RENTANG INDEX (1-based).
 * Contoh: from=1, to=50 → ambil 50 proxy pertama (index 1-50).
 *         from=51, to=100 → ambil proxy urutan 51-100.
 *
 * Berguna untuk Python app yang ingin fetch proxy berkelompok
 * tanpa harus pusing dengan pagination page/pageSize.
 *
 * @param {Object} opts
 *   - from: index mulai (1-based, default 1)
 *   - to:   index akhir (1-based, inclusive, default = from + 49)
 *   - protocol, country, minScore, sortBy, sortOrder: filter opsional
 *   - format: 'json' (default) — hanya untuk konsistensi, format ditangani di route
 *
 * @returns { items, range: { from, to, total, returned } }
 */
function listAdsterraSafeProxiesByRange(opts) {
  const {
    from = 1, to = null,
    protocol = '', country = '',
    minScore = 0,
    sortBy = 'qualityScore', sortOrder = 'desc',
  } = opts || {};

  const fromNum = Math.max(1, parseInt(from, 10) || 1);
  // Default: 50 record mulai dari `from`
  const toNum = to != null
    ? Math.max(fromNum, parseInt(to, 10))
    : fromNum + 49; // default 50 record
  const limit = toNum - fromNum + 1;
  const offset = fromNum - 1; // convert to 0-based offset
  const minScoreNum = Math.max(0, Math.min(100, parseInt(minScore, 10) || 0));

  let filtered = (db.proxies || []).filter((x) =>
    x.adsterraSafe === 'safe' &&
    x.status === 'active' &&
    (x.qualityScore == null || x.qualityScore >= minScoreNum)
  );

  if (protocol) filtered = filtered.filter((x) => x.protocol === protocol);
  if (country) filtered = filtered.filter((x) => (x.country || '').toUpperCase() === String(country).toUpperCase());

  const allowedSort = ['qualityScore', 'latencyMs', 'createdAt', 'updatedAt', 'lastCheck', 'exitCountry'];
  const sortField = allowedSort.includes(sortBy) ? sortBy : 'qualityScore';
  const order = sortOrder === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -order;
    if (av > bv) return order;
    return 0;
  });

  const total = filtered.length;
  // Cap limit to MAX_PAGE_SIZE to prevent abuse
  const cappedLimit = Math.min(limit, MAX_PAGE_SIZE);
  const items = filtered.slice(offset, offset + cappedLimit).map(normalizeProxy);

  return {
    items,
    range: {
      from: fromNum,
      to: fromNum + items.length - 1,
      requestedTo: toNum,
      limit: cappedLimit,
      total,
      returned: items.length,
      hasMore: total > toNum,
    },
  };
}

function close() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    saveDbImmediate();
  }
}

module.exports = {
  genId,
  now,
  normalizeProxy,
  findDuplicate,
  listProxies,
  getProxy,
  createProxy,
  updateProxy,
  deleteProxy,
  deleteProxies,
  getStats,
  // API Keys
  listApiKeys,
  findApiKey,
  createApiKey,
  deleteApiKey,
  toggleApiKey,
  markApiKeyUsed,
  listAdsterraSafeProxies,
  listAdsterraSafeProxiesByRange,
  // Constants
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  close,
};
