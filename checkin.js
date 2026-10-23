/**
 * 多站点自动签到脚本 (青龙面板)
 *
 * 环境变量配置:
 *   ISVORO_ACCOUNTS  - isvoro 账户配置, JSON 格式
 *
 *   方式一 Cookie 认证 (推荐, 绕过 hCaptcha 验证码):
 *     {"cookie":"pmt_csrf=你的csrf值"}
 *     (从浏览器 F12 → Application → Cookies 获取)
 *
 *   方式二 密码登录 (可能被验证码拦截):
 *     {"email":"user@example.com","password":"pass123"}
 *
 *   多账户示例:
 *     [{"cookie":"pmt_csrf=xxx"},{"cookie":"pmt_csrf=yyy"}]
 *
 *   TELEGRAM_*  - Telegram 签到 (可选, 分两部分配置)
 *
 *     1) 环境变量只放 3 个凭证 (session 单独一个变量, 不经过 JSON 解析, 不会因特殊字符出错):
 *          TELEGRAM_API_ID      一串数字
 *          TELEGRAM_API_HASH    32 位字符
 *          TELEGRAM_SESSION     telegram-login.js 生成的长串
 *        多账号用后缀: TELEGRAM_API_ID_2 / TELEGRAM_API_HASH_2 / TELEGRAM_SESSION_2
 *
 *     2) bot 列表放配置文件 config/telegram.js (或 TELEGRAM_CONFIG 指定的路径):
 *          module.exports = [
 *            {
 *              name: '主账号',
 *              envSuffix: '',
 *              proxy: 'socks5://127.0.0.1:10808',
 *              notify: '@my_channel',
 *              bots: [
 *                { username: 'aaa_bot', command: '/checkin' },
 *                { username: 'bbb_bot', command: '/daily sign', waitSeconds: 10 },
 *                { username: 'ccc_bot', command: ['/start', '/checkin'], clickButton: '签到' },
 *                { target: '@my_group', command: '/checkin', botUsername: 'ddd_bot' },
 *                { target: '-1001234567890', command: '/qd', botUsername: 'eee_bot' },
 *              ],
 *            },
 *          ];
 *
 *     目标写法: 用户名 / t.me 链接 / 数字 id (-100 开头为私有群频道)
 *     频道里 bot 不响应命令, 频道只用于 notify 接收签到汇总
 *
 *     旧的 TELEGRAM_ACCOUNTS (JSON) 仍兼容, 但已不推荐。
 *
 * 架构说明:
 *   本脚本采用「站点处理器」架构, 每个网站实现一个 SiteHandler 接口,
 *   包含 login / checkinStatus / doCheckin 三个方法。
 *   要新增其他网站签到, 只需:
 *   1. 在 handlers/ 目录下新建对应站点处理器文件
 *   2. 在 siteRegistry 中注册
 *   3. 添加对应的环境变量配置
 *
 * cron: 30 8 * * *
 */

const { IsvoroHandler } = require('./handlers/isvoro');
const { TelegramHandler } = require('./handlers/telegram');
const { loadTelegramAccounts } = require('./lib/telegram-config');
const { SiteCheckinRunner } = require('./runner');

// ============================================================
// 站点注册表 — 新增网站在这里注册
// ============================================================
const siteRegistry = {
  isvoro: {
    handler: IsvoroHandler,
    envKey: 'ISVORO_ACCOUNTS',  // 青龙环境变量名
    label: 'Isvoro',
  },
  telegram: {
    handler: TelegramHandler,
    // Telegram 的 bot 列表放在 config/telegram.js, 环境变量只存 api_id/api_hash/session
    loadAccounts: loadTelegramAccounts,
    envKey: 'TELEGRAM_ACCOUNTS', // 仅作为旧版 JSON 配置的兼容回退
    label: 'Telegram',
  },
  // ── 预留其他网站 ──
  // example: {
  //   handler: ExampleHandler,
  //   envKey: 'EXAMPLE_ACCOUNTS',
  //   label: 'ExampleSite',
  // },
};

// ============================================================
// 主入口
// ============================================================
async function main() {
  const runner = new SiteCheckinRunner(siteRegistry);
  await runner.runAll();
}

main().catch(err => {
  console.error('❌ 脚本执行异常:', err);
  process.exit(1);
});
