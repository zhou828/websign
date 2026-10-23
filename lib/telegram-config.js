/**
 * Telegram 配置加载
 *
 * 优先从统一配置文件 config/config.yaml 的 telegram 段读取,
 * 其次读单独的 config/telegram.js, 最后回退到环境变量 (兼容旧版)。
 *
 * 设计目标:
 *   1. 所有配置集中在一个文件里, 不依赖环境变量
 *   2. session 是长字符串且含 + / = 等字符, 直接写在配置文件里, 不经过 JSON 序列化
 *
 * 环境变量 (可选, 仅作回退):
 *   TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION
 *   多账号用后缀: TELEGRAM_API_ID_2 / TELEGRAM_API_HASH_2 / TELEGRAM_SESSION_2
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, toAccountList } = require('./config');

const ROOT = path.join(__dirname, '..');

/** 单独的 telegram 配置文件候选路径 */
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
  // 1. 优先: 统一配置文件里的 telegram 段
  const unified = loadConfig();
  if (unified) {
    const section = unified.data ? unified.data.telegram : null;
    if (section) {
      const entries = toAccountList(section);
      if (entries === null) {
        throw new Error(
          `配置文件 ${unified.file} 的 telegram 段格式不对\n` +
          '应为列表:\n' +
          '  telegram:\n' +
          '    - name: 主账号\n' +
          '      api_id: 1234567'
        );
      }
      return { file: `${unified.file} → telegram`, entries: entries.filter(Boolean) };
    }

    // 配置文件存在但没有 telegram 段: 没有独立 telegram 配置时静默跳过
    if (!configCandidates().some(f => fs.existsSync(f))) {
      return { file: unified.file, entries: [], noSection: true };
    }
  }

  // 2. 其次: 单独的 config/telegram.js
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

    const entries = toAccountList(mod);
    if (entries === null) {
      throw new Error(`Telegram 配置文件 ${file} 格式不对, 应为数组 module.exports = [{...}]`);
    }
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
        '检测到旧版 TELEGRAM_ACCOUNTS 环境变量, 仍可使用。\n' +
        '  建议改用 config/config.yaml 的 telegram 段 (session 放 YAML 里不会因特殊字符出错)。'
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
        '  在 config/config.yaml 里加 telegram 段即可, 例如:\n' +
        '    telegram:\n' +
        '      - name: 主账号\n' +
        '        api_id: 1234567\n' +
        "        api_hash: '0123456789abcdef0123456789abcdef'\n" +
        "        session: '1BVtsOK...'\n" +
        '        bots:\n' +
        '          - username: aaa_bot\n' +
        '            command: /checkin'
      );
    }
    return [];
  }

  if (!cfg.entries.length) {
    if (logger) logger.info('配置文件里没有 telegram 段, 跳过 Telegram');
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
    if (!apiId) missing.push('api_id');
    if (!apiHash) missing.push('api_hash');
    if (!session) missing.push('session');

    if (missing.length && logger) {
      logger.warn(
        `${entry.name || `账号#${idx + 1}`} 缺少 ${missing.join(' / ')}\n` +
        `  请在配置文件里补上: ${cfg.file}\n` +
        '  这 3 个值由 telegram-login.js 生成 (也可用环境变量 TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION 提供)'
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
