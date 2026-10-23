/**
 * 多站点自动签到脚本 (青龙面板)
 *
 * ── 配置方式 ───────────────────────────────────────────────
 * 所有配置都写在同一个 YAML 文件里, 不需要任何环境变量:
 *
 *     cp config/config.example.yaml config/config.yaml
 *     然后编辑 config/config.yaml
 *
 * 文件结构 (每一项的说明都写在模板的注释里):
 *
 *   isvoro:                      网站签到
 *     accounts:
 *       - name: 主号
 *         cookie: 'pmt_access=...; pmt_refresh=...; pmt_csrf=...'
 *         proxy: 'http://127.0.0.1:7890'      # 可选
 *
 *   telegram:                    Telegram bot / 群组签到
 *     - name: 主账号
 *       api_id: 1234567                       # my.telegram.org 申请, 纯数字
 *       api_hash: '32位字符'
 *       session: 'telegram-login.js 生成的长串'
 *       proxy: 'socks5://127.0.0.1:10808'     # 可选
 *       notify: '@my_channel'                 # 可选, 签到汇总发这里
 *       bots:
 *         - username: aaa_bot
 *           command: /checkin
 *         - target: '@my_group'               # 群组签到
 *           command: /checkin
 *           botUsername: bbb_bot              # 群里必须指定哪个 bot 回复
 *
 * 目标写法: 用户名 / t.me 链接 / 数字 id (-100 开头为私有群频道)
 * 频道里 bot 不响应命令, 频道只用于 notify 接收签到汇总
 *
 * 配置文件查找顺序 (命中即用):
 *   1. 环境变量 CONFIG_FILE 指定的路径 (可选, 一般不用)
 *   2. config/config.yaml
 *   3. config/config.yml
 *   4. config/config.json / config.js (兼容旧版)
 *
 * 兼容旧部署: 配置文件不存在时, 仍会回退读取
 *   ISVORO_ACCOUNTS / TELEGRAM_ACCOUNTS 环境变量 (JSON)。
 *
 * 架构说明:
 *   本脚本采用「站点处理器」架构, 每个网站实现一个 SiteHandler 接口,
 *   包含 login / checkinStatus / doCheckin 三个方法。
 *   要新增其他网站签到, 只需:
 *   1. 在 handlers/ 目录下新建对应站点处理器文件
 *   2. 在 siteRegistry 中注册, 并在 lib/config.js 里加一个 loadXxxAccounts
 *   3. 在 config/config.yaml 里加对应的配置段
 *
 * cron: 30 8 * * *
 */

const { IsvoroHandler } = require('./handlers/isvoro');
const { TelegramHandler } = require('./handlers/telegram');
const { loadIsvoroAccounts } = require('./lib/config');
const { loadTelegramAccounts } = require('./lib/telegram-config');
const { SiteCheckinRunner } = require('./runner');

// ============================================================
// 站点注册表 — 新增网站在这里注册
// ============================================================
const siteRegistry = {
  isvoro: {
    handler: IsvoroHandler,
    loadAccounts: loadIsvoroAccounts, // 优先读 config/config.yaml, 没有则回退环境变量
    envKey: 'ISVORO_ACCOUNTS',        // 兼容旧部署
    label: 'Isvoro',
  },
  telegram: {
    handler: TelegramHandler,
    loadAccounts: loadTelegramAccounts,
    envKey: 'TELEGRAM_ACCOUNTS',      // 兼容旧版 JSON 配置
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
  const msg = err && err.message ? err.message : String(err);

  // 配置文件本身写错了: 只打印可读的错误位置, 不甩堆栈
  if (msg.startsWith('读取配置文件失败')) {
    console.error(`❌ 配置文件有误:\n${msg}`);
    process.exit(1);
  }

  console.error('❌ 脚本执行异常:', err);
  process.exit(1);
});
