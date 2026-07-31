/**
 * Proxy Manager - Frontend Application
 * =====================================================================
 * Vanilla JS — no build step required.
 */

'use strict';

// ============================================================
// State
// ============================================================
const state = {
  authChecked: false,
  authenticated: false,
  username: '',
  tab: 'import',
  stats: null,
  loadingStats: false,
};

// Pilihan page size yang tersedia di UI
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200, 500];

// ============================================================
// Toast
// ============================================================
const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function toast(message, variant = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${variant}`;
  el.innerHTML = `
    ${TOAST_ICONS[variant] || TOAST_ICONS.info}
    <div class="toast-content">${escapeHtml(message)}</div>
    <button class="toast-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  `;
  container.appendChild(el);
  const close = () => el.remove();
  el.querySelector('.toast-close').onclick = close;
  setTimeout(close, duration);
}
toast.success = (m) => toast(m, 'success');
toast.error = (m) => toast(m, 'error');
toast.warning = (m) => toast(m, 'warning');
toast.info = (m) => toast(m, 'info');

// ============================================================
// Utils
// ============================================================
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function formatProxyString(p) {
  let s = `${p.protocol}://`;
  if (p.username) {
    s += p.username;
    if (p.password) s += ':' + p.password;
    s += '@';
  }
  s += `${p.host}:${p.port}`;
  return s;
}

async function safeFetchJson(url, options = {}) {
  const { timeoutMs = 0, ...fetchOptions } = options;
  const controller = new AbortController();
  let timer;
  if (timeoutMs > 0) timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      cache: 'no-store',
      signal: controller.signal,
    });
    const bodyText = await res.text();
    let data = null;
    if (bodyText) {
      try { data = JSON.parse(bodyText); }
      catch {
        const preview = bodyText.slice(0, 200).trim();
        if (res.status === 504 || res.status === 502) {
          throw new Error(`Server gateway timeout (HTTP ${res.status}). Coba test lebih sedikit proxy.`);
        }
        throw new Error(`Server mengembalikan respons non-JSON (HTTP ${res.status}). Preview: "${preview}"`);
      }
    }
    if (!res.ok) {
      const errMsg = (data && typeof data === 'object' && data.error) || `HTTP ${res.status}`;
      throw new Error(errMsg);
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Request timeout setelah ${timeoutMs}ms. Coba kurangi jumlah proxy yang diuji.`);
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ============================================================
// Auth check on load
// ============================================================
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated) {
        state.authenticated = true;
        state.username = data.user.username;
      }
    }
  } catch {}
  state.authChecked = true;
  render();
}

// ============================================================
// Render
// ============================================================
function render() {
  const app = document.getElementById('app');

  if (!state.authChecked) {
    app.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;"><div class="spinner large"></div></div>`;
    return;
  }

  if (!state.authenticated) {
    app.innerHTML = renderLogin();
    bindLoginEvents();
    return;
  }

  app.innerHTML = renderApp();
  bindAppEvents();
  if (state.tab === 'import') {
    bindImportEvents();
  } else if (state.tab === 'manage') {
    initManage();
  } else if (state.tab === 'apikeys') {
    initApiKeys();
  }
  fetchStats();
}

// ============================================================
// Login
// ============================================================
function renderLogin() {
  return `
    <div class="login-container">
      <div class="login-card">
        <div class="login-header">
          <div class="login-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div>
            <div class="login-title">Proxy Manager</div>
            <div class="login-subtitle">Masuk untuk mengelola proxy</div>
          </div>
        </div>
        <form class="login-form" id="loginForm">
          <div class="form-group">
            <label>Username</label>
            <div class="input-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <input type="text" id="loginUsername" required autocomplete="username" placeholder="username" />
            </div>
          </div>
          <div class="form-group">
            <label>Password</label>
            <div class="input-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <input type="password" id="loginPassword" required autocomplete="current-password" placeholder="••••••••" />
            </div>
          </div>
          <div id="loginError"></div>
          <button type="submit" class="btn-primary" id="loginBtn">Masuk</button>
          <p class="login-hint">Hubungi administrator untuk kredensial login</p>
        </form>
      </div>
    </div>
  `;
}

