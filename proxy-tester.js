/**
 * Proxy Tester Library
 * =====================================================================
 * Testing kualitas proxy: exit IP, geolocation, anonymity, blacklist,
 * Adsterra safety.
 */

const { fetch: undiciFetch, ProxyAgent } = require('undici');
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;

const TCP_CONNECT_TIMEOUT_MS = parseInt(process.env.PROXY_TCP_CONNECT_TIMEOUT_MS || '4000', 10);
const HTTP_REQUEST_TIMEOUT_MS = parseInt(process.env.PROXY_HTTP_REQUEST_TIMEOUT_MS || '6000', 10);
const OVERALL_PER_PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_OVERALL_TIMEOUT_MS || '12000', 10);
const DNS_LOOKUP_TIMEOUT_MS = parseInt(process.env.PROXY_DNS_TIMEOUT_MS || '3000', 10);
const USER_AGENT = process.env.PROXY_TEST_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} setelah ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// ============================================================
// HTTP/HTTPS proxy via undici ProxyAgent
// ============================================================
async function fetchThroughHttpProxy(proxy, targetUrl, timeoutMs) {
  const fullProxyUrl = proxy.username
    ? `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@${proxy.host}:${proxy.port}`
    : `http://${proxy.host}:${proxy.port}`;

  const dispatcher = new ProxyAgent({
    uri: fullProxyUrl,
    connectTimeout: TCP_CONNECT_TIMEOUT_MS,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(targetUrl, {
      dispatcher,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,text/plain,*/*' },
      redirect: 'manual',
    });
    const body = await res.text();
    return { status: res.status, body, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// SOCKS5 handshake
// ============================================================
function socks5Connect(proxy, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: proxy.port, host: proxy.host, timeout: TCP_CONNECT_TIMEOUT_MS });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      reject(err);
    };
    const succeed = (s) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    socket.setTimeout(TCP_CONNECT_TIMEOUT_MS);
    socket.once('timeout', () => fail(new Error(`SOCKS5: TCP connect timeout (${TCP_CONNECT_TIMEOUT_MS}ms)`)));
    socket.once('error', (err) => fail(err));

    socket.once('connect', () => {
      const hasAuth = !!proxy.username;
      const greeting = hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00]);
      let stage = 'greeting';
      let authSent = false, connectSent = false;
      const handshakeTimer = setTimeout(() => fail(new Error(`SOCKS5: handshake timeout (${timeoutMs}ms)`)), timeoutMs);

      const onData = (chunk) => {
        try {
          if (stage === 'greeting') {
            if (chunk[0] !== 0x05) throw new Error('Invalid SOCKS5 version');
            const method = chunk[1];
            if (method === 0x00) { stage = 'connect'; sendConnect(); }
            else if (method === 0x02) { stage = 'auth'; sendAuth(); }
            else throw new Error('SOCKS5 method not supported: ' + method);
          } else if (stage === 'auth') {
            if (chunk[0] !== 0x01) throw new Error('Invalid auth version');
            if (chunk[1] !== 0x00) throw new Error('SOCKS5 auth failed');
            stage = 'connect'; sendConnect();
          } else if (stage === 'connect') {
            if (chunk[0] !== 0x05) throw new Error('Invalid SOCKS5 version in connect reply');
            if (chunk[1] !== 0x00) throw new Error('SOCKS5 connect failed: rep=' + chunk[1]);
            clearTimeout(handshakeTimer);
            socket.off('data', onData);
            socket.setTimeout(0);
            succeed(socket);
          }
        } catch (e) {
          clearTimeout(handshakeTimer);
          fail(e);
        }
      };

      function sendAuth() {
        if (authSent) return;
        authSent = true;
        const u = Buffer.from(proxy.username || '', 'utf8');
        const p = Buffer.from(proxy.password || '', 'utf8');
        socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      }

      function sendConnect() {
        if (connectSent) return;
        connectSent = true;
        const hostBuf = Buffer.from(targetHost, 'utf8');
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]));
      }

      socket.on('data', onData);
      socket.write(greeting);
    });
  });
}

// ============================================================
// SOCKS4 handshake
// ============================================================
function socks4Connect(proxy, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ipMatch = targetHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipMatch) { reject(new Error('SOCKS4 only supports IPv4 targets')); return; }
    const socket = net.connect({ port: proxy.port, host: proxy.host, timeout: TCP_CONNECT_TIMEOUT_MS });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      reject(err);
    };
    const succeed = (s) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    socket.setTimeout(TCP_CONNECT_TIMEOUT_MS);
    socket.once('timeout', () => fail(new Error(`SOCKS4: TCP connect timeout`)));
    socket.once('error', (err) => fail(err));

    socket.once('connect', () => {
      const ipBytes = Buffer.from([parseInt(ipMatch[1],10), parseInt(ipMatch[2],10), parseInt(ipMatch[3],10), parseInt(ipMatch[4],10)]);
      const portBytes = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
      const userid = Buffer.from(proxy.username || '', 'utf8');
      socket.write(Buffer.concat([Buffer.from([0x04, 0x01]), portBytes, ipBytes, userid, Buffer.from([0x00])]));
      const handshakeTimer = setTimeout(() => fail(new Error('SOCKS4: handshake timeout')), timeoutMs);
      socket.once('data', (chunk) => {
        clearTimeout(handshakeTimer);
        if (chunk[0] !== 0x00) { fail(new Error('Invalid SOCKS4 reply')); return; }
        if (chunk[1] !== 0x5a) { fail(new Error('SOCKS4 connect failed: code=' + chunk[1])); return; }
        socket.setTimeout(0);
        succeed(socket);
      });
    });
  });
}

// ============================================================
// HTTP request via SOCKS proxy
// ============================================================
async function fetchThroughSocksProxy(proxy, targetUrl, timeoutMs) {
  const url = new URL(targetUrl);
  const targetHost = url.hostname;
  const targetPort = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
  const useTls = url.protocol === 'https:';

  const start = Date.now();
  let socket;
  if (proxy.protocol === 'socks5') {
    socket = await withTimeout(socks5Connect(proxy, targetHost, targetPort, timeoutMs), timeoutMs, 'SOCKS5 connect');
  } else {
    socket = await withTimeout(socks4Connect(proxy, targetHost, targetPort, timeoutMs), timeoutMs, 'SOCKS4 connect');
  }

  let stream = socket;
  if (useTls) {
    stream = tls.connect({ socket, servername: targetHost });
    await withTimeout(new Promise((resolve, reject) => {
      stream.once('secureConnect', () => resolve());
      stream.once('error', (e) => reject(e));
    }), timeoutMs, 'TLS handshake');
  }

  const pathAndQuery = url.pathname + (url.search || '');
  const reqLines = [
    `GET ${pathAndQuery || '/'} HTTP/1.1`,
    `Host: ${targetHost}`,
    `User-Agent: ${USER_AGENT}`,
    `Accept: application/json,text/plain,*/*`,
    `Connection: close`,
    ``, ``,
  ];
  stream.write(Buffer.from(reqLines.join('\r\n'), 'utf8'));
  if (stream.end) stream.end();

  const rawResponse = await new Promise((resolve, reject) => {
    const chunks = [];
    const t = setTimeout(() => { try { stream.destroy(); } catch {}; reject(new Error('Response read timeout')); }, timeoutMs);
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => { clearTimeout(t); resolve(Buffer.concat(chunks).toString('utf8')); });
    stream.on('error', (e) => { clearTimeout(t); reject(e); });
  });
  const latencyMs = Date.now() - start;

  const headerEndIdx = rawResponse.indexOf('\r\n\r\n');
  const headerPart = headerEndIdx >= 0 ? rawResponse.slice(0, headerEndIdx) : rawResponse;
  let bodyPart = headerEndIdx >= 0 ? rawResponse.slice(headerEndIdx + 4) : '';
  const headers = headerPart.split('\r\n');
  const statusLine = headers[0] || '';
  const statusMatch = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  const isChunked = headers.some((h) => h.toLowerCase().startsWith('transfer-encoding:') && h.toLowerCase().includes('chunked'));
  if (isChunked) bodyPart = decodeChunked(bodyPart);
  return { status, body: bodyPart, latencyMs };
}

function decodeChunked(body) {
  let result = '', i = 0;
  while (i < body.length) {
    const lineEnd = body.indexOf('\r\n', i);
    if (lineEnd < 0) break;
    const size = parseInt(body.slice(i, lineEnd).trim(), 16);
    if (isNaN(size) || size === 0) break;
    i = lineEnd + 2;
    result += body.slice(i, i + size);
    i += size + 2;
  }
  return result;
}

async function fetchThroughProxy(proxy, targetUrl, timeoutMs) {
  timeoutMs = timeoutMs || HTTP_REQUEST_TIMEOUT_MS;
  if (proxy.protocol === 'http' || proxy.protocol === 'https') {
    return fetchThroughHttpProxy(proxy, targetUrl, timeoutMs);
  }
  return fetchThroughSocksProxy(proxy, targetUrl, timeoutMs);
}

// ============================================================
// Get server's own IP (cached)
// ============================================================
let cachedServerIp = null;
async function getServerIp() {
  if (cachedServerIp) return cachedServerIp;
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    cachedServerIp = data.ip || null;
    return cachedServerIp;
  } catch { return null; }
}

// ============================================================
// Geolocation + proxy/hosting flag
// ============================================================
async function getGeoThroughProxy(proxy, timeoutMs) {
  try {
    const r = await fetchThroughProxy(proxy, 'http://ip-api.com/json/?fields=query,country,countryCode,city,isp,org,as,proxy,hosting', timeoutMs);
    if (r.status >= 200 && r.status < 400 && r.body) {
      try {
        const j = JSON.parse(r.body);
        if (j.query) {
          return {
            exitIp: j.query || '',
            country: j.country || '',
            countryCode: j.countryCode || '',
            city: j.city || '',
            isp: j.isp || '',
            org: j.org || '',
            as: j.as || '',
            isProxy: j.proxy === true ? true : j.proxy === false ? false : null,
            isHosting: j.hosting === true ? true : j.hosting === false ? false : null,
          };
        }
      } catch {}
    }
  } catch {}
  // Fallback: ipwho.is
  try {
    const r = await fetchThroughProxy(proxy, 'https://ipwho.is/', timeoutMs);
    if (r.status >= 200 && r.status < 400 && r.body) {
      const j = JSON.parse(r.body);
      if (j.success !== false && j.ip) {
        return {
          exitIp: j.ip || '',
          country: j.country || '',
          countryCode: j.country_code || '',
          city: j.city || '',
          isp: j.connection && j.connection.isp || '',
          org: j.connection && j.connection.org || '',
          as: j.connection && j.connection.asn ? `AS${j.connection.asn}` : '',
          isProxy: null, isHosting: null,
        };
      }
    }
  } catch {}
  return null;
}

// ============================================================
// Blacklist check via DNSBL
// ============================================================
const BLACKLISTS = [
  { name: 'zen.spamhaus.org' },
  { name: 'bl.spamcop.net' },
  { name: 'dnsbl.sorbs.net' },
  { name: 'b.barracudacentral.org' },
];

async function checkBlacklist(ip) {
  if (!ip) return { blacklisted: false, sources: [] };
  const parts = ip.split('.');
  if (parts.length !== 4) return { blacklisted: false, sources: [] };
  const reversed = parts.reverse().join('.');
  const flagged = [];
  await Promise.all(BLACKLISTS.map(async (bl) => {
    try {
      const records = await withTimeout(dns.resolve4(`${reversed}.${bl.name}`).catch(() => []), DNS_LOOKUP_TIMEOUT_MS, `DNSBL ${bl.name}`);
      if (records.length > 0) flagged.push(bl.name);
    } catch {}
  }));
  return { blacklisted: flagged.length > 0, sources: flagged };
}

function detectAnonymity(serverIp, exitIp, isProxyFlag) {
  if (!exitIp) return 'unknown';
  if (serverIp && exitIp === serverIp) return 'transparent';
  if (isProxyFlag === true) return 'anonymous';
  return 'elite';
}

function assessAdsterraSafety(blacklisted, dnsLeak, anonymity, qualityScore) {
  if (blacklisted === true) return 'unsafe';
  if (anonymity === 'transparent') return 'unsafe';
  if (dnsLeak === true) return 'risky';
  if (anonymity === 'anonymous' && qualityScore < 70) return 'risky';
  if (qualityScore < 50) return 'risky';
  if (anonymity === 'elite' && !blacklisted && qualityScore >= 70) return 'safe';
  return 'unknown';
}

function calculateQualityScore(params) {
  if (!params.ok) return 0;
  let score = 50;
  if (params.latencyMs < 1000) score += 20;
  else if (params.latencyMs < 3000) score += 15;
  else if (params.latencyMs < 6000) score += 8;
  else if (params.latencyMs > 8000) score -= 10;
  if (params.anonymity === 'elite') score += 20;
  else if (params.anonymity === 'anonymous') score += 10;
  else if (params.anonymity === 'transparent') score -= 30;
  if (params.blacklisted === false) score += 10;
  if (params.blacklisted === true) score = 0;
  if (params.dnsLeak === false) score += 5;
  if (params.dnsLeak === true) score -= 15;
  return Math.max(0, Math.min(100, score));
}

function getServerDnsResolver() {
  try {
    const servers = dns.getServers();
    return servers[0] || null;
  } catch { return null; }
}

// ============================================================
// Main test function (with overall timeout)
// ============================================================
async function testProxyInner(proxy) {
  const start = Date.now();
  const result = {
    ok: false, latencyMs: 0,
    exitIp: null, exitCountry: null, exitCity: null, exitIsp: null,
    anonymity: 'unknown', dnsLeak: null, dnsServer: null, webRtcLeak: null,
    blacklisted: null, blacklistSources: [],
    adsterraSafe: 'unknown', qualityScore: 0,
    error: null, raw: {},
  };

  try {
    const serverIp = await getServerIp();
    result.raw.serverIp = serverIp;

    const geo = await getGeoThroughProxy(proxy, HTTP_REQUEST_TIMEOUT_MS);
    if (!geo || !geo.exitIp) {
      result.error = 'Tidak dapat terhubung ke proxy atau proxy tidak merespons (cek host:port dan kredensial)';
      result.latencyMs = Date.now() - start;
      return result;
    }

    result.exitIp = geo.exitIp;
    result.exitCountry = geo.countryCode || geo.country || null;
    result.exitCity = geo.city || null;
    result.exitIsp = geo.isp || geo.org || null;
    result.latencyMs = Date.now() - start;
    result.ok = true;
    result.raw.geo = geo;

    result.anonymity = detectAnonymity(serverIp, result.exitIp, geo.isProxy);
    result.dnsServer = getServerDnsResolver();
    result.dnsLeak = null;

    const bl = await checkBlacklist(result.exitIp);
    result.blacklisted = bl.blacklisted;
    result.blacklistSources = bl.sources;

    result.qualityScore = calculateQualityScore({
      ok: result.ok, latencyMs: result.latencyMs,
      anonymity: result.anonymity, blacklisted: result.blacklisted, dnsLeak: result.dnsLeak,
    });
    result.adsterraSafe = assessAdsterraSafety(result.blacklisted, result.dnsLeak, result.anonymity, result.qualityScore);
    result.webRtcLeak = null;
    return result;
  } catch (e) {
    result.error = e.message || 'Unknown error';
    result.latencyMs = Date.now() - start;
    result.ok = false;
    return result;
  }
}

async function testProxy(proxy) {
  return withTimeout(testProxyInner(proxy), OVERALL_PER_PROXY_TIMEOUT_MS, 'Overall proxy test').catch((e) => {
    const msg = e.message || String(e);
    return {
      ok: false, latencyMs: OVERALL_PER_PROXY_TIMEOUT_MS,
      exitIp: null, exitCountry: null, exitCity: null, exitIsp: null,
      anonymity: 'unknown', dnsLeak: null, dnsServer: null, webRtcLeak: null,
      blacklisted: null, blacklistSources: [],
      adsterraSafe: 'unknown', qualityScore: 0,
      error: msg.startsWith('Timeout') ? `Test timeout (${OVERALL_PER_PROXY_TIMEOUT_MS}ms)` : msg,
      raw: { timeout: true },
    };
  });
}

module.exports = {
  testProxy,
  getServerIp,
  OVERALL_PER_PROXY_TIMEOUT_MS,
};
