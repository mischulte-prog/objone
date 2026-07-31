/**
 * Proxy Parser Library (v2.0)
 * =====================================================================
 * Mendukung berbagai format umum proxy dari file .txt dan .json.
 *
 * Format teks (.txt) yang didukung (satu baris = satu proxy):
 *   1. host:port                                    -> http (default)
 *   2. protocol://host:port                         -> protocol
 *   3. protocol://user:pass@host:port               -> protocol + auth
 *   4. user:pass@host:port                          -> http + auth
 *   5. host:port:user:pass                          -> http + auth
 *   6. host:port:user:pass:protocol                 -> protocol + auth
 *   7. host:port:protocol                           -> protocol
 *   8. host:port:protocol:user:pass                 -> protocol + auth (NEW)
 *   9. host:port:country:protocol                   -> protocol + country (NEW)
 *  10. host:port:country:user:pass:protocol         -> full (NEW)
 *
 * Format separator alternatif (NEW v2.0):
 *   - space:    "socks5 1.2.3.4 1080"
 *   - tab:      "socks5\t1.2.3.4\t1080"
 *   - comma:    "socks5,1.2.3.4,1080"  (CSV)
 *   - pipe:     "socks5|1.2.3.4|1080"
 *   - semicolon:"socks5;1.2.3.4;1080"
 *
 * Format JSON yang didukung:
 *   A. Array string:        ["host:port", "http://1.2.3.4:8080"]
 *   B. Array object:        [{ "host":"1.2.3.4", "port":8080, "protocol":"http" }]
 *   C. Object with proxies: { "proxies": [...] }
 *   D. Mixed / partial:     { "ip":"1.2.3.4", "port":8080, "type":"socks5" }
 *
 * Field aliases JSON (NEW v2.0):
 *   - protocol | type | scheme | proto | proxy_type | kind | ptype | proxyType
 *   - host | ip | address | server | hostname | ip_address | ipAddress
 *   - port | p | prt
 *   - username | user | login
 *   - password | pass | pwd
 *   - country | cc | iso | country_code
 *   - Numeric type codes: 1=http, 2=https, 3=socks4, 4=socks4, 5=socks5, 6=socks5
 */

const VALID_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];

// Alias untuk protocol di JSON
const PROTOCOL_ALIASES = {
  'socks': 'socks5',
  'socks5h': 'socks5',
  'socks4a': 'socks4',
  'http_proxy': 'http',
  'https_proxy': 'https',
  'ssl': 'https',
  'tls': 'https',
  'h': 'http',
  's': 'https',
};

// Numeric type codes → protocol (beberapa proxy list pakai angka)
const NUMERIC_TYPE_MAP = {
  1: 'http',
  2: 'https',
  3: 'socks4',
  4: 'socks4',
  5: 'socks5',
  6: 'socks5',
};

function normalizeProtocol(proto) {
  if (!proto) return 'http';
  let p = String(proto).trim().toLowerCase().replace(/:$/, '');
  // Buang suffix umum seperti "proxy" atau "_proxy"
  p = p.replace(/_?proxy$/, '');
  if (VALID_PROTOCOLS.includes(p)) return p;
  if (PROTOCOL_ALIASES[p]) return PROTOCOL_ALIASES[p];
  // Coba ekstrak kata protocol dari string campuran (mis. "socks5_proxy" → "socks5")
  for (const valid of VALID_PROTOCOLS) {
    if (p.includes(valid)) return valid;
  }
  return 'http';
}

/**
 * Deteksi apakah sebuah string adalah keyword protocol yang valid.
 * Menerima: http, https, socks4, socks5, socks, socks5h, socks4a (case-insensitive)
 */
function isProtocolKeyword(s) {
  if (!s) return false;
  const p = String(s).trim().toLowerCase().replace(/:$/, '').replace(/_?proxy$/, '');
  if (VALID_PROTOCOLS.includes(p)) return true;
  if (PROTOCOL_ALIASES[p]) return true;
  return false;
}

function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function isValidHost(host) {
  if (!host) return false;
  const h = host.trim();
  if (h.length === 0 || h.length > 253) return false;
  if (h.startsWith('[') && h.endsWith(']')) return h.length > 2;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  if (ipv4.test(h)) {
    return h.split('.').every((octet) => Number(octet) <= 255);
  }
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(h);
}