function bindLoginEvents() {
  const form = document.getElementById('loginForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Memproses...';
    errorEl.innerHTML = '';
    try {
      const data = await safeFetchJson('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (data.success) {
        state.authenticated = true;
        state.username = data.user.username;
        toast.success(`Selamat datang, ${data.user.username}!`);
        render();
      } else {
        errorEl.innerHTML = `<div class="login-error">${escapeHtml(data.error || 'Login gagal')}</div>`;
      }
    } catch (e) {
      errorEl.innerHTML = `<div class="login-error">${escapeHtml(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Masuk';
    }
  };
}

// ============================================================
// App (logged in)
// ============================================================
function renderApp() {
  return `
    <div class="app">
      <header class="header">
        <div class="header-inner">
          <div class="header-brand">
            <div class="header-logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <div>
              <div class="header-title">Proxy Manager</div>
              <div class="header-subtitle">Dashboard Admin</div>
            </div>
          </div>
          <div class="header-user">
            <span>● ${escapeHtml(state.username)}</span>
            <button class="btn-secondary" id="logoutBtn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              Keluar
            </button>
          </div>
        </div>
      </header>

      <main class="main">
        <div class="stats-grid" id="statsGrid">
          ${renderStatTile('Total Proxy', state.stats?.total ?? 0, 'emerald', 'database')}
          ${renderStatTile('Adsterra Safe', state.stats?.byAdsterra?.safe ?? 0, 'sky', 'shield-check')}
          ${renderStatTile('Blacklisted', state.stats?.blacklistedCount ?? 0, 'amber', 'shield-alert')}
          ${renderStatTile('Active', state.stats?.byStatus?.active ?? 0, 'emerald', 'activity')}
          ${renderStatTile('Tested', state.stats?.testedCount ?? 0, 'violet', 'zap')}
          ${renderStatTile('Countries', state.stats?.byCountry?.length ?? 0, 'violet', 'globe')}
        </div>

        <div class="tabs">
          <button class="tab ${state.tab === 'import' ? 'active' : ''}" data-tab="import">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Import Proxy
          </button>
          <button class="tab ${state.tab === 'manage' ? 'active' : ''}" data-tab="manage">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
            Kelola Proxy
          </button>
          <button class="tab ${state.tab === 'apikeys' ? 'active' : ''}" data-tab="apikeys">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            API Keys
          </button>
        </div>

        <div class="card" id="tabContent">
          ${state.tab === 'import' ? renderImport() : state.tab === 'apikeys' ? renderApiKeys() : renderManage()}
        </div>
      </main>

      <footer class="footer">
        Proxy Manager &middot; Standalone Express + SQLite &middot; Schema MySQL-compatible
      </footer>
    </div>
  `;
}

function renderStatTile(label, value, color, iconName) {
  const icons = {
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
    'shield-check': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
    'shield-alert': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  };
  return `
    <div class="stat-card">
      <div class="stat-header">
        <div class="stat-label">${label}</div>
        <div class="stat-icon ${color}">${icons[iconName] || icons.activity}</div>
      </div>
      <div class="stat-value">${state.loadingStats ? '<span class="spinner"></span>' : (value || 0).toLocaleString()}</div>
    </div>
  `;
}

function bindAppEvents() {
  document.getElementById('logoutBtn').onclick = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    state.authenticated = false;
    state.username = '';
    state.stats = null;
    render();
  };

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      state.tab = tab.dataset.tab;
      render();
    };
  });
}

async function fetchStats() {
  state.loadingStats = true;
  // Update only stats grid
  const grid = document.getElementById('statsGrid');
  if (grid) {
    grid.innerHTML = `
      ${renderStatTile('Total Proxy', 0, 'emerald', 'database')}
      ${renderStatTile('Adsterra Safe', 0, 'sky', 'shield-check')}
      ${renderStatTile('Blacklisted', 0, 'amber', 'shield-alert')}
      ${renderStatTile('Active', 0, 'emerald', 'activity')}
      ${renderStatTile('Tested', 0, 'violet', 'zap')}
      ${renderStatTile('Countries', 0, 'violet', 'globe')}
    `;
  }
  try {
    const data = await safeFetchJson('/api/proxies/stats');
    if (data.success) {
      state.stats = data.data;
    }
  } catch (e) {
    console.error('Stats error:', e);
  } finally {
    state.loadingStats = false;
    if (grid) {
      grid.innerHTML = `
        ${renderStatTile('Total Proxy', state.stats?.total ?? 0, 'emerald', 'database')}
        ${renderStatTile('Adsterra Safe', state.stats?.byAdsterra?.safe ?? 0, 'sky', 'shield-check')}
        ${renderStatTile('Blacklisted', state.stats?.blacklistedCount ?? 0, 'amber', 'shield-alert')}
        ${renderStatTile('Active', state.stats?.byStatus?.active ?? 0, 'emerald', 'activity')}
        ${renderStatTile('Tested', state.stats?.testedCount ?? 0, 'violet', 'zap')}
        ${renderStatTile('Countries', state.stats?.byCountry?.length ?? 0, 'violet', 'globe')}
      `;
    }
  }
}

// ============================================================
// Import tab
// ============================================================
function renderImport() {
  return `
    <div id="importTab">
      <div class="section-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        Import Proxy
      </div>
      <p class="section-desc">
        Unggah file <code>.txt</code> atau <code>.json</code>. Mendukung format: <code>host:port</code>,
        <code>protocol://user:pass@host:port</code>, <code>host:port:user:pass</code>, atau array JSON.
      </p>
      <div id="importContent"></div>
    </div>
  `;
}

function bindImportEvents() {
  const container = document.getElementById('importContent');
  container.innerHTML = renderUploadZone();

  const fileInput = container.querySelector('#fileInput');
  const uploadZone = container.querySelector('#uploadZone');

  uploadZone.onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
  };

  uploadZone.ondragover = (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragging');
  };
  uploadZone.ondragleave = (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragging');
  };
  uploadZone.ondrop = (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  container.querySelector('#pasteBtn').onclick = async (e) => {
    e.stopPropagation();
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { toast.warning('Clipboard kosong'); return; }
      loadFileContent('clipboard-paste.txt', text);
    } catch (e) {
      toast.error('Gagal membaca clipboard: ' + e.message);
    }
  };
}

function renderUploadZone() {
  return `
    <div class="upload-zone" id="uploadZone">
      <input type="file" id="fileInput" accept=".txt,.json,text/plain,application/json" style="display:none" />
      <div class="upload-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      </div>
      <p style="font-size:15px;font-weight:500;color:var(--text);margin-bottom:4px;">Tarik file ke sini atau klik untuk memilih</p>
      <p style="font-size:12px;color:var(--text-muted);">.txt atau .json, maksimal 10 MB</p>
      <button class="btn-icon-text" id="pasteBtn" style="margin-top:16px;" onclick="event.stopPropagation()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
        Tempel dari Clipboard
      </button>
    </div>
  `;
}

async function handleFile(file) {
  if (file.size > 10 * 1024 * 1024) { toast.error('Ukuran file melebihi 10 MB'); return; }
  try {
    const text = await file.text();
    loadFileContent(file.name, text);
  } catch (e) {
    toast.error('Gagal membaca file: ' + e.message);
  }
}

async function loadFileContent(fileName, content) {
  const container = document.getElementById('importContent');
  container.innerHTML = renderFileLoaded(fileName, content, true);

  // Preview
  try {
    const data = await safeFetchJson('/api/proxies/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, fileName }),
    });
    if (data.success) {
      state._importContent = content;
      state._importFileName = fileName;
      container.innerHTML = renderFileLoaded(fileName, content, false, data.proxies, data.errors);
      bindImportLoadedEvents();
    } else {
      container.innerHTML = renderFileLoaded(fileName, content, false, [], data.errors || [{ line: 0, raw: '', reason: data.error }]);
      bindImportLoadedEvents();
    }
  } catch (e) {
    container.innerHTML = renderFileLoaded(fileName, content, false, [], [{ line: 0, raw: '', reason: e.message }]);
    bindImportLoadedEvents();
  }
}

function renderFileLoaded(fileName, content, loading, proxies, errors) {
  const count = proxies ? proxies.length : 0;
  const errCount = errors ? errors.length : 0;
  const httpCount = proxies ? proxies.filter((p) => p.protocol === 'http').length : 0;
  const httpsCount = proxies ? proxies.filter((p) => p.protocol === 'https').length : 0;
  const socks5Count = proxies ? proxies.filter((p) => p.protocol === 'socks5').length : 0;

  return `
    <div class="file-info">
      <div class="file-info-left">
        <div class="file-info-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <div>
          <div class="file-info-name">${escapeHtml(fileName)}</div>
          <div class="file-info-meta">
            ${content.length.toLocaleString()} karakter
            ${proxies ? ` • ${count} proxy valid` : ''}
            ${errCount > 0 ? ` • ${errCount} baris gagal` : ''}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);cursor:pointer;">
          <input type="checkbox" id="dedupeCheckbox" checked /> Deduplikasi
        </label>
        <button class="btn-secondary" id="resetBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Reset
        </button>
      </div>
    </div>

    ${loading ? '<div style="text-align:center;padding:24px;"><div class="spinner large"></div><p style="margin-top:8px;color:var(--text-muted);">Memproses file...</p></div>' : ''}

    ${!loading && proxies && count > 0 ? `
      <div class="preview-grid">
        <div class="preview-stat emerald"><div class="preview-stat-label">Total Valid</div><div class="preview-stat-value">${count}</div></div>
        <div class="preview-stat sky"><div class="preview-stat-label">HTTP</div><div class="preview-stat-value">${httpCount}</div></div>
        <div class="preview-stat violet"><div class="preview-stat-label">HTTPS</div><div class="preview-stat-value">${httpsCount}</div></div>
        <div class="preview-stat amber"><div class="preview-stat-label">SOCKS5</div><div class="preview-stat-value">${socks5Count}</div></div>
      </div>

      <div class="preview-table-wrap">
        <div class="preview-head">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Preview (${Math.min(count, 50)} dari ${count})
        </div>
        <div class="preview-scroll">
          <table>
            <thead><tr><th>#</th><th>Protocol</th><th>Host</th><th>Port</th><th>Auth</th><th>String</th></tr></thead>
            <tbody>
              ${proxies.slice(0, 50).map((p, i) => `
                <tr>
                  <td style="color:var(--text-faint);">${i + 1}</td>
                  <td><span class="badge protocol">${p.protocol}</span></td>
                  <td style="font-family:monospace;font-size:11px;">${escapeHtml(p.host)}</td>
                  <td style="font-family:monospace;font-size:11px;">${p.port}</td>
                  <td>${p.username ? '<span style="color:var(--emerald);font-size:11px;">● Yes</span>' : '<span style="color:var(--text-faint);">—</span>'}</td>
                  <td style="font-family:monospace;font-size:11px;color:var(--text-muted);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(formatProxyString(p))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}

    ${!loading && errors && errors.length > 0 ? `
      <details class="parse-errors">
        <summary>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          ${errCount} baris gagal di-parse
        </summary>
        <div class="parse-errors-list">
          ${errors.slice(0, 50).map((e) => `<div>Baris ${e.line}: ${(e.raw || '').slice(0, 80) || '(kosong)'} — ${escapeHtml(e.reason)}</div>`).join('')}
        </div>
      </details>
    ` : ''}

    ${!loading ? `
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
        <button class="btn-secondary" id="cancelBtn">Batal</button>
        <button class="btn-icon-text primary" id="importBtn" ${!proxies || count === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Impor ${count || 0} Proxy
        </button>
      </div>
      <div id="importResult"></div>
    ` : ''}

    <details class="format-help">
      <summary>Format yang didukung (klik untuk detail)</summary>
      <div class="format-help-content">
        <div>
          <p>Format TXT (satu proxy per baris):</p>
          <pre>1.2.3.4:8080
http://1.2.3.4:8080
https://user:pass@1.2.3.4:443
socks5://1.2.3.4:1080
1.2.3.4:8080:user:pass
1.2.3.4:8080:user:pass:socks5</pre>
        </div>
        <div>
          <p>Format JSON (array string):</p>
          <pre>[
  "1.2.3.4:8080",
  "socks5://user:pass@5.6.7.8:1080"
]</pre>
        </div>
        <div>
          <p>Format JSON (array object):</p>
          <pre>[
  { "protocol": "http", "host": "1.2.3.4", "port": 8080 },
  { "type": "socks5", "ip": "5.6.7.8", "port": 1080,
    "username": "u", "password": "p", "country": "US" }
]</pre>
        </div>
      </div>
    </details>
  `;
}

function bindImportLoadedEvents() {
  const container = document.getElementById('importContent');
  const resetBtn = container.querySelector('#resetBtn');
  const cancelBtn = container.querySelector('#cancelBtn');
  const importBtn = container.querySelector('#importBtn');

  if (resetBtn) resetBtn.onclick = () => {
    state._importContent = null;
    state._importFileName = null;
    container.innerHTML = renderUploadZone();
    bindImportEvents();
  };
  if (cancelBtn) cancelBtn.onclick = () => {
    state._importContent = null;
    state._importFileName = null;
    container.innerHTML = renderUploadZone();
    bindImportEvents();
  };

  if (importBtn) importBtn.onclick = async () => {
    if (!state._importContent) { toast.warning('Belum ada konten'); return; }
    const dedupe = container.querySelector('#dedupeCheckbox').checked;
    importBtn.disabled = true;
    importBtn.innerHTML = '<span class="spinner"></span> Mengimpor...';
    try {
      const data = await safeFetchJson('/api/proxies/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: state._importContent, fileName: state._importFileName, dedupe }),
      });
      const resultEl = document.getElementById('importResult');
      if (data.success) {
        toast.success(`Berhasil mengimpor ${data.inserted} proxy baru`);
        resultEl.innerHTML = `
          <div class="import-result success">
            <div class="import-result-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
            <div>
              <p style="font-weight:500;">Import berhasil!</p>
              <ul class="import-result-list">
                <li>Total diparse: <strong>${data.totalParsed}</strong></li>
                <li>Duplikat dihapus: <strong>${data.duplicatesRemoved}</strong></li>
                <li>Proxy baru disimpan: <strong>${data.inserted}</strong></li>
                <li>Sudah ada di DB (skip): <strong>${data.skippedExisting}</strong></li>
              </ul>
            </div>
          </div>
        `;
        fetchStats();
      } else {
        toast.error(data.error || 'Gagal mengimpor');
        resultEl.innerHTML = `<div class="import-result error"><div class="import-result-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div>${escapeHtml(data.error || 'Gagal mengimpor')}</div></div>`;
      }
    } catch (e) {
      toast.error('Gagal mengimpor: ' + e.message);
    } finally {
      importBtn.disabled = false;
      importBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Impor ${state._importContent ? '' : ''} Proxy`;
    }
  };
}

// ============================================================
// Manage tab
// ============================================================
const manageState = {
  items: [],
  pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
  loading: false,
  selected: new Set(),
  search: '',
  searchDebounced: '',
  protocolFilter: '',
  statusFilter: '',
  countryFilter: '',
  adsterraFilter: '',
  showFilters: false,
  testingIds: new Set(),
  batchTesting: false,
};

function renderManage() {
  return `<div id="manageTab"></div>`;
}

function initManage() {
  fetchProxies();
  // Re-render after init
  renderManageContent();
}

function renderManageContent() {
  const tab = document.getElementById('manageTab');
  if (!tab) return;

  const hasActiveFilters = !!(manageState.searchDebounced || manageState.protocolFilter || manageState.statusFilter || manageState.countryFilter || manageState.adsterraFilter);

  tab.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
        <div>
          <div class="section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
            Kelola Proxy
          </div>
          <p style="font-size:13px;color:var(--text-muted);">
            Total ${manageState.pagination.total.toLocaleString()} proxy
            ${manageState.selected.size > 0 ? ` • ${manageState.selected.size} dipilih` : ''}
          </p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-icon-text ${hasActiveFilters ? 'violet' : ''}" id="filterBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
            Filter
            ${hasActiveFilters ? '<span style="background:var(--primary);color:white;font-size:10px;padding:1px 6px;border-radius:8px;">aktif</span>' : ''}
          </button>
          <button class="btn-icon-text" id="exportBtn" ${manageState.items.length === 0 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export
          </button>
          <button class="btn-icon-text violet" id="testAllBtn" ${manageState.pagination.total === 0 || manageState.batchTesting ? 'disabled' : ''}>
            ${manageState.batchTesting ? '<span class="spinner"></span>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'}
            Tes Semua
          </button>
          <button class="btn-icon-text primary" id="addBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Tambah Manual
          </button>
        </div>
      </div>

      ${manageState.batchTesting ? `
        <div style="display:flex;align-items:center;gap:12px;background:var(--violet-light);border:1px solid var(--violet);border-radius:var(--radius-sm);padding:8px 12px;font-size:13px;color:var(--violet);">
          <span class="spinner"></span>
          <span>Sedang mengetes proxy... (mungkin butuh beberapa menit)</span>
        </div>
      ` : ''}

      <div class="search-row">
        <div class="search-input-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="search-input" id="searchInput" value="${escapeHtml(manageState.search)}" placeholder="Cari host, port, username, source, note..." />
          ${manageState.search ? '<button class="search-clear" id="searchClear"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' : ''}
        </div>
        ${manageState.showFilters ? `
          <div class="filter-panel">
            <div class="filter-group">
              <label class="filter-label">Protocol</label>
              <select class="filter-select" id="protocolFilter">
                ${['', 'http', 'https', 'socks4', 'socks5'].map((p) => `<option value="${p}" ${manageState.protocolFilter === p ? 'selected' : ''}>${p || 'Semua'}</option>`).join('')}
              </select>
            </div>
            <div class="filter-group">
              <label class="filter-label">Status</label>
              <select class="filter-select" id="statusFilter">
                ${['', 'active', 'inactive', 'dead', 'untested'].map((s) => `<option value="${s}" ${manageState.statusFilter === s ? 'selected' : ''}>${s || 'Semua'}</option>`).join('')}
              </select>
            </div>
            <div class="filter-group">
              <label class="filter-label">Country</label>
              <input type="text" class="filter-input" id="countryFilter" value="${escapeHtml(manageState.countryFilter)}" placeholder="US, ID, ..." />
            </div>
            <div class="filter-group">
              <label class="filter-label">Adsterra Safety</label>
              <select class="filter-select" id="adsterraFilter">
                ${['', 'safe', 'risky', 'unsafe', 'unknown'].map((s) => `<option value="${s}" ${manageState.adsterraFilter === s ? 'selected' : ''}>${s || 'Semua'}</option>`).join('')}
              </select>
            </div>
            ${hasActiveFilters ? `<div style="grid-column:1/-1;display:flex;justify-content:flex-end;"><button id="resetFiltersBtn" style="font-size:12px;color:var(--text-muted);background:none;border:none;cursor:pointer;text-decoration:underline;">Reset semua filter</button></div>` : ''}
          </div>
        ` : ''}
      </div>

      ${manageState.selected.size > 0 ? `
        <div class="bulk-bar">
          <span>${manageState.selected.size} proxy dipilih</span>
          <div class="bulk-bar-actions">
            <button id="clearSelectBtn" style="background:none;border:none;color:inherit;cursor:pointer;text-decoration:underline;font-size:12px;">Batal pilih</button>
            <button class="btn-icon-text violet" id="testSelectedBtn" style="padding:4px 10px;font-size:12px;">
              ${manageState.batchTesting ? '<span class="spinner"></span>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'}
              Tes Dipilih
            </button>
            <button class="btn-icon-text" id="bulkDeleteBtn" style="background:var(--danger);color:white;border-color:var(--danger);padding:4px 10px;font-size:12px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              Hapus Dipilih
            </button>
          </div>
        </div>
      ` : ''}

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:40px;"><input type="checkbox" id="selectAllChk" ${manageState.items.length > 0 && manageState.items.every((it) => manageState.selected.has(it.id)) ? 'checked' : ''} /></th>
              <th>Protocol</th>
              <th>Host:Port</th>
              <th>Status</th>
              <th>Exit IP</th>
              <th>Anon.</th>
              <th>Latency</th>
              <th>BL</th>
              <th>Adsterra</th>
              <th>Score</th>
              <th style="text-align:right;">Aksi</th>
            </tr>
          </thead>
          <tbody id="tableBody">
            ${renderTableBody()}
          </tbody>
        </table>
      </div>

      <div class="legend">
        <div class="legend-row">
          <span><strong>BL</strong>: Blacklist (Spamhaus, Spamcop, SORBS, Barracuda)</span>
          <span><strong>Anon.</strong>: Elite = IP tersembunyi sepenuhnya</span>
          <span><strong>Score</strong>: 0-100</span>
        </div>
      </div>

      <div class="pagination">
        <div class="pagination-info">
          Halaman ${manageState.pagination.page} dari ${manageState.pagination.totalPages || 1}
          ${manageState.pagination.total > 0 ? ` • <button id="deleteAllBtn">Hapus semua ${manageState.pagination.total} proxy</button>` : ''}
        </div>
        <div class="pagination-controls">
          <label class="page-size-wrap" title="Jumlah data per halaman">
            <span>Per page:</span>
            <select id="pageSizeSelect" class="page-size-select">
              ${PAGE_SIZE_OPTIONS.map((sz) => `<option value="${sz}" ${manageState.pagination.pageSize === sz ? 'selected' : ''}>${sz}</option>`).join('')}
            </select>
          </label>
          <button class="btn-icon-text" id="prevBtn" ${manageState.pagination.page <= 1 || manageState.loading ? 'disabled' : ''}>← Prev</button>
          <span style="padding:0 8px;font-size:12px;color:var(--text-muted);">${manageState.pagination.page} / ${manageState.pagination.totalPages || 1}</span>
          <button class="btn-icon-text" id="nextBtn" ${manageState.pagination.page >= manageState.pagination.totalPages || manageState.loading ? 'disabled' : ''}>Next →</button>
        </div>
      </div>
    </div>
  `;

  bindManageEvents();
}

function renderTableBody() {
  if (manageState.loading) {
    return `<tr><td colspan="11" style="text-align:center;padding:48px;color:var(--text-muted);"><span class="spinner large"></span><br><br>Memuat...</td></tr>`;
  }
  if (manageState.items.length === 0) {
    const hasFilters = !!(manageState.searchDebounced || manageState.protocolFilter || manageState.statusFilter || manageState.countryFilter || manageState.adsterraFilter);
    return `<tr><td colspan="11" style="text-align:center;padding:48px;color:var(--text-muted);">${hasFilters ? 'Tidak ada proxy yang cocok dengan filter. Coba ubah filter atau reset.' : 'Belum ada proxy. Klik "Tambah Manual" atau gunakan tab Import untuk menambah proxy.'}</td></tr>`;
  }
  return manageState.items.map((p) => {
    const blSources = p.blacklistSources ? safeParseJsonArray(p.blacklistSources) : [];
    const isTesting = manageState.testingIds.has(p.id);
    const scoreColor = p.qualityScore == null ? 'bad' : p.qualityScore >= 70 ? 'good' : p.qualityScore >= 40 ? 'warn' : 'bad';
    const latencyColor = p.latencyMs == null ? '' : p.latencyMs > 5000 ? 'color:var(--red);' : p.latencyMs > 2000 ? 'color:var(--amber);' : 'color:var(--emerald);';
    return `
      <tr class="${manageState.selected.has(p.id) ? 'selected' : ''}">
        <td><input type="checkbox" class="proxy-chk" data-id="${p.id}" ${manageState.selected.has(p.id) ? 'checked' : ''} /></td>
        <td><span class="badge protocol">${p.protocol}</span></td>
        <td style="font-family:monospace;font-size:11px;">
          <button class="action-btn detail" data-action="detail" data-id="${p.id}" style="font-family:inherit;font-size:11px;color:inherit;padding:0;" title="Lihat detail">${p.host}:${p.port}</button>
        </td>
        <td><span class="badge status-${p.status}">${p.status}</span></td>
        <td style="font-family:monospace;font-size:11px;">
          ${p.exitIp ? `${escapeHtml(p.exitIp)}${p.exitCountry ? `<span style="color:var(--text-faint);">[${escapeHtml(p.exitCountry)}]</span>` : ''}` : '<span style="color:var(--text-faint);">—</span>'}
        </td>
        <td>${p.anonymity ? `<span class="badge anon-${p.anonymity}">${p.anonymity}</span>` : '<span style="color:var(--text-faint);">—</span>'}</td>
        <td style="font-size:11px;${latencyColor}">${p.latencyMs != null ? p.latencyMs + 'ms' : '<span style="color:var(--text-faint);">—</span>'}</td>
        <td style="text-align:center;">
          ${p.blacklisted === true ? `<span class="bl-bad" title="Blacklisted: ${escapeHtml(blSources.join(', '))}">!</span>`
            : p.blacklisted === false ? `<span class="bl-clean" title="Clean">✓</span>`
            : '<span style="color:var(--text-faint);">—</span>'}
        </td>
        <td>${p.adsterraSafe ? `<span class="badge adsterra-${p.adsterraSafe}">${p.adsterraSafe}</span>` : '<span style="color:var(--text-faint);">—</span>'}</td>
        <td>
          ${p.qualityScore != null ? `
            <div class="score-bar">
              <div class="score-track"><div class="score-fill ${scoreColor}" style="width:${p.qualityScore}%"></div></div>
              <span style="font-family:monospace;font-weight:500;font-size:11px;">${p.qualityScore}</span>
            </div>
          ` : '<span style="color:var(--text-faint);">—</span>'}
        </td>
        <td>
          <div style="display:flex;justify-content:flex-end;gap:4px;">
            <button class="action-btn test" data-action="test" data-id="${p.id}" ${isTesting || manageState.batchTesting ? 'disabled' : ''} title="Tes proxy">
              ${isTesting ? '<span class="spinner"></span>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'}
            </button>
            <button class="action-btn detail" data-action="detail" data-id="${p.id}" title="Lihat detail">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
            <button class="action-btn edit" data-action="edit" data-id="${p.id}" title="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="action-btn delete" data-action="delete" data-id="${p.id}" title="Hapus">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function safeParseJsonArray(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

function bindManageEvents() {
  const tab = document.getElementById('manageTab');
  if (!tab) return;

  // Search
  const searchInput = tab.querySelector('#searchInput');
  if (searchInput) {
    let timer;
    searchInput.oninput = (e) => {
      manageState.search = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(() => {
        manageState.searchDebounced = manageState.search;
        manageState.pagination.page = 1;
        fetchProxies();
      }, 350);
    };
  }
  const searchClear = tab.querySelector('#searchClear');
  if (searchClear) searchClear.onclick = () => {
    manageState.search = '';
    manageState.searchDebounced = '';
    manageState.pagination.page = 1;
    fetchProxies();
  };

  // Filter toggle
  const filterBtn = tab.querySelector('#filterBtn');
  if (filterBtn) filterBtn.onclick = () => {
    manageState.showFilters = !manageState.showFilters;
    renderManageContent();
  };

  // Filter inputs
  const protocolFilter = tab.querySelector('#protocolFilter');
  if (protocolFilter) protocolFilter.onchange = (e) => {
    manageState.protocolFilter = e.target.value;
    manageState.pagination.page = 1;
    fetchProxies();
  };
  const statusFilter = tab.querySelector('#statusFilter');
  if (statusFilter) statusFilter.onchange = (e) => {
    manageState.statusFilter = e.target.value;
    manageState.pagination.page = 1;
    fetchProxies();
  };
  const countryFilter = tab.querySelector('#countryFilter');
  if (countryFilter) {
    let timer;
    countryFilter.oninput = (e) => {
      manageState.countryFilter = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(() => {
        manageState.pagination.page = 1;
        fetchProxies();
      }, 350);
    };
  }
  const adsterraFilter = tab.querySelector('#adsterraFilter');
  if (adsterraFilter) adsterraFilter.onchange = (e) => {
    manageState.adsterraFilter = e.target.value;
    manageState.pagination.page = 1;
    fetchProxies();
  };
  const resetFiltersBtn = tab.querySelector('#resetFiltersBtn');
  if (resetFiltersBtn) resetFiltersBtn.onclick = () => {
    manageState.search = '';
    manageState.searchDebounced = '';
    manageState.protocolFilter = '';
    manageState.statusFilter = '';
    manageState.countryFilter = '';
    manageState.adsterraFilter = '';
    manageState.pagination.page = 1;
    fetchProxies();
  };

  // Export
  const exportBtn = tab.querySelector('#exportBtn');
  if (exportBtn) exportBtn.onclick = () => {
    if (manageState.items.length === 0) { toast.warning('Tidak ada data'); return; }
    const lines = manageState.items.map((p) => formatProxyString(p));
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `proxies-export-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${manageState.items.length} proxy diekspor`);
  };

  // Test all
  const testAllBtn = tab.querySelector('#testAllBtn');
  if (testAllBtn) testAllBtn.onclick = () => handleTestBatch('filtered');

  // Test selected
  const testSelectedBtn = tab.querySelector('#testSelectedBtn');
  if (testSelectedBtn) testSelectedBtn.onclick = () => handleTestBatch('selected');

  // Add
  const addBtn = tab.querySelector('#addBtn');
  if (addBtn) addBtn.onclick = () => openAddEditModal(null);

  // Select all
  const selectAllChk = tab.querySelector('#selectAllChk');
  if (selectAllChk) selectAllChk.onchange = (e) => {
    if (e.target.checked) {
      manageState.items.forEach((it) => manageState.selected.add(it.id));
    } else {
      manageState.items.forEach((it) => manageState.selected.delete(it.id));
    }
    renderManageContent();
  };

  // Per-row checkbox
  tab.querySelectorAll('.proxy-chk').forEach((chk) => {
    chk.onchange = (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) manageState.selected.add(id);
      else manageState.selected.delete(id);
      renderManageContent();
    };
  });

  // Bulk delete
  const bulkDeleteBtn = tab.querySelector('#bulkDeleteBtn');
  if (bulkDeleteBtn) bulkDeleteBtn.onclick = () => openBulkDeleteModal('selected');
  const clearSelectBtn = tab.querySelector('#clearSelectBtn');
  if (clearSelectBtn) clearSelectBtn.onclick = () => {
    manageState.selected.clear();
    renderManageContent();
  };
  const deleteAllBtn = tab.querySelector('#deleteAllBtn');
  if (deleteAllBtn) deleteAllBtn.onclick = () => openBulkDeleteModal('filtered');

  // Action buttons
  tab.querySelectorAll('[data-action]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'test') handleTestSingle(id);
      else if (action === 'detail') openDetailModal(id);
      else if (action === 'edit') {
        const p = manageState.items.find((x) => x.id === id);
        if (p) openAddEditModal(p);
      } else if (action === 'delete') handleSingleDelete(id);
    };
  });

  // Pagination
  const prevBtn = tab.querySelector('#prevBtn');
  if (prevBtn) prevBtn.onclick = () => {
    if (manageState.pagination.page > 1) {
      manageState.pagination.page--;
      fetchProxies();
    }
  };
  const nextBtn = tab.querySelector('#nextBtn');
  if (nextBtn) nextBtn.onclick = () => {
    if (manageState.pagination.page < manageState.pagination.totalPages) {
      manageState.pagination.page++;
      fetchProxies();
    }
  };

  // Page size selector — flexible pagination
  const pageSizeSelect = tab.querySelector('#pageSizeSelect');
  if (pageSizeSelect) pageSizeSelect.onchange = (e) => {
    const newSize = parseInt(e.target.value, 10) || 20;
    manageState.pagination.pageSize = newSize;
    manageState.pagination.page = 1;
    fetchProxies();
  };
}

async function fetchProxies() {
  manageState.loading = true;
  renderManageContent();
  try {
    const params = new URLSearchParams();
    params.set('page', manageState.pagination.page);
    params.set('pageSize', manageState.pagination.pageSize);
    if (manageState.searchDebounced) params.set('search', manageState.searchDebounced);
    if (manageState.protocolFilter) params.set('protocol', manageState.protocolFilter);
    if (manageState.statusFilter) params.set('status', manageState.statusFilter);
    if (manageState.countryFilter) params.set('country', manageState.countryFilter);
    if (manageState.adsterraFilter) params.set('adsterraSafe', manageState.adsterraFilter);
    const data = await safeFetchJson(`/api/proxies?${params.toString()}`);
    if (data.success) {
      manageState.items = data.data;
      manageState.pagination = data.pagination;
    } else {
      toast.error(data.error || 'Gagal memuat');
    }
  } catch (e) {
    toast.error('Gagal memuat proxy: ' + e.message);
  } finally {
    manageState.loading = false;
    renderManageContent();
  }
}

async function handleTestSingle(id) {
  manageState.testingIds.add(id);
  renderManageContent();
  try {
    const data = await safeFetchJson(`/api/proxies/${id}/test?_t=${Date.now()}`, {
      method: 'POST', timeoutMs: 30000,
    });
    if (data.success && data.testResult) {
      const r = data.testResult;
      if (r.ok) toast.success(`Test OK • ${r.exitIp} • ${r.anonymity} • score ${r.qualityScore}`);
      else toast.error(`Test gagal: ${r.error || 'unknown error'}`);
      fetchProxies();
      fetchStats();
    } else {
      toast.error(data.error || 'Gagal test proxy');
    }
  } catch (e) {
    toast.error('Gagal test: ' + e.message);
  } finally {
    manageState.testingIds.delete(id);
    renderManageContent();
  }
}

async function handleTestBatch(mode) {
  let payload = {};
  let expectedCount = 0;
  if (mode === 'selected') {
    if (manageState.selected.size === 0) { toast.warning('Tidak ada proxy dipilih'); return; }
    payload = { ids: Array.from(manageState.selected), concurrency: 8 };
    expectedCount = manageState.selected.size;
  } else {
    payload = {
      concurrency: 8,
      filter: {
        ...(manageState.protocolFilter && { protocol: manageState.protocolFilter }),
        ...(manageState.statusFilter && { status: manageState.statusFilter }),
        ...(manageState.countryFilter && { country: manageState.countryFilter }),
        ...(manageState.adsterraFilter && { adsterraSafe: manageState.adsterraFilter }),
        ...(manageState.searchDebounced && { search: manageState.searchDebounced }),
      },
    };
    expectedCount = manageState.pagination.total;
  }

  // MAX_BATCH_TEST default adalah 50 (lihat index.js, dapat di-override via env var)
  const MAX_BATCH_UI = 50;
  if (expectedCount > MAX_BATCH_UI) toast.warning(`Akan mengetes maksimal ${MAX_BATCH_UI} proxy (dari ${expectedCount}) — untuk hindari timeout`);
  else if (expectedCount === 0) { toast.warning('Tidak ada proxy untuk diuji'); return; }

  // Hitung estimasi timeout berdasarkan jumlah proxy yang akan diuji
  // Rumus: ceil(min(count, MAX_BATCH_UI) / concurrency) * 12s + 10s buffer
  const testCount = Math.min(expectedCount, MAX_BATCH_UI);
  const concurrency = payload.concurrency || 8;
  const estimatedTimeoutMs = (Math.ceil(testCount / concurrency) * 12000) + 10000;
  // Set HTTP timeout dengan margin 20% di atas estimasi
  const httpTimeoutMs = Math.max(120000, Math.ceil(estimatedTimeoutMs * 1.2));

  manageState.batchTesting = true;
  renderManageContent();
  try {
    const data = await safeFetchJson(`/api/proxies/test-batch?_t=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: httpTimeoutMs,
    });
    if (data.success && data.summary) {
      const s = data.summary;
      const dur = s.durationMs ? ` (${(s.durationMs / 1000).toFixed(1)}s)` : '';
      const estDur = s.estimatedDurationMs ? ` est: ${(s.estimatedDurationMs / 1000).toFixed(1)}s` : '';
      toast.success(`Selesai${dur}${estDur}: ${s.passed} OK, ${s.failed} gagal • ${s.safe} safe, ${s.risky} risky, ${s.unsafe} unsafe`);
      fetchProxies();
      fetchStats();
    } else {
      toast.error(data.error || 'Gagal batch test');
    }
  } catch (e) {
    let msg = e.message;
    if (msg.includes('timeout') || msg.includes('Timeout')) {
      msg = `Batch test timeout setelah ${(httpTimeoutMs / 1000).toFixed(0)}s. Coba test lebih sedikit proxy atau turunkan concurrency di payload.`;
    }
    toast.error('Gagal batch test: ' + msg);
  } finally {
    manageState.batchTesting = false;
    renderManageContent();
  }
}

