/**
 * 统一配置加载
 *
 * 所有站点的配置都放在 config/config.js 里, 不再依赖环境变量。
 * (环境变量仍作为兼容回退保留, 配置文件优先)
 *
 * 配置文件查找顺序:
 *   1. 环境变量 CONFIG_FILE 指定的路径 (可选, 便于放 /ql/data/config/)
 *   2. <项目>/config/config.js
 *   3. <项目>/config/config.json
 *
 * 配置结构见 config/config.example.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 配置文件候选路径 */
function configCandidates() {
  const list = [];
  const custom = (process.env.CONFIG_FILE || '').trim();
  if (custom) list.push(custom);
  list.push(path.join(ROOT, 'config', 'config.js'));
  list.push(path.join(ROOT, 'config', 'config.json'));
  return list;
}

let cached; // undefined = 未加载, null = 没有配置文件

/**
 * 读取配置文件
 * @returns {{file: string, data: object}|null}
 */
function loadConfig() {
  if (cached !== undefined) return cached;

  for (const file of configCandidates()) {
    if (!fs.existsSync(file)) continue;

    let data;
    try {
      if (file.toLowerCase().endsWith('.json')) {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } else {
        // eslint-disable-next-line global-require
        data = require(file);
        if (data && data.__esModule && data.default) data = data.default;
      }
    } catch (e) {
      throw new Error(
        `读取配置文件失败: ${file}\n  ${e.message}\n` +
        '请检查语法, JS 文件应为 module.exports = { ... }'
      );
    }

    cached = { file, data: data && typeof data === 'object' ? data : {} };
    return cached;
  }

  cached = null;
  return null;
}

/** 取某站点配置段, 没有则返回 null */
function getSection(name) {
  const cfg = loadConfig();
  if (!cfg) return null;
  const section = cfg.data[name];
  if (section === undefined || section === null) return null;
  return section;
}

/** 把配置段规范成数组 (支持 [..] 或 { accounts: [..] }) */
function toAccountList(section) {
  if (Array.isArray(section)) return section;
  if (section && Array.isArray(section.accounts)) return section.accounts;
  return null;
}

/**
 * 加载 Isvoro 账户
 * @returns {Array|null} null 表示配置文件里没有该站点, 由调用方回退到环境变量
 */
function loadIsvoroAccounts(logger) {
  const section = getSection('isvoro');
  if (section === null) {
    // 没有配置文件 / 配置里没有 isvoro 段 → 交给调用方回退到环境变量
    const cfg = loadConfig();
    if (!cfg && logger && !(process.env.ISVORO_ACCOUNTS || '').trim()) {
      logger.info(
        '未找到配置文件 config/config.js, 也没有环境变量 ISVORO_ACCOUNTS\n' +
        '  配置方法: 复制 config/config.example.js 为 config/config.js, 填好 isvoro.accounts'
      );
    }
    return null;
  }

  const list = toAccountList(section);
  if (list === null) {
    if (logger) logger.warn('配置文件的 isvoro 段格式不对, 应为 accounts: [...]');
    return null;
  }

  const accounts = list
    .filter(a => a && typeof a === 'object')
    .map((a, i) => ({ ...a, name: a.name || `Isvoro账号#${i + 1}`, _source: loadConfig().file }));

  if (logger) {
    if (accounts.length) {
      logger.info(`已加载 Isvoro 配置: ${loadConfig().file} (${accounts.length} 个账号)`);
    } else {
      logger.warn('配置文件里 isvoro.accounts 是空的, 跳过 Isvoro');
    }
  }
  return accounts;
}

module.exports = {
  loadConfig,
  getSection,
  toAccountList,
  loadIsvoroAccounts,
  configCandidates,
};
