/**
 * Telegram 配置加载
 *
 * 设计目标:
 *   1. session 是长字符串且含 + / = 等字符, 塞进 JSON 容易出错
 *      → 拆成独立环境变量 TELEGRAM_SESSION, 不参与任何 JSON 解析
 *   2. bot 列表可能很长, 放环境变量难维护
 *      → 放到 config/telegram.js (或 TELEGRAM_CONFIG 指定的路径)
 *
 * 查找顺序:
 *   1. 环境变量 TELEGRAM_CONFIG 指定的文件
 *   2. <项目>/config/telegram.js
 *   3. <项目>/config/telegram.json
 *   4. 都没有 → 回退到旧版 TELEGRAM_ACCOUNTS (JSON, 兼容老用户)
 *
 * 环境变量:
 *   TELEGRAM_API_ID      api_id (纯数字)
 *   TELEGRAM_API_HASH    api_hash
 *   TELEGRAM_SESSION     session 字符串
 *   多账号时用后缀: TELEGRAM_API_ID_2 / TELEGRAM_API_HASH_2 / TELEGRAM_SESSION_2
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 配置文件候选路径 */
function configCandidates() {
  const list = [];
  const custom = (process.env.TELEGRAM_CONFIG || '').trim();
  if (custom) list.push(custom);
  list.push(path.join(ROOT, 'config', 'telegram.js'));
  list.push(path.join(ROOT, 'config', 'telegram.json'));
  return list;
}

/** 读取配置文件, 返回 { file, entries } 或 null */
function loadConfigFile() {
  for (const file of configCandidates()) {
    if (!fs.existsSync(file)) continue;

    let mod;
    try {
      if (file.toLowerCase().endsWith('.json')) {
        mod = JSON.parse(fs.readFileSync(file, 'utf8'));
      } else {
        mod = require(file);
        if (mod && mod.__esModule && mod.default) mod = mod.default;
      }
    } catch (e) {
      throw new Error(
        `读取 Telegram 配置文件失败: ${file}\n  ${e.message}\n` +
        '请检查文件语法 (JS 文件需 module.exports = [...])'
      );
    }

    let entries;
    if (Array.isArray(mod)) entries = mod;
    else if (mod && Array.isArray(mod.accounts)) entries = mod.accounts;
    else if (mod && typeof mod === 'object') entries = [mod];
    else entries = [];

    return { file, entries: entries.filter(Boolean) };
  }
  return null;
}

/**
 * 清理 session: 去掉所有空白字符
 * StringSession 本身是 base64url, 不含空格, 粘贴时带进来的换行/空格会导致解析失败
 */
function normalizeSession(v) {
  return String(v || '').replace(/\s+/g, '');
}

function envValue(name) {
  return (process.env[name] || '').trim();
}

/** 解析旧版 TELEGRAM_ACCOUNTS (JSON) */
function parseLegacy(logger) {
  const raw = (process.env.TELEGRAM_ACCOUNTS || '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const accounts = arr
      .filter(a => a && typeof a === 'object')
      .map((a, i) => ({
        name: a.name || `TG账号#${i + 1}`,
        api_id: a.api_id,
        api_hash: a.api_hash,
        session: normalizeSession(a.session),
        proxy: a.proxy,
        notify: a.notify,
        bots: a.bots,
        _source: 'TELEGRAM_ACCOUNTS (旧版 JSON)',
      }));
    if (accounts.length && logger) {
      logger.warn(
        '检测到旧版 TELEGRAM_ACCOUNTS 配置, 仍可使用。\n' +
        '  建议改用: 环境变量 TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION + config/telegram.js\n' +
        '  session 放在 JSON 里容易因特殊字符解析失败。'
      );
    }
    return accounts;
  } catch (e) {
    if (logger) logger.warn(`TELEGRAM_ACCOUNTS 解析失败 (${e.message}), 已忽略`);
    return [];
  }
}

/**
 * 加载 Telegram 账号列表
 * @param {object} logger 运行器日志对象
 * @returns {Array} 账号配置数组
 */
function loadTelegramAccounts(logger) {
  let cfg = null;
  try {
    cfg = loadConfigFile();
  } catch (e) {
    throw e;
  }

  if (!cfg) {
    const legacy = parseLegacy(logger);
    if (legacy.length) return legacy;

    if (logger) {
      logger.info(
        '未找到 Telegram 配置, 跳过。\n' +
        '  配置方法:\n' +
        '    1. 青龙环境变量设置 TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION\n' +
        '    2. 复制 config/telegram.example.js 为 config/telegram.js, 填好 bots\n' +
        '       (或放到 /ql/data/config/telegram.js 并设 TELEGRAM_CONFIG 指向它)'
      );
    }
    return [];
  }

  if (logger) logger.info(`已加载 Telegram 配置: ${cfg.file} (${cfg.entries.length} 个账号)`);

  const accounts = [];
  cfg.entries.forEach((entry, idx) => {
    const suffix = entry.envSuffix ? String(entry.envSuffix).trim() : '';

    const apiId = entry.api_id || envValue(`TELEGRAM_API_ID${suffix}`);
    const apiHash = entry.api_hash || envValue(`TELEGRAM_API_HASH${suffix}`);
    const session = normalizeSession(entry.session || envValue(`TELEGRAM_SESSION${suffix}`));

    const missing = [];
    if (!apiId) missing.push(`TELEGRAM_API_ID${suffix}`);
    if (!apiHash) missing.push(`TELEGRAM_API_HASH${suffix}`);
    if (!session) missing.push(`TELEGRAM_SESSION${suffix}`);

    if (missing.length && logger) {
      logger.warn(
        `${entry.name || `账号#${idx + 1}`} 缺少环境变量: ${missing.join(', ')}\n` +
        '  这 3 个值由 telegram-login.js 生成, 请到青龙环境变量里补上。'
      );
    }

    accounts.push({
      name: entry.name || `TG账号#${idx + 1}`,
      api_id: apiId,
      api_hash: apiHash,
      session,
      proxy: entry.proxy || envValue(`TELEGRAM_PROXY${suffix}`) || undefined,
      notify: entry.notify || undefined,
      bots: Array.isArray(entry.bots) ? entry.bots : [],
      _source: cfg.file,
    });
  });

  return accounts;
}

module.exports = { loadTelegramAccounts, normalizeSession, loadConfigFile, configCandidates };