async function handleSingleDelete(id) {
  if (!confirm('Hapus proxy ini?')) return;
  try {
    const data = await safeFetchJson(`/api/proxies/${id}`, { method: 'DELETE' });
    if (data.success) {
      toast.success('Proxy dihapus');
      manageState.selected.delete(id);
      fetchProxies();
      fetchStats();
    } else toast.error(data.error || 'Gagal menghapus');
  } catch (e) { toast.error('Gagal menghapus: ' + e.message); }
}

function openBulkDeleteModal(mode) {
  let count = mode === 'selected' ? manageState.selected.size : manageState.pagination.total;
  const requiresConfirm = mode === 'filtered' || mode === 'all';
  const title = mode === 'selected' ? `Hapus ${count} proxy terpilih?`
    : mode === 'filtered' ? `Hapus ${count} proxy yang cocok filter?`
    : `Hapus SEMUA ${count} proxy?`;
  const desc = mode === 'selected' ? 'Tindakan ini tidak dapat dibatalkan.'
    : mode === 'filtered' ? 'Tindakan ini tidak dapat dibatalkan. Semua proxy yang cocok filter akan dihapus permanen.'
    : 'PERINGATAN: Akan menghapus SELURUH proxy dari database.';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:400px;border-color:var(--red);">
      <div class="modal-header" style="border-bottom-color:var(--border);">
        <div class="modal-title" style="color:var(--red);">
          <div style="background:var(--red-light);padding:8px;border-radius:50%;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
          ${title}
        </div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <p style="font-size:13px;color:var(--text-muted);">${desc}</p>
        ${requiresConfirm ? `
          <div style="margin-top:12px;">
            <label style="font-size:12px;color:var(--text-muted);">Ketik <strong style="font-family:monospace;color:var(--red);">DELETE</strong> untuk konfirmasi</label>
            <input type="text" id="confirmInput" placeholder="DELETE" style="width:100%;padding:6px 8px;margin-top:4px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text);outline:none;font-size:13px;" />
          </div>
        ` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Batal</button>
        <button class="btn-icon-text" id="confirmDeleteBtn" style="background:var(--danger);color:white;border-color:var(--danger);" ${requiresConfirm ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          Hapus Permanen
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const confirmInput = overlay.querySelector('#confirmInput');
  const confirmBtn = overlay.querySelector('#confirmDeleteBtn');
  if (confirmInput) {
    confirmInput.oninput = (e) => {
      confirmBtn.disabled = e.target.value !== 'DELETE';
    };
  }
  confirmBtn.onclick = async () => {
    let payload = {};
    if (mode === 'selected') payload = { ids: Array.from(manageState.selected) };
    else if (mode === 'filtered') {
      payload = {
        filter: {
          ...(manageState.protocolFilter && { protocol: manageState.protocolFilter }),
          ...(manageState.statusFilter && { status: manageState.statusFilter }),
          ...(manageState.countryFilter && { country: manageState.countryFilter }),
          ...(manageState.searchDebounced && { search: manageState.searchDebounced }),
        },
      };
    } else payload = { all: true };

    try {
      const data = await safeFetchJson('/api/proxies', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (data.success) {
        toast.success(`${data.deleted} proxy dihapus`);
        manageState.selected.clear();
        overlay.remove();
        manageState.pagination.page = 1;
        fetchProxies();
        fetchStats();
      } else toast.error(data.error || 'Gagal menghapus');
    } catch (e) { toast.error('Gagal menghapus: ' + e.message); }
  };
}

function openAddEditModal(proxy) {
  const isEdit = !!proxy;
  const form = {
    protocol: proxy?.protocol || 'http',
    host: proxy?.host || '',
    port: proxy?.port || '',
    username: proxy?.username || '',
    password: proxy?.password || '',
    country: proxy?.country || '',
    source: proxy?.source || 'manual',
    status: proxy?.status || 'untested',
    note: proxy?.note || '',
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">${isEdit ? 'Edit Proxy' : 'Tambah Proxy'}</div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-field">
            <label class="form-field-label">Protocol</label>
            <select id="f_protocol">
              <option value="http" ${form.protocol === 'http' ? 'selected' : ''}>http</option>
              <option value="https" ${form.protocol === 'https' ? 'selected' : ''}>https</option>
              <option value="socks4" ${form.protocol === 'socks4' ? 'selected' : ''}>socks4</option>
              <option value="socks5" ${form.protocol === 'socks5' ? 'selected' : ''}>socks5</option>
            </select>
          </div>
          <div class="form-field">
            <label class="form-field-label">Status</label>
            <select id="f_status">
              <option value="untested" ${form.status === 'untested' ? 'selected' : ''}>untested</option>
              <option value="active" ${form.status === 'active' ? 'selected' : ''}>active</option>
              <option value="inactive" ${form.status === 'inactive' ? 'selected' : ''}>inactive</option>
              <option value="dead" ${form.status === 'dead' ? 'selected' : ''}>dead</option>
            </select>
          </div>
        </div>
        <div class="form-row-3">
          <div class="form-field">
            <label class="form-field-label">Host *</label>
            <input type="text" id="f_host" value="${escapeHtml(form.host)}" required placeholder="1.2.3.4 atau example.com" />
          </div>
          <div class="form-field">
            <label class="form-field-label">Port *</label>
            <input type="number" id="f_port" value="${escapeHtml(String(form.port))}" min="1" max="65535" placeholder="8080" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label class="form-field-label">Username</label>
            <input type="text" id="f_username" value="${escapeHtml(form.username)}" placeholder="(opsional)" />
          </div>
          <div class="form-field">
            <label class="form-field-label">Password</label>
            <input type="text" id="f_password" value="${escapeHtml(form.password)}" placeholder="(opsional)" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label class="form-field-label">Country</label>
            <input type="text" id="f_country" value="${escapeHtml(form.country)}" maxlength="3" placeholder="US" />
          </div>
          <div class="form-field">
            <label class="form-field-label">Source</label>
            <input type="text" id="f_source" value="${escapeHtml(form.source)}" placeholder="manual" />
          </div>
        </div>
        <div class="form-field" style="margin-bottom:12px;">
          <label class="form-field-label">Note</label>
          <input type="text" id="f_note" value="${escapeHtml(form.note)}" placeholder="(opsional)" />
        </div>
        <div class="form-preview" id="formPreview" style="display:none;">
          <div class="form-preview-label">Preview:</div>
          <code id="previewCode"></code>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Batal</button>
        <button class="btn-icon-text primary" id="saveProxyBtn">
          ${isEdit ? 'Simpan' : 'Tambah'}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Live preview
  const updatePreview = () => {
    const p = {
      protocol: overlay.querySelector('#f_protocol').value,
      host: overlay.querySelector('#f_host').value,
      port: parseInt(overlay.querySelector('#f_port').value, 10) || 0,
      username: overlay.querySelector('#f_username').value,
      password: overlay.querySelector('#f_password').value,
    };
    const preview = overlay.querySelector('#formPreview');
    const code = overlay.querySelector('#previewCode');
    if (p.host && p.port) {
      preview.style.display = 'block';
      code.textContent = formatProxyString(p);
    } else {
      preview.style.display = 'none';
    }
  };
  overlay.querySelectorAll('input, select').forEach((el) => el.oninput = updatePreview);
  updatePreview();

  overlay.querySelector('#saveProxyBtn').onclick = async () => {
    const data = {
      protocol: overlay.querySelector('#f_protocol').value,
      host: overlay.querySelector('#f_host').value,
      port: parseInt(overlay.querySelector('#f_port').value, 10),
      username: overlay.querySelector('#f_username').value || null,
      password: overlay.querySelector('#f_password').value || null,
      country: overlay.querySelector('#f_country').value.toUpperCase() || null,
      source: overlay.querySelector('#f_source').value || 'manual',
      status: overlay.querySelector('#f_status').value,
      note: overlay.querySelector('#f_note').value || null,
    };
    if (!data.host || !data.port) { toast.error('Host dan port wajib diisi'); return; }
    if (isNaN(data.port) || data.port < 1 || data.port > 65535) { toast.error('Port harus 1-65535'); return; }

    const btn = overlay.querySelector('#saveProxyBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Menyimpan...';
    try {
      const url = isEdit ? `/api/proxies/${proxy.id}` : '/api/proxies';
      const method = isEdit ? 'PUT' : 'POST';
      const res = await safeFetchJson(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxy: data }),
      });
      if (res.success) {
        toast.success(isEdit ? 'Proxy diperbarui' : 'Proxy ditambahkan');
        overlay.remove();
        fetchProxies();
        fetchStats();
      } else {
        toast.error(res.error || 'Gagal menyimpan');
      }
    } catch (e) {
      toast.error('Gagal menyimpan: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = isEdit ? 'Simpan' : 'Tambah';
    }
  };
}

async function openDetailModal(id) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal wide"><div class="modal-body" style="text-align:center;padding:48px;"><div class="spinner large"></div></div></div>`;
  document.body.appendChild(overlay);

  try {
    const data = await safeFetchJson(`/api/proxies/${id}`);
    if (!data.success) { toast.error(data.error || 'Gagal'); overlay.remove(); return; }
    renderDetailModal(overlay, data.data);
  } catch (e) {
    toast.error('Gagal memuat detail: ' + e.message);
    overlay.remove();
  }
}

function renderDetailModal(overlay, p) {
  const blSources = p.blacklistSources ? safeParseJsonArray(p.blacklistSources) : [];
  const lastCheck = p.lastCheck ? new Date(p.lastCheck).toLocaleString('id-ID') : null;
  const scoreColor = p.qualityScore == null ? 'bad' : p.qualityScore >= 70 ? 'good' : p.qualityScore >= 40 ? 'warn' : 'bad';

  const externalLinks = [
    { url: 'https://whoer.net/', label: 'Whoer.net (full anonymity check)' },
    { url: 'https://dnsleaktest.com/', label: 'DNS Leak Test' },
    { url: 'https://browserleaks.com/ip', label: 'Browser Leaks IP' },
    ...(p.exitIp ? [{ url: `https://www.abuseipdb.com/check/${p.exitIp}`, label: `AbuseIPDB: ${p.exitIp}` }] : []),
    ...(p.exitIp ? [{ url: 'https://www.spamhaus.org/lookup/', label: `Spamhaus lookup: ${p.exitIp}` }] : []),
  ];

  overlay.innerHTML = `
    <div class="modal wide">
      <div class="modal-header">
        <div class="modal-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--violet);"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Detail & Hasil Test Proxy
        </div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;">Konfigurasi Proxy</div>
          <div style="background:var(--bg-muted);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;font-family:monospace;font-size:13px;word-break:break-all;">${escapeHtml(formatProxyString(p))}</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px;font-size:12px;">
            <div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">Protocol</div><div>${p.protocol}</div></div>
            <div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">Country (input)</div><div>${p.country || '—'}</div></div>
            <div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">Source</div><div>${p.source || '—'}</div></div>
            <div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">Note</div><div>${p.note || '—'}</div></div>
          </div>
        </div>

        <div style="margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);">Hasil Test</div>
            <button class="btn-icon-text violet" id="retestBtn" style="padding:4px 10px;font-size:12px;" ${manageState.testingIds.has(p.id) ? 'disabled' : ''}>
              ${manageState.testingIds.has(p.id) ? '<span class="spinner"></span>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'}
              Tes Ulang
            </button>
          </div>

          ${!p.lastCheck ? `
            <div style="background:var(--amber-light);border:1px solid var(--amber);border-radius:var(--radius-sm);padding:12px;color:var(--amber);font-size:13px;">
              Proxy belum pernah diuji. Klik tombol di atas untuk memulai test kualitas.
            </div>
          ` : p.testError ? `
            <div style="background:var(--red-light);border:1px solid var(--red);border-radius:var(--radius-sm);padding:12px;color:var(--red);font-size:13px;">
              <div style="font-weight:500;">Test gagal:</div>
              <div style="margin-top:4px;font-size:11px;font-family:monospace;word-break:break-all;">${escapeHtml(p.testError)}</div>
            </div>
          ` : `
            <div class="quality-score-box">
              <div class="quality-score-header">
                <span class="quality-score-label">Quality Score</span>
                <span class="quality-score-value ${scoreColor}">${p.qualityScore ?? '—'}<span style="font-size:11px;color:var(--text-faint);">/100</span></span>
              </div>
              <div class="quality-score-track"><div class="score-fill ${scoreColor}" style="width:${p.qualityScore || 0}%;height:100%;"></div></div>
            </div>

            <div class="status-grid">
              <div class="status-box ${p.status === 'active' ? 'ok' : p.status === 'dead' ? 'bad' : 'neutral'}">
                <div class="status-box-label">Status Koneksi</div>
                <div class="status-box-value">${p.status}</div>
              </div>
              <div class="status-box ${p.latencyMs == null ? 'neutral' : p.latencyMs < 2000 ? 'ok' : p.latencyMs < 5000 ? 'warn' : 'bad'}">
                <div class="status-box-label">Latency</div>
                <div class="status-box-value">${p.latencyMs != null ? p.latencyMs + ' ms' : '—'}</div>
              </div>
              <div class="status-box ${p.anonymity === 'elite' ? 'ok' : p.anonymity === 'anonymous' ? 'warn' : p.anonymity === 'transparent' ? 'bad' : 'neutral'}">
                <div class="status-box-label">Anonymity</div>
                <div class="status-box-value">${p.anonymity ? p.anonymity.charAt(0).toUpperCase() + p.anonymity.slice(1) : '—'}</div>
              </div>
              <div class="status-box ${p.blacklisted === true ? 'bad' : p.blacklisted === false ? 'ok' : 'neutral'}">
                <div class="status-box-label">Blacklist</div>
                <div class="status-box-value">${p.blacklisted === true ? `YES (${blSources.length})` : p.blacklisted === false ? 'Clean' : '—'}</div>
              </div>
              <div class="status-box ${p.dnsLeak === true ? 'bad' : p.dnsLeak === false ? 'ok' : 'neutral'}">
                <div class="status-box-label">DNS Leak</div>
                <div class="status-box-value">${p.dnsLeak === true ? 'TERDETEKSI' : p.dnsLeak === false ? 'Aman' : 'Tidak diuji'}</div>
              </div>
              <div class="status-box ${p.adsterraSafe === 'safe' ? 'ok' : p.adsterraSafe === 'risky' ? 'warn' : p.adsterraSafe === 'unsafe' ? 'bad' : 'neutral'}">
                <div class="status-box-label">Adsterra Safe</div>
                <div class="status-box-value">${p.adsterraSafe || '—'}</div>
              </div>
            </div>

            ${p.exitIp ? `
              <div style="border:1px solid var(--border);background:var(--bg-card);border-radius:var(--radius-sm);padding:12px;margin-top:12px;">
                <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:8px;display:flex;align-items:center;gap:6px;">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                  Exit IP Details
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
                  <div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">IP</div><div style="font-family:monospace;">${escapeHtml(p.exitIp)}</div></div>
                  <div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">Country</div><div>${p.exitCountry || '—'}</div></div>
                  <div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">City</div><div>${p.exitCity || '—'}</div></div>
                  <div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">ISP</div><div>${escapeHtml(p.exitIsp || '—')}</div></div>
                  ${p.dnsServer ? `<div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">Server DNS</div><div style="font-family:monospace;">${escapeHtml(p.dnsServer)}</div></div>` : ''}
                  ${lastCheck ? `<div><div style="font-size:10px;color:var(--text-faint);text-transform:uppercase;">Last Check</div><div>${escapeHtml(lastCheck)}</div></div>` : ''}
                </div>
              </div>
            ` : ''}

            ${p.blacklisted === true && blSources.length > 0 ? `
              <div style="background:var(--red-light);border:1px solid var(--red);border-radius:var(--radius-sm);padding:12px;margin-top:12px;">
                <div style="font-size:12px;font-weight:600;color:var(--red);margin-bottom:6px;display:flex;align-items:center;gap:6px;">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  Terdaftar di Blacklist
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                  ${blSources.map((s) => `<span style="background:var(--red-light);color:var(--red);padding:2px 8px;border-radius:12px;font-size:11px;font-family:monospace;">${escapeHtml(s)}</span>`).join('')}
                </div>
              </div>
            ` : ''}

            ${p.adsterraSafe ? `
              <div class="adsterra-rec ${p.adsterraSafe}">
                <div class="adsterra-rec-title">
                  ${p.adsterraSafe === 'safe' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'}
                  Rekomendasi Adsterra: ${p.adsterraSafe.toUpperCase()}
                </div>
                <div class="adsterra-rec-desc">
                  ${p.adsterraSafe === 'safe' ? 'Proxy aman untuk trafik Adsterra: IP bersih, tidak ada blacklist, anonymity tinggi.' : ''}
                  ${p.adsterraSafe === 'risky' ? 'Proxy berisiko: ada indikasi masalah yang dapat memicu deteksi fraud. Gunakan dengan hati-hati.' : ''}
                  ${p.adsterraSafe === 'unsafe' ? 'Proxy TIDAK AMAN untuk Adsterra: IP blacklisted atau anonymity rendah. Jangan digunakan untuk trafik ads.' : ''}
                  ${p.adsterraSafe === 'unknown' ? 'Status belum dapat ditentukan. Jalankan test untuk evaluasi.' : ''}
                </div>
              </div>
            ` : ''}
          `}
        </div>

        <div>
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;">Verifikasi Eksternal (Buka di Browser dengan Proxy Aktif)</div>
          <div class="external-links">
            ${externalLinks.map((l) => `
              <a href="${l.url}" target="_blank" rel="noopener noreferrer" class="external-link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                <span>${escapeHtml(l.label)}</span>
              </a>
            `).join('')}
          </div>
          <p style="margin-top:8px;font-size:11px;color:var(--text-faint);line-height:1.5;">
            Tip: Untuk hasil yang akurat, konfigurasi proxy di browser/system Anda terlebih dahulu (mis. via ekstensi SwitchyOmega atau FoxyProxy), lalu buka link di atas.
          </p>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Tutup</button>
      </div>
    </div>
  `;

  const retestBtn = overlay.querySelector('#retestBtn');
  if (retestBtn) retestBtn.onclick = async () => {
    await handleTestSingle(p.id);
    // Re-fetch detail
    try {
      const data = await safeFetchJson(`/api/proxies/${p.id}`);
      if (data.success) renderDetailModal(overlay, data.data);
    } catch {}
  };
}

// ============================================================
// API Keys tab — kelola API Key untuk akses eksternal (Python app)
// ============================================================
const apiKeysState = {
  items: [],
  loading: false,
  creating: false,
};

function renderApiKeys() {
  return `<div id="apiKeysTab"></div>`;
}

function initApiKeys() {
  fetchApiKeys();
  renderApiKeysContent();
}

function renderApiKeysContent() {
  const tab = document.getElementById('apiKeysTab');
  if (!tab) return;

  tab.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
        <div>
          <div class="section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            API Keys — Akses Eksternal ADSTERRA SAFE
          </div>
          <p style="font-size:13px;color:var(--text-muted);max-width:720px;line-height:1.6;">
            API Key memungkinkan aplikasi Python (atau klien HTTP lain) mengambil daftar proxy
            dengan kategori <strong>ADSTERRA SAFE</strong> (<code>adsterraSafe='safe'</code> &amp;
            <code>status='active'</code>) tanpa login browser. Key disimpan di database server.
          </p>
        </div>
        <button class="btn-icon-text primary" id="createApiKeyBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Buat API Key
        </button>
      </div>

      ${apiKeysState.loading ? `
        <div style="text-align:center;padding:48px;color:var(--text-muted);">
          <span class="spinner large"></span><br><br>Memuat...
        </div>
      ` : apiKeysState.items.length === 0 ? `
        <div style="text-align:center;padding:48px;color:var(--text-muted);background:var(--bg-muted);border:1px dashed var(--border-strong);border-radius:var(--radius);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48" style="opacity:0.4;margin-bottom:8px;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
          <div>Belum ada API Key. Klik "Buat API Key" untuk membuat.</div>
        </div>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>API Key</th>
                <th>Scope</th>
                <th>Status</th>
                <th>Penggunaan</th>
                <th>Terakhir Dipakai</th>
                <th>Dibuat</th>
                <th style="text-align:right;">Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${apiKeysState.items.map((k) => `
                <tr>
                  <td><strong>${escapeHtml(k.name)}</strong>${k.note ? `<br><span style="font-size:11px;color:var(--text-faint);">${escapeHtml(k.note)}</span>` : ''}</td>
                  <td><code style="font-family:monospace;font-size:11px;background:var(--bg-muted);padding:2px 6px;border-radius:4px;">${escapeHtml(k.keyMasked)}</code></td>
                  <td><span class="badge protocol">${escapeHtml(k.scope)}</span></td>
                  <td>${k.active
                    ? '<span class="badge status-active">active</span>'
                    : '<span class="badge status-dead">disabled</span>'}</td>
                  <td style="font-family:monospace;font-size:11px;">${(k.useCount || 0).toLocaleString()}×</td>
                  <td style="font-size:11px;">${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('id-ID') : '<span style="color:var(--text-faint);">—</span>'}</td>
                  <td style="font-size:11px;">${new Date(k.createdAt).toLocaleString('id-ID')}</td>
                  <td>
                    <div style="display:flex;justify-content:flex-end;gap:4px;">
                      <button class="action-btn" data-action="toggle" data-id="${k.id}" data-active="${!k.active}" title="${k.active ? 'Nonaktifkan' : 'Aktifkan'}">
                        ${k.active
                          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
                          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'}
                      </button>
                      <button class="action-btn delete" data-action="delete" data-id="${k.id}" title="Hapus">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}

      <div class="api-doc">
        <div class="api-doc-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <div>
            <div class="api-doc-title">Dokumentasi Penggunaan — Python</div>
            <div class="api-doc-subtitle">Endpoint: <code>GET /api/external/proxies/adsterra-safe</code></div>
          </div>
        </div>

        <div class="api-doc-section">
          <div class="api-doc-label">Endpoint yang tersedia:</div>
          <ul class="api-doc-list">
            <li><code>GET /api/external/proxies/adsterra-safe</code> — pagination (page/pageSize)</li>
            <li><code>GET /api/external/proxies/range/:from-:to</code> — range-based (1-based, inclusive) <span style="color:var(--primary);font-weight:600;">NEW</span></li>
            <li><code>GET /api/external/whoami</code> — cek status API key</li>
            <li><code>GET /api/external/info</code> — info konfigurasi (publik)</li>
          </ul>
        </div>

        <div class="api-doc-section">
          <div class="api-doc-label">Parameter URL (opsional, berlaku untuk pagination & range):</div>
          <ul class="api-doc-list">
            <li><code>format</code> — json (default) | txt | csv | jsonl</li>
            <li><code>page</code> — nomor halaman (default: 1) — khusus endpoint pagination</li>
            <li><code>pageSize</code> — jumlah per halaman (default: 20, max: 500) — khusus pagination</li>
            <li><code>protocol</code> — filter: http | https | socks4 | socks5</li>
            <li><code>country</code> — kode negara (mis. US, ID)</li>
            <li><code>minScore</code> — qualityScore minimum (0-100, default: 0)</li>
            <li><code>sortBy</code> — qualityScore (default) | latencyMs | lastCheck</li>
            <li><code>sortOrder</code> — desc (default) | asc</li>
          </ul>
        </div>

        <div class="api-doc-section">
          <div class="api-doc-label">Autentikasi (pilih salah satu):</div>
          <ul class="api-doc-list">
            <li>Header: <code>X-API-Key: pm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</code></li>
            <li>Header: <code>Authorization: Bearer pm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</code></li>
            <li>Query: <code>?api_key=pm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</code> <span style="color:var(--warning);">(tidak direkomendasikan untuk produksi)</span></li>
          </ul>
        </div>

        <div class="api-doc-section">
          <div class="api-doc-label">Contoh Python (requests):</div>
          <pre class="api-code">import requests

API_KEY = "pm_xxxxxx_ganti_dengan_key_anda"
BASE_URL = "https://server-anda.com"

# Ambil 50 proxy ADSTERRA SAFE, format JSON
resp = requests.get(
    f"{BASE_URL}/api/external/proxies/adsterra-safe",
    headers={"X-API-Key": API_KEY},
    params={"pageSize": 50, "format": "json", "minScore": 70},
    timeout=15,
)
resp.raise_for_status()
data = resp.json()

print(f"Total proxy: {data['pagination']['total']}")
for p in data["data"]:
    url = f"{p['protocol']}://{p['host']}:{p['port']}"
    if p.get('username'):
        url = f"{p['protocol']}://{p['username']}:{p.get('password','')}@{p['host']}:{p['port']}"
    print(url, p.get('qualityScore'), p.get('exitCountry'))</pre>
        </div>

        <div class="api-doc-section">
          <div class="api-doc-label">Contoh Python — format plain text (langsung pakai):</div>
          <pre class="api-code">import requests

API_KEY = "pm_xxxxxx_ganti_dengan_key_anda"
BASE_URL = "https://server-anda.com"

resp = requests.get(
    f"{BASE_URL}/api/external/proxies/adsterra-safe",
    headers={"X-API-Key": API_KEY},
    params={"format": "txt", "pageSize": 100},
    timeout=15,
)
resp.raise_for_status()
proxy_list = resp.text.strip().splitlines()
print(f"Dapat {len(proxy_list)} proxy:")
for line in proxy_list[:5]:
    print(" ", line)</pre>
        </div>

        <div class="api-doc-section">
          <div class="api-doc-label">Contoh curl:</div>
          <pre class="api-code">curl -H "X-API-Key: pm_xxxxxx_ganti_dengan_key_anda" \\
  "https://server-anda.com/api/external/proxies/adsterra-safe?format=txt&pageSize=50"

# CSV
curl -H "X-API-Key: pm_xxxxxx_ganti_dengan_key_anda" \\
  "https://server-anda.com/api/external/proxies/adsterra-safe?format=csv" \\
  -o adsterra-safe.csv

# Cek key valid
curl -H "X-API-Key: pm_xxxxxx_ganti_dengan_key_anda" \\
  "https://server-anda.com/api/external/whoami"</pre>
        </div>

        <div class="api-doc-section">
          <div class="api-doc-label">Range-based API (NEW v2.1) — ambil proxy berdasarkan rentang index:</div>
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
            Endpoint <code>/api/external/proxies/range/:from-:to</code> memungkinkan Anda mengambil proxy
            berdasarkan rentang index 1-based (inclusive). Cocok untuk fetching berkelompok tanpa
            harus pusing dengan pagination <code>page</code>/<code>pageSize</code>.
          </p>
          <ul class="api-doc-list">
            <li><code>/range/1-50</code> → proxy urutan 1 sampai 50</li>
            <li><code>/range/51-100</code> → proxy urutan 51 sampai 100</li>
            <li><code>/range/201</code> → 50 proxy mulai dari index 201 (default to = from + 49)</li>
            <li>Filter sama dengan endpoint pagination: <code>format</code>, <code>protocol</code>, <code>country</code>, <code>minScore</code>, <code>sortBy</code>, <code>sortOrder</code></li>
            <li>Response header: <code>X-Range-From</code>, <code>X-Range-To</code>, <code>X-Total-Count</code>, <code>X-Has-More</code></li>
          </ul>
          <pre class="api-code"># Python: ambil batch 1-50 lalu 51-100
import requests

API_KEY = "pm_xxxxxx_ganti_dengan_key_anda"
BASE_URL = "https://server-anda.com"

for start in [1, 51, 101, 151]:
    end = start + 49
    resp = requests.get(
        f"{BASE_URL}/api/external/proxies/range/{start}-{end}",
        headers={"X-API-Key": API_KEY},
        params={"format": "txt", "minScore": 70},
        timeout=15,
    )
    if resp.status_code != 200:
        break  # tidak ada lagi data
    proxies = resp.text.strip().splitlines()
    print(f"Range {start}-{end}: {len(proxies)} proxy")
    for line in proxies[:3]:
        print(" ", line)

# curl
curl -H "X-API-Key: pm_xxxxxx" \\
  "https://server-anda.com/api/external/proxies/range/1-50?format=txt&minScore=70"</pre>
        </div>
      </div>
    </div>
  `;

  bindApiKeysEvents();
}

function bindApiKeysEvents() {
  const tab = document.getElementById('apiKeysTab');
  if (!tab) return;

  const createBtn = tab.querySelector('#createApiKeyBtn');
  if (createBtn) createBtn.onclick = () => openCreateApiKeyModal();

  tab.querySelectorAll('[data-action]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'delete') {
        if (!confirm('Hapus API Key ini? Akses eksternal yang memakai key ini akan langsung gagal.')) return;
        try {
          const data = await safeFetchJson(`/api/apikeys/${id}`, { method: 'DELETE' });
          if (data.success) {
            toast.success('API Key dihapus');
            fetchApiKeys();
          } else toast.error(data.error || 'Gagal menghapus');
        } catch (e) { toast.error('Gagal: ' + e.message); }
      } else if (action === 'toggle') {
        const active = btn.dataset.active === 'true';
        try {
          const data = await safeFetchJson(`/api/apikeys/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active }),
          });
          if (data.success) {
            toast.success(active ? 'API Key diaktifkan' : 'API Key dinonaktifkan');
            fetchApiKeys();
          } else toast.error(data.error || 'Gagal mengubah');
        } catch (e) { toast.error('Gagal: ' + e.message); }
      }
    };
  });
}

async function fetchApiKeys() {
  apiKeysState.loading = true;
  renderApiKeysContent();
  try {
    const data = await safeFetchJson('/api/apikeys');
    if (data.success) {
      apiKeysState.items = data.data;
    } else {
      toast.error(data.error || 'Gagal memuat API Keys');
    }
  } catch (e) {
    toast.error('Gagal memuat API Keys: ' + e.message);
  } finally {
    apiKeysState.loading = false;
    renderApiKeysContent();
  }
}

function openCreateApiKeyModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--primary);"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
          Buat API Key Baru
        </div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <div class="form-field" style="margin-bottom:12px;">
          <label class="form-field-label">Nama *</label>
          <input type="text" id="ak_name" placeholder="mis. bot-crawler-01" />
        </div>
        <div class="form-field" style="margin-bottom:12px;">
          <label class="form-field-label">Scope</label>
          <select id="ak_scope" disabled>
            <option value="adsterra_safe" selected>adsterra_safe</option>
          </select>
          <p style="font-size:11px;color:var(--text-faint);margin-top:4px;">Saat ini hanya scope <code>adsterra_safe</code> yang tersedia.</p>
        </div>
        <div class="form-field" style="margin-bottom:12px;">
          <label class="form-field-label">Catatan (opsional)</label>
          <input type="text" id="ak_note" placeholder="mis. untuk bot Adsterra produksi" />
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Batal</button>
        <button class="btn-icon-text primary" id="ak_save">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Buat Key
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#ak_save').onclick = async () => {
    const name = overlay.querySelector('#ak_name').value.trim();
    const note = overlay.querySelector('#ak_note').value.trim() || null;
    if (!name) { toast.error('Nama wajib diisi'); return; }
    const btn = overlay.querySelector('#ak_save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Membuat...';
    try {
      const data = await safeFetchJson('/api/apikeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scope: 'adsterra_safe', note }),
      });
      if (data.success) {
        showApiKeyCreatedModal(data.data);
        fetchApiKeys();
        overlay.remove();
      } else {
        toast.error(data.error || 'Gagal membuat API Key');
      }
    } catch (e) {
      toast.error('Gagal: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Buat Key';
    }
  };
}

function showApiKeyCreatedModal(apiKey) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:560px;border-color:var(--primary);">
      <div class="modal-header" style="border-bottom-color:var(--border);">
        <div class="modal-title" style="color:var(--primary);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          API Key Berhasil Dibuat
        </div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <div style="background:var(--amber-light);border:1px solid var(--amber);border-radius:var(--radius-sm);padding:12px;color:var(--amber);font-size:13px;margin-bottom:16px;display:flex;gap:8px;align-items:flex-start;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="flex-shrink:0;margin-top:2px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <div>
            <strong>PERHATIAN:</strong> Salin key sekarang. Untuk keamanan, key lengkap
            <strong>tidak akan ditampilkan lagi</strong> setelah modal ini ditutup.
          </div>
        </div>
        <div class="form-field">
          <label class="form-field-label">Nama</label>
          <div style="padding:8px 10px;background:var(--bg-muted);border-radius:var(--radius-sm);">${escapeHtml(apiKey.name)}</div>
        </div>
        <div class="form-field" style="margin-top:12px;">
          <label class="form-field-label">API Key (lengkap)</label>
          <div style="display:flex;gap:8px;">
            <input type="text" readonly value="${escapeHtml(apiKey.key)}" id="ak_full"
              style="flex:1;font-family:monospace;font-size:12px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text);" />
            <button class="btn-icon-text" id="ak_copy" title="Salin">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Salin
            </button>
          </div>
        </div>
        <div class="form-field" style="margin-top:12px;">
          <label class="form-field-label">Contoh pemakaian cepat (curl):</label>
          <pre class="api-code">curl -H "X-API-Key: ${escapeHtml(apiKey.key)}" \\
  "${location.origin}/api/external/proxies/adsterra-safe?format=txt&pageSize=5"</pre>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-icon-text primary" onclick="this.closest('.modal-overlay').remove()">Saya sudah menyimpan key</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const fullInput = overlay.querySelector('#ak_full');
  const copyBtn = overlay.querySelector('#ak_copy');
  if (copyBtn) copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(apiKey.key);
      toast.success('API Key disalin ke clipboard');
    } catch {
      fullInput.select();
      document.execCommand('copy');
      toast.success('API Key disalin');
    }
  };
  if (fullInput) {
    setTimeout(() => { fullInput.select(); fullInput.setSelectionRange(0, apiKey.key.length); }, 100);
  }
}

// ============================================================
// Init
// ============================================================
checkAuth();
