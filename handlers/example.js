/**
 * 示例站点处理器 — 新网站签到模板
 *
 * 复制此文件, 修改为你的目标网站即可。
 * 步骤:
 *   1. 复制本文件为 handlers/yoursite.js
 *   2. 修改类名、API 端点、登录逻辑
 *   3. 在 checkin.js 的 siteRegistry 中注册
 *   4. 添加对应环境变量 (如 YOURSITE_ACCOUNTS)
 */

const { SiteHandler } = require('./base');

class ExampleHandler extends SiteHandler {
  constructor(account, logger) {
    super(account, logger);
    this.baseUrl = 'https://example.com';
  }

  /**
   * 登录
   */
  async login() {
    this.logger.info(`正在登录 Example: ${this.account.email}`);
    // TODO: 实现具体登录逻辑
    // 使用 fetch / axios / http 发送登录请求
    // 保存 Cookie / Token
    throw new Error('ExampleHandler 尚未实现, 请参考 isvoro.js 完成');
  }

  /**
   * 查询签到状态
   */
  async checkinStatus() {
    // TODO: 查询签到状态
    // 返回 { checkedIn: true/false } 表示今日是否已签到
    return null;
  }

  /**
   * 执行签到
   */
  async doCheckin() {
    // TODO: 调用签到 API
    throw new Error('ExampleHandler 尚未实现, 请参考 isvoro.js 完成');
  }
}

module.exports = { ExampleHandler };
