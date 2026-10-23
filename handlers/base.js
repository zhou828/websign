/**
 * 站点处理器基类
 *
 * 所有网站签到处理器继承此基类, 实现三个核心方法:
 *   1. login()         — 登录, 获取并保存认证凭据
 *   2. checkinStatus() — 查询签到状态 (可选, 用于判断是否已签到)
 *   3. doCheckin()      — 执行签到
 */
class SiteHandler {
  /**
   * @param {object} account  - 账户配置 (email, password 等)
   * @param {object} logger  - 日志对象
   */
  constructor(account, logger) {
    this.account = account;
    this.logger = logger;
    this.httpClient = null; // 子类在 login 中初始化
  }

  /**
   * 登录网站
   * 子类必须实现此方法, 完成登录并保存 Cookie/Token
   */
  async login() {
    throw new Error('子类必须实现 login()');
  }

  /**
   * 查询签到状态
   * 子类可选实现, 返回 { checkedIn: boolean, ... }
   */
  async checkinStatus() {
    return null;
  }

  /**
   * 执行签到
   * 子类必须实现此方法
   */
  async doCheckin() {
    throw new Error('子类必须实现 doCheckin()');
  }

  /**
   * 完整签到流程: 登录 → 查状态 → 签到
   */
  async runCheckin() {
    // 1. 登录
    await this.login();

    // 2. 查询签到状态
    let status = null;
    try {
      status = await this.checkinStatus();
      if (status && status.checkedIn) {
        this.logger.info('今日已签到, 跳过');
        return { success: true, skipped: true, status };
      }
    } catch (e) {
      this.logger.warn('查询签到状态失败, 继续尝试签到:', e.message);
    }

    // 3. 执行签到
    const result = await this.doCheckin();

    // 站点在 doCheckin 里发现"今天已经签过了" (例如服务端返回 ALREADY_CHECKED_IN),
    // 这属于正常情况, 不能算失败, 否则整个任务会被标成失败
    if (result && result.alreadyChecked) {
      return { success: true, skipped: true, status, result };
    }

    return { success: true, skipped: false, status, result };
  }
}

module.exports = { SiteHandler };
