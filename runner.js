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
   *
   * 支持以下格式 (按优先级):
   *   1. JSON 数组:   [{"cookie":"..."},{"cookie":"..."}]
   *   2. JSON 对象:   {"cookie":"..."} 或 {"email":"...","password":"..."}
   *   3. 纯 Cookie:   pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz
   *   4. email:pass:  a@b.com:pass123  多账户用 & 或换行分隔
   */
  parseAccounts(envKey) {
    const raw = process.env[envKey];
    if (!raw) return [];

    const trimmed = raw.trim();

    // ── 1/2. 尝试 JSON 解析 ──
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'object' && parsed !== null) return [parsed];
      } catch (e) {
        this.logger.warn(`JSON 解析失败 (${e.message}), 尝试其他格式...`);
      }
    }

    // ── 3. 纯 Cookie 字符串 (包含 key=value; 形式) ──
    if (/pmt_|session|token|csrf/i.test(trimmed) && /[=]/.test(trimmed)) {
      const lines = trimmed.split(/\n/).map(s => s.trim()).filter(Boolean);

      // 判断是否多账户: 每一行都必须独立含关键认证 cookie
      const isMultiAccount = lines.length > 1 &&
        lines.every(l => /(pmt_access|pmt_refresh|session|token)\s*=/i.test(l));

      if (isMultiAccount) {
        return lines.map(c => ({ cookie: c }));
      }

      // 单账户: 把换行当分隔符合并 (用户粘贴的 cookie 可能被换行拆开)
      const merged = lines.join('; ').replace(/;\s*;/g, ';');
      return [{ cookie: merged }];
    }

    // ── 4. email:password 格式, 多账户用 & 或换行分隔 ──
    const entries = trimmed.split(/[&\n]/).map(s => s.trim()).filter(Boolean);
    const accounts = [];
    for (const entry of entries) {
      const idx = entry.indexOf(':');
      if (idx > 0) {
        const email = entry.substring(0, idx).trim();
        const password = entry.substring(idx + 1).trim();
        if (email && password) {
          accounts.push({ email, password });
        }
      }
    }

    // ── 5. 兜底: 无法识别, 整串当作 cookie ──
    if (accounts.length === 0 && /[=]/.test(trimmed)) {
      this.logger.warn('无法识别配置格式, 整串按 Cookie 处理');
      return [{ cookie: trimmed }];
    }

    return accounts;
  }

  /**
   * 执行单个站点的所有账户签到
   */
  async runSite(siteKey, siteConfig) {
    const logger = this.logger.child(siteConfig.label);
    // 站点可自带账户加载逻辑 (读配置文件); 返回 null 表示配置文件里没有该站点, 回退到环境变量
    let accounts = null;
    if (typeof siteConfig.loadAccounts === 'function') {
      accounts = siteConfig.loadAccounts(logger);
    }
    if (accounts === null || accounts === undefined) {
      accounts = this.parseAccounts(siteConfig.envKey);
    }

    if (accounts.length === 0) {
      logger.info('未配置账户, 跳过');
      return { site: siteConfig.label, total: 0, success: 0, fail: 0, results: [] };
    }

    logger.info(`共 ${accounts.length} 个账户`);

    const results = [];
    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const accLogger = this.logger.child(`${siteConfig.label}#${i + 1}`);
      // 账户标识: 优先 name/email/username/phone, 再次通用序号
      const accLabel = account.name || account.email || account.username || account.phone || `账户#${i + 1}`;
      accLogger.info(`开始处理: ${accLabel}`);

      try {
        const handler = new siteConfig.handler(account, accLogger);
        const result = await handler.runCheckin();

        results.push({
          email: accLabel,
          success: true,
          skipped: !!result.skipped,
          message: result.skipped ? '今日已签到' : '签到成功',
        });
        if (result.skipped) {
          skipCount++;
        } else {
          successCount++;
        }
      } catch (err) {
        // 详细错误输出, 便于排查 (err.message 可能为空)
        const errMsg = err && err.message ? err.message : String(err);
        accLogger.error(`签到失败: ${errMsg}`);
        if (err && err.stack) {
          accLogger.error(`错误堆栈: ${err.stack}`);
        } else {
          accLogger.error(`原始错误对象: ${JSON.stringify(err)}`);
        }
        results.push({
          email: accLabel,
          success: false,
          message: errMsg,
        });
        failCount++;
      }
    }

    logger.info(
      `完成: 成功 ${successCount}` +
      (skipCount > 0 ? `, 已签到 ${skipCount}` : '') +
      `, 失败 ${failCount}`
    );
    return {
      site: siteConfig.label,
      total: accounts.length,
      success: successCount,
      skip: skipCount,
      fail: failCount,
      results,
    };
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
    let totalSkip = 0;
    let totalFail = 0;
    for (const r of allResults) {
      this.logger.info(
        `${r.site}: 成功 ${r.success}/${r.total}` +
        (r.skip > 0 ? `, 已签到 ${r.skip}` : '') +
        (r.fail > 0 ? `, 失败 ${r.fail}` : '')
      );
      totalSuccess += r.success;
      totalSkip += r.skip || 0;
      totalFail += r.fail;
    }
    this.logger.info(
      `总计: 成功 ${totalSuccess}` +
      (totalSkip > 0 ? `, 已签到 ${totalSkip}` : '') +
      `, 失败 ${totalFail}`
    );

    // 如果有失败, 退出码非零 (青龙面板可以识别)
    if (totalFail > 0) {
      process.exitCode = 1;
    }
  }
}

module.exports = { SiteCheckinRunner, Logger };
