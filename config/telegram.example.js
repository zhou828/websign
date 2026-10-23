/**
 * Telegram 签到配置示例
 *
 * 使用方法:
 *   1. 复制本文件为 config/telegram.js  (去掉 .example)
 *   2. 把 bots 换成你实际要签到的 bot / 群组 / 频道
 *   3. api_id / api_hash / session 不要写在这里, 放到青龙环境变量:
 *        TELEGRAM_API_ID
 *        TELEGRAM_API_HASH
 *        TELEGRAM_SESSION
 *
 * 也可以把本文件放到任意位置, 然后用环境变量 TELEGRAM_CONFIG 指向它:
 *   TELEGRAM_CONFIG=/ql/data/config/telegram.js
 *   (推荐放 /ql/data/config/, 这样更新脚本不会覆盖你的配置)
 *
 * 多账号: 数组里加多个对象, 第二个账号用 envSuffix: '_2',
 *         对应环境变量 TELEGRAM_API_ID_2 / TELEGRAM_API_HASH_2 / TELEGRAM_SESSION_2
 */

module.exports = [
  {
    // 显示在日志里的名字
    name: '主账号',

    // 环境变量后缀, 空字符串表示读 TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION
    envSuffix: '',

    // 可选: 代理 (GramJS 只支持 SOCKS5)。不填则自动读 TG_PROXY / HTTPS_PROXY / ALL_PROXY
    proxy: 'socks5://127.0.0.1:10808',

    // 可选: 签到结束后把汇总发到这个频道/群。只在有失败时推送可写成 { target, onlyOnFailure: true }
    notify: '',

    // ── 签到目标列表 ──
    // 私聊 bot:  { username: 'aaa_bot', command: '/checkin' }
    // 群组签到:  { target: '@my_group', command: '/checkin', botUsername: 'aaa_bot' }
    // 私有群:    { target: '-1001234567890', command: '/qd', botUsername: 'bbb_bot' }
    // 按钮式:    { username: 'ccc_bot', command: '/start', clickButton: '签到' }
    bots: [
      { username: 'aaa_bot', command: '/checkin' },
      { username: 'bbb_bot', command: '/daily sign' },
      // { target: '@my_group', command: '/checkin', botUsername: 'ccc_bot' },
      // { target: '-1001234567890', command: '/qd', botUsername: 'ddd_bot' },
      // { username: 'eee_bot', command: ['/start', '/checkin'], clickButton: '签到' },
    ],
  },

  // ── 第二个账号示例 ──
  // {
  //   name: '小号',
  //   envSuffix: '_2',
  //   bots: [
  //     { username: 'aaa_bot', command: '/checkin' },
  //   ],
  // },
];
