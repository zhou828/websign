/**
 * 多站点自动签到脚本 (青龙面板)
 *
 * 环境变量配置:
 *   ISVORO_ACCOUNTS  - isvoro 账户配置, JSON 数组格式
 *     格式: [{"email":"user@example.com","password":"pass123"}, ...]
 *     或单账户简写: {"email":"user@example.com","password":"pass123"}
 *
 *   示例 (多账户):
 *     export ISVORO_ACCOUNTS='[{"email":"a@test.com","password":"111"},{"email":"b@test.com","password":"222"}]'
 *
 *   示例 (单账户):
 *     export ISVORO_ACCOUNTS='{"email":"a@test.com","password":"111"}'
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
