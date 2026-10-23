/**
 * 统一配置文件示例
 *
 * 使用方法:
 *   1. 复制本文件为 config/config.js  (去掉 .example)
 *   2. 按需填写下面的站点配置, 不需要的整段删掉即可
 *   3. 在青龙里跑一次 checkin.js
 *
 * 注意:
 *   - config/config.js 已加入 .gitignore, 不会提交到仓库 (里面全是敏感凭据)
 *   - 推荐放 /ql/data/config/config.js, 再设环境变量 CONFIG_FILE 指向它,
 *     避免订阅更新脚本时把配置覆盖掉
 *   - 环境变量仍然可用, 但配置文件优先级更高; 两处都没有才会跳过该站点
 */

module.exports = {
  // ══════════════════════════════════════════════════════════
  // Isvoro 签到
  // ══════════════════════════════════════════════════════════
  isvoro: {
    accounts: [
      {
        // 日志里显示的名字
        name: '主号',

        // Cookie 认证 (推荐): 浏览器登录 isvoro.com → F12 → Network → 任选 api/v1 请求
        // 复制 Request Headers 里的 Cookie 整行粘过来
        cookie: 'pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz',

        // 可选: 该账号单独用某个代理
        // proxy: 'http://127.0.0.1:7890',
      },

      // 密码登录 (需要验证码, 大概率失败, 不建议):
      // { name: '小号', email: 'a@b.com', password: 'xxx' },
    ],
  },

  // ══════════════════════════════════════════════════════════
  // Telegram 签到
  // 凭证由 telegram-login.js 生成, 直接粘到这里即可
  // ══════════════════════════════════════════════════════════
  telegram: [
    {
      name: '主账号',

      api_id: 1234567,
      api_hash: '0123456789abcdef0123456789abcdef',
      session: '1BVtsOK...',

      // 可选: SOCKS5 代理 (GramJS 只支持 SOCKS5, 不支持 HTTP)
      proxy: 'socks5://127.0.0.1:10808',

      // 可选: 签到汇总发到频道/群。只在失败时推送可写成 { target, onlyOnFailure: true }
      notify: '',

      // ── 签到目标 ──
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

    // ── 第二个 Telegram 账号 ──
    // {
    //   name: '小号',
    //   api_id: 7654321,
    //   api_hash: '...',
    //   session: '1BVtsOK...',
    //   bots: [{ username: 'aaa_bot', command: '/checkin' }],
    // },
  ],
};
