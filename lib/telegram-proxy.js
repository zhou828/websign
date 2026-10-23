/**
 * Telegram (GramJS) 代理解析 — 共享模块
 *
 * GramJS 只支持 SOCKS5 和 MTProxy, 不支持 HTTP 代理。
 * 签到处理器和登录助手都用这里的方法, 保证行为一致。
 */

/**
 * 字符串 → GramJS proxy 对象
 * 支持: socks5://ip:port / socks5://user:pass@ip:port / http://ip:port / ip:port / mtproxy://...
 * @param {string} str
 * @param {boolean} assumed 是否由 HTTP 代理推断而来 (仅用于日志提示)
 */
function parseProxy(str, assumed = false) {
  let s = String(str || '').trim();
  if (!s) return null;

  let assumedSocks = assumed;

  if (/^socks5?:\/\//i.test(s)) {
    s = s.replace(/^socks5?:\/\//i, '');
    assumedSocks = false;
  } else if (/^https?:\/\//i.test(s)) {
    s = s.replace(/^https?:\/\//i, '');
    assumedSocks = true; // HTTP 代理端口通常也开了 SOCKS, 先按 SOCKS5 试
  } else if (/^mtproxy:\/\//i.test(s)) {
    s = s.replace(/^mtproxy:\/\//i, '');
  }

  s = s.replace(/\/.*$/, ''); // 去掉路径

  let username;
  let password;
  const at = s.lastIndexOf('@');
  if (at > 0) {
    const auth = s.substring(0, at);
    s = s.substring(at + 1);
    const colon = auth.indexOf(':');
    if (colon > 0) {
      username = safeDecode(auth.substring(0, colon));
      password = safeDecode(auth.substring(colon + 1));
    } else {
      username = safeDecode(auth);
    }
  }

  const m = s.match(/^\[?([^\]]+?)\]?:(\d+)$/) || s.match(/^(.+):(\d+)$/);
  if (!m) return null;

  return cleanProxy({ ip: m[1], port: Number(m[2]), username, password }, assumedSocks);
}

/**
 * 规范化 proxy 对象, 只保留 GramJS 认识的字段
 */
function cleanProxy(obj, assumed = false) {
  if (!obj || !obj.ip || !obj.port) return null;
  const clean = {
    ip: String(obj.ip),
    port: Number(obj.port),
    socksType: Number(obj.socksType) || 5,
    timeout: Number(obj.timeout) || 10,
  };
  if (obj.username) clean.username = String(obj.username);
  if (obj.password) clean.password = String(obj.password);
  clean.assumed = !!assumed;
  return clean;
}

/**
 * 按优先级解析代理
 *   1. 显式传入 (配置里的 proxy / 命令行 --proxy)
 *   2. TG_PROXY / TELEGRAM_PROXY
 *   3. ALL_PROXY / HTTPS_PROXY / HTTP_PROXY (含小写)
 * @returns {object|null}
 */
function resolveProxy(explicit) {
  if (explicit) {
    const p = typeof explicit === 'object' ? cleanProxy(explicit, false) : parseProxy(explicit, false);
    if (p) return p;
  }

  for (const key of ['TG_PROXY', 'TELEGRAM_PROXY']) {
    const v = (process.env[key] || '').trim();
    if (v) {
      const p = parseProxy(v, false);
      if (p) return p;
    }
  }

  for (const key of ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const v = (process.env[key] || '').trim();
    if (!v || /^(none|false|0|null|direct)$/i.test(v)) continue;
    const p = parseProxy(v, true);
    if (p) return p;
  }

  return null;
}

/** 转成可直接给 GramJS 用的对象 (去掉自定义的 assumed 字段) */
function toGramProxy(proxy) {
  if (!proxy) return null;
  const { assumed, ...rest } = proxy;
  return rest;
}

/** 人类可读描述 */
function describeProxy(proxy) {
  if (!proxy) return '直连 (未配置代理)';
  return `SOCKS5 ${proxy.ip}:${proxy.port}${proxy.assumed ? ' (由 HTTP 代理配置推断)' : ''}`;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

module.exports = { parseProxy, cleanProxy, resolveProxy, toGramProxy, describeProxy };
