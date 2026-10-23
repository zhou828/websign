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
 *   TELEGRAM_ACCOUNTS - Telegram bot 签到配置 (可选)
 *     给多个 bot 发送各自的签到命令。Telegram 禁止 bot 之间通信,
 *     因此用个人账号 (MTProto) 身份发送, 需要先运行 telegram-login.js 生成 session。
 *
 *     {
 *       "api_id": 123456,
 *       "api_hash": "0123456789abcdef0123456789abcdef",
 *       "session": "1BVtsOK...",
 *       "proxy": "socks5://127.0.0.1:10808",
 *       "bots": [
 *         { "username": "aaa_bot", "command": "/checkin" },
 *         { "username": "bbb_bot", "command": "/daily sign", "waitSeconds": 10 },
 *         { "username": "ccc_bot", "command": ["/start", "/checkin"], "clickButton": "签到" }
 *       ]
 *     }
 *
 *     多账号写成数组: [{...}, {...}]
 *     bots 也支持简写: ["aaa_bot:/checkin", "bbb_bot /daily"]
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
    envKey: 'TELEGRAM_ACCOUNTS',
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