/**
 * Cek apakah string mirip country code (2-3 huruf uppercase).
 */
function isCountryCode(s) {
  if (!s) return false;
  return /^[A-Z]{2,3}$/.test(String(s).trim());
}

/**
 * Parse satu baris dengan multiple strategies.
 */
function parseLine(rawLine, defaultSource) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;

  let cleaned = line.replace(/^["']|["']$/g, '').trim();
  if (!cleaned) return null;

  // Buang trailing inline comment (mis. "socks5://1.2.3.4:1080 #fast" → "socks5://1.2.3.4:1080")
  // Hanya jika spasi sebelum #, untuk hindari konflik dengan password
  cleaned = cleaned.replace(/\s+#.*$/, '').trim();
  if (!cleaned) return null;

  // === Strategy 1: URL-like format protocol://[user:pass@]host:port ===
  // Handles: socks5://1.2.3.4:1080, http://user:pass@host:port, etc.
  const urlLike = cleaned.match(/^(?:(\w+):\/\/)?(?:([^\s:@/]+):([^\s:@/]+)@)?([^:/@\s]+|\[[0-9a-fA-F:]+\]):(\d{1,5})(?:\/.*)?$/i);
  if (urlLike) {
    let host = urlLike[4];
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    const port = parseInt(urlLike[5], 10);
    const protocol = urlLike[1] ? normalizeProtocol(urlLike[1]) : 'http';
    if (!isValidHost(host) || !isValidPort(port)) return null;
    return {
      protocol,
      host,
      port,
      username: urlLike[2] || null,
      password: urlLike[3] || null,
      country: null,
      source: defaultSource || null,
      note: null,
    };
  }

  // === Strategy 2: smart colon-separated parsing ===
  // Coba berbagai format colon-separated dengan deteksi protocol di posisi manapun
  const colonParts = cleaned.split(':').map(p => p.trim()).filter(Boolean);
  if (colonParts.length >= 2 && isValidHost(colonParts[0]) && isValidPort(parseInt(colonParts[1], 10))) {
    const host = colonParts[0];
    const port = parseInt(colonParts[1], 10);
    const rest = colonParts.slice(2);

    // Scan rest untuk keyword protocol di posisi manapun
    let protocol = 'http';
    let protocolIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      if (isProtocolKeyword(rest[i])) {
        protocol = normalizeProtocol(rest[i]);
        protocolIdx = i;
        break;
      }
    }

    // Buang elemen protocol dari rest
    const remaining = rest.slice();
    if (protocolIdx >= 0) remaining.splice(protocolIdx, 1);

    // Sisa: bisa [], [user], [user, pass], [country], [country, user, pass], dll
    let username = null, password = null, country = null;

    if (remaining.length === 0) {
      // host:port atau host:port:protocol — tidak ada field tambahan
    } else if (remaining.length === 1) {
      // Bisa country code atau username
      if (isCountryCode(remaining[0])) {
        country = remaining[0];
      } else {
        username = remaining[0];
      }
    } else if (remaining.length === 2) {
      // user:pass atau country:user (jarang) — asumsikan user:pass
      // Kecuali jika remaining[0] country code & remaining[1] panjang (country + note?)
      if (isCountryCode(remaining[0]) && remaining[1].length > 30) {
        country = remaining[0];
        username = remaining[1];
      } else {
        username = remaining[0];
        password = remaining[1];
      }
    } else if (remaining.length === 3) {
      // country:user:pass atau user:pass:country
      if (isCountryCode(remaining[0])) {
        country = remaining[0];
        username = remaining[1];
        password = remaining[2];
      } else if (isCountryCode(remaining[2])) {
        username = remaining[0];
        password = remaining[1];
        country = remaining[2];
      } else {
        // user:pass:note atau user:pass:something — ambil 2 pertama
        username = remaining[0];
        password = remaining[1];
      }
    } else {
      // >3 sisa: ambil 2 pertama sebagai user:pass, sisanya ignore
      // Kecuali jika ada country code di posisi manapun
      for (let i = 0; i < remaining.length; i++) {
        if (isCountryCode(remaining[i])) {
          country = remaining[i];
          remaining.splice(i, 1);
          break;
        }
      }
      if (remaining.length >= 1) username = remaining[0];
      if (remaining.length >= 2) password = remaining[1];
    }

    return {
      protocol, host, port, username, password, country,
      source: defaultSource || null, note: null,
    };
  }

  // === Strategy 3: separator alternatif (space, comma, pipe, semicolon, tab) ===
  // Handles: "socks5 1.2.3.4 1080", "socks5,1.2.3.4,1080", "1.2.3.4|1080|socks5"
  const sepParts = cleaned.split(/[\s,|;\t]+/).map(s => s.trim()).filter(Boolean);
  if (sepParts.length >= 2) {
    // Cari protocol
    let protocol = null;
    let protocolIdx = -1;
    for (let i = 0; i < sepParts.length; i++) {
      if (isProtocolKeyword(sepParts[i])) {
        protocol = normalizeProtocol(sepParts[i]);
        protocolIdx = i;
        break;
      }
    }

    // Cari port (angka 1-65535 murni)
    let port = null;
    let portIdx = -1;
    for (let i = 0; i < sepParts.length; i++) {
      if (i === protocolIdx) continue;
      if (/^\d{1,5}$/.test(sepParts[i])) {
        const n = parseInt(sepParts[i], 10);
        if (n > 0 && n <= 65535) {
          port = n;
          portIdx = i;
          break;
        }
      }
    }

    // Cari host (valid host, bukan angka murni, bukan protocol)
    let host = null;
    let hostIdx = -1;
    for (let i = 0; i < sepParts.length; i++) {
      if (i === protocolIdx || i === portIdx) continue;
      // Skip pure numbers (bisa jadi port alternatif)
      if (/^\d+$/.test(sepParts[i])) continue;
      if (isValidHost(sepParts[i])) {
        host = sepParts[i];
        hostIdx = i;
        break;
      }
    }

    if (host && port) {
      // Bagian tersisa: user, pass, country (sesuai urutan)
      const remaining = sepParts.filter((_, i) => i !== protocolIdx && i !== portIdx && i !== hostIdx);
      let username = null, password = null, country = null;

      if (remaining.length === 1) {
        if (isCountryCode(remaining[0])) {
          country = remaining[0];
        } else {
          username = remaining[0];
        }
      } else if (remaining.length >= 2) {
        // Cek apakah ada country code di posisi manapun
        for (let i = 0; i < remaining.length; i++) {
          if (isCountryCode(remaining[i])) {
            country = remaining[i];
            remaining.splice(i, 1);
            break;
          }
        }
        if (remaining.length >= 1) username = remaining[0];
        if (remaining.length >= 2) password = remaining[1];
      }

      return {
        protocol: protocol || 'http',
        host, port, username, password, country,
        source: defaultSource || null, note: null,
      };
    }
  }

  return null;
}

function parseTextContent(content, source) {
  const proxies = [];
  const errors = [];
  const lines = content.split(/\r?\n/);
  let lineNumber = 0;
  for (const rawLine of lines) {
    lineNumber++;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const parsed = parseLine(trimmed, source);
    if (parsed) {
      proxies.push(parsed);
      continue;
    }
    // Fallback: coba split by comma dan parse masing-masing (untuk multi-proxy per baris)
    const subItems = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    if (subItems.length > 1) {
      let anyParsed = false;
      for (const sub of subItems) {
        const sp = parseLine(sub, source);
        if (sp) { proxies.push(sp); anyParsed = true; }
      }
      if (anyParsed) continue;
    }
    errors.push({ line: lineNumber, raw: trimmed, reason: 'Format tidak dikenali' });
  }
  return { proxies, errors };
}

function parseJsonContent(content, source) {
  const proxies = [];
  const errors = [];
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    errors.push({ line: 0, raw: content.slice(0, 100), reason: `JSON parse error: ${e.message}` });
    return { proxies, errors };
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data;
    if (Array.isArray(obj.proxies)) data = obj.proxies;
    else if (Array.isArray(obj.list)) data = obj.list;
    else if (Array.isArray(obj.data)) data = obj.data;
    else if (Array.isArray(obj.items)) data = obj.items;
    else data = [data];
  }

  if (!Array.isArray(data)) {
    errors.push({ line: 0, raw: '', reason: 'Root JSON harus berupa array atau objek dengan field proxies/list/data/items' });
    return { proxies, errors };
  }

  data.forEach((item, idx) => {
    if (typeof item === 'string') {
      const p = parseLine(item, source);
      if (p) proxies.push(p);
      else errors.push({ line: idx + 1, raw: String(item), reason: 'Format string tidak valid' });
      return;
    }
    if (item && typeof item === 'object') {
      const obj = item;

      // Field aliases untuk host
      const host = String(obj.host || obj.ip || obj.address || obj.server || obj.hostname || obj.ip_address || obj.ipAddress || obj.addr || '').trim();

      // Field aliases untuk port
      const portRaw = obj.port || obj.p || obj.prt || obj.port_number || obj.portNumber;
      const port = Number(portRaw);

      if (host && isValidPort(port)) {
        // Field aliases untuk protocol — termasuk proxy_type, kind, ptype, proxyType
        let protoVal = obj.protocol || obj.type || obj.scheme || obj.proto || obj.proxy_type || obj.proxyType || obj.kind || obj.ptype || obj.p_type || obj.network || null;

        // Numeric type code: 1=http, 2=https, 3=socks4, 4=socks4, 5=socks5, 6=socks5
        if (typeof protoVal === 'number' && NUMERIC_TYPE_MAP[protoVal]) {
          protoVal = NUMERIC_TYPE_MAP[protoVal];
        } else if (typeof protoVal === 'string') {
          // Coba parse numeric string (mis. "5" → socks5)
          const numMatch = protoVal.trim().match(/^(\d+)$/);
          if (numMatch) {
            const n = parseInt(numMatch[1], 10);
            if (NUMERIC_TYPE_MAP[n]) protoVal = NUMERIC_TYPE_MAP[n];
          }
        }

        const protocol = normalizeProtocol(protoVal || 'http');

        const username = (obj.username || obj.user || obj.login || obj.u || obj.usr || null);
        const password = (obj.password || obj.pass || obj.pwd || obj.pw || null);
        const country = (obj.country || obj.cc || obj.iso || obj.country_code || obj.countryCode || obj.region || null);
        const note = (obj.note || obj.notes || obj.label || obj.name || obj.desc || obj.description || null);

        if (isValidHost(host)) {
          proxies.push({
            protocol,
            host,
            port,
            username: username ? String(username) : null,
            password: password ? String(password) : null,
            country: country ? String(country).toUpperCase() : null,
            source: source || null,
            note: note ? String(note) : null,
          });
          return;
        }
      }
      errors.push({ line: idx + 1, raw: JSON.stringify(item).slice(0, 200), reason: 'Objek tidak memiliki host/port valid' });
      return;
    }
    errors.push({ line: idx + 1, raw: String(item), reason: 'Tipe tidak didukung' });
  });

  return { proxies, errors };
}

function parseProxyContent(content, fileName) {
  const ext = fileName && fileName.toLowerCase().endsWith('.json') ? 'json'
    : fileName && fileName.toLowerCase().endsWith('.txt') ? 'txt'
    : null;
  const source = fileName || 'manual';
  const trimmed = content.trim();
  if (ext === 'json' || (ext === null && (trimmed.startsWith('[') || trimmed.startsWith('{')))) {
    return parseJsonContent(content, source);
  }
  return parseTextContent(content, source);
}

function formatProxyString(p) {
  let s = `${p.protocol}://`;
  if (p.username) {
    s += `${p.username}`;
    if (p.password) s += `:${p.password}`;
    s += '@';
  }
  if (p.host.includes(':') && !p.host.startsWith('[')) {
    s += `[${p.host}]:${p.port}`;
  } else {
    s += `${p.host}:${p.port}`;
  }
  return s;
}

module.exports = {
  parseProxyContent,
  parseTextContent,
  parseJsonContent,
  parseLine,
  formatProxyString,
  normalizeProtocol,
  isProtocolKeyword,
  isValidHost,
  isValidPort,
  VALID_PROTOCOLS,
};
