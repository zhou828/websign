/**
 * 统一配置加载
 *
 * 所有站点的配置都放在 config/config.yaml 里, 不需要环境变量。
 * (环境变量仍作为兼容回退保留, 配置文件优先)
 *
 * 配置文件查找顺序 (命中即用):
 *   1. 环境变量 CONFIG_FILE 指定的路径 (可选, 便于放 /ql/data/config/)
 *   2. <项目>/config/config.yaml
 *   3. <项目>/config/config.yml
 *   4. <项目>/config/config.json   (兼容)
 *   5. <项目>/config/config.js     (兼容旧版)
 *
 * 配置结构见 config/config.example.yaml
 */

const fs = require('fs');
const path = require('path');
const { loadYaml } = require('./yaml');

const ROOT = path.join(__dirname, '..');

/** 配置文件候选路径 */
function configCandidates() {
  const list = [];
  const custom = (process.env.CONFIG_FILE || '').trim();
  if (custom) list.push(custom);
  list.push(path.join(ROOT, 'config', 'config.yaml'));
  list.push(path.join(ROOT, 'config', 'config.yml'));
  list.push(path.join(ROOT, 'config', 'config.json'));
  list.push(path.join(ROOT, 'config', 'config.js'));
  return list;
}

/** 读取并解析单个配置文件 */
function readConfigFile(file) {
  const ext = path.extname(file).toLowerCase();

  if (ext === '.js' || ext === '.cjs') {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(file);
    const data = mod && mod.__esModule && mod.default ? mod.default : mod;
    return data && typeof data === 'object' ? data : {};
  }

  const text = fs.readFileSync(file, 'utf8');

  if (ext === '.json') return JSON.parse(text);
  if (ext === '.yaml' || ext === '.yml') return loadYaml(text);

  // 未知扩展名: 按内容猜 (以 { 开头当 JSON, 否则当 YAML)
  return text.trimStart().startsWith('{') ? JSON.parse(text) : loadYaml(text);
}

/** 解析失败时给对应格式的排查提示 */
function parseHint(file, err) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.cjs') {
    return '请检查语法, JS 配置文件应写成 module.exports = { ... }';
  }
  if (ext === '.json') {
    return '请检查 JSON 语法: 不能有注释, 不能有结尾逗号, 引号必须是英文双引号';
  }
  if (err && err.isYamlError) {
    return '请检查这一行的缩进 (只能用空格) 和引号是否成对';
  }
  return '请检查缩进 (只能用空格, 建议 2 个空格一级)、冒号后要有空格、引号是否成对';
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
      data = readConfigFile(file);
    } catch (e) {
      throw new Error(
        `读取配置文件失败: ${file}\n  ${e.message}\n${parseHint(file, e)}`
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

/** 没有配置文件时的统一提示 */
function missingConfigHint() {
  return (
    '未找到配置文件 config/config.yaml\n' +
    '  配置方法: 复制模板后填写\n' +
    '    cp config/config.example.yaml config/config.yaml'
  );
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
      logger.info(`${missingConfigHint()}\n  填好 isvoro.accounts 后重跑即可`);
    }
    return null;
  }

  const list = toAccountList(section);
  if (list === null) {
    if (logger) logger.warn('配置文件的 isvoro 段格式不对, 应为 isvoro: → accounts: 列表');
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
  missingConfigHint,
};
