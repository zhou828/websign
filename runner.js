/**
 * 签到运行器
 *
 * 负责解析环境变量、实例化各站点处理器、执行签到、汇总结果。
 */

class Logger {
  constructor(prefix = '') {
    this.prefix = prefix ? `[${prefix}] ` : '';
  }

  _ts() {
    return new Date().toLocaleString('zh-CN', { hour12: false });
  }

  info(...args) {
    console.log(`${this._ts()} ${this.prefix}ℹ️`, ...args);
  }

  warn(...args) {
    console.warn(`${this._ts()} ${this.prefix}⚠️`, ...args);
  }

  error(...args) {
    console.error(`${this._ts()} ${this.prefix}❌`, ...args);
  }

  success(...args) {
    console.log(`${this._ts()} ${this.prefix}✅`, ...args);
  }

  child(prefix) {
    return new Logger(prefix);
  }
}

class SiteCheckinRunner {
  /**
   * @param {object} siteRegistry  站点注册表
   *   { isvoro: { handler: IsvoroHandler, envKey: 'ISVORO_ACCOUNTS', label: 'Isvoro' } }
   */
  constructor(siteRegistry) {
    this.siteRegistry = siteRegistry;
    this.logger = new Logger('Runner');
  }

  /**
   * 从环境变量解析账户列表
   * 支持 JSON 数组、JSON 对象、也可多账户用 & 分隔
   */
  parseAccounts(envKey) {
    const raw = process.env[envKey];
    if (!raw) return [];

    const trimmed = raw.trim();

    // 尝试 JSON 解析
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'object') return [parsed];
    } catch {
      // 非 JSON, 尝试 & 分隔
    }

    // 支持 email:password 格式, 多账户用 & 或换行分隔
    const entries = trimmed.split(/[&\n]/).map(s => s.trim()).filter(Boolean);
    const accounts = [];
    for (const entry of entries) {
      const [email, password] = entry.split(':');
      if (email && password) {
        accounts.push({ email: email.trim(), password: password.trim() });
      }
    }

    return accounts;
  }

  /**
   * 执行单个站点的所有账户签到
   */
  async runSite(siteKey, siteConfig) {
    const logger = this.logger.child(siteConfig.label);
    const accounts = this.parseAccounts(siteConfig.envKey);

    if (accounts.length === 0) {
      logger.info('未配置账户, 跳过');
      return { site: siteConfig.label, total: 0, success: 0, fail: 0, results: [] };
    }

    logger.info(`共 ${accounts.length} 个账户`);

    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const accLogger = this.logger.child(`${siteConfig.label}#${i + 1}`);
      // 账户标识: 优先 email, 其次 username, 再次 cookie 模式提示
      const accLabel = account.email || account.username || account.name || `Cookie账户#${i + 1}`;
      accLogger.info(`开始处理: ${accLabel}`);

      try {
        const handler = new siteConfig.handler(account, accLogger);
        const result = await handler.runCheckin();

        results.push({
          email: accLabel,
          success: true,
          skipped: result.skipped,
          message: result.skipped ? '今日已签到' : '签到成功',
        });
        successCount++;
      } catch (err) {
        accLogger.error(`签到失败: ${err.message}`);
        results.push({
          email: accLabel,
          success: false,
          message: err.message,
        });
        failCount++;
      }
    }

    logger.info(`完成: 成功 ${successCount}, 失败 ${failCount}`);
    return { site: siteConfig.label, total: accounts.length, success: successCount, fail: failCount, results };
  }

  /**
   * 运行所有已注册站点
   */
  async runAll() {
    this.logger.info('===== 多站点自动签到 =====');

    const allResults = [];

    for (const [siteKey, siteConfig] of Object.entries(this.siteRegistry)) {
      this.logger.info(`\n${'='.repeat(40)}\n开始处理站点: ${siteConfig.label}\n${'='.repeat(40)}`);
      const result = await this.runSite(siteKey, siteConfig);
      allResults.push(result);
    }

    // 汇总
    this.logger.info('\n===== 签到汇总 =====');
    let totalSuccess = 0;
    let totalFail = 0;
    for (const r of allResults) {
      this.logger.info(`${r.site}: 成功 ${r.success}/${r.total}` +
        (r.fail > 0 ? `, 失败 ${r.fail}` : ''));
      totalSuccess += r.success;
      totalFail += r.fail;
    }
    this.logger.info(`总计: 成功 ${totalSuccess}, 失败 ${totalFail}`);

    // 如果有失败, 退出码非零 (青龙面板可以识别)
    if (totalFail > 0) {
      process.exitCode = 1;
    }
  }
}

module.exports = { SiteCheckinRunner, Logger };
