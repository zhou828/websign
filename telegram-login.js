#!/usr/bin/env node
/**
 * Telegram 登录助手 — 生成签到脚本所需的 session 字符串
 *
 * 用法 (在你自己的电脑上跑, 不要放青龙里跑, 因为需要交互输入验证码):
 *   npm install telegram
 *   node telegram-login.js
 *
 * 流程:
 *   1. 输入 api_id / api_hash  (https://my.telegram.org → API development tools)
 *   2. 输入手机号 (含国家码, 如 +8613800000000)
 *   3. 输入 Telegram 里收到的验证码
 *   4. 如果开了两步验证, 再输入密码
 *   5. 终端会打印一串 session 和一个可直接粘贴的 JSON 配置
 *
 * session 等于你的登录凭证, 请勿泄露给他人。
 */

const readline = require('readline');

let TelegramClient;
let StringSession;
try {
  ({ TelegramClient } = require('telegram'));
  ({ StringSession } = require('telegram/sessions'));
} catch (e) {
  console.error('\n❌ 缺少 telegram 依赖, 先执行: npm install telegram\n');
  process.exit(1);
}

function createAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(String(a || '').trim())));
  return { rl, ask };
}

async function main() {
  const { rl, ask } = createAsk();

  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log('用法: node telegram-login.js [api_id] [api_hash]');
    console.log('不带参数时会交互式询问。api_id/api_hash 从 https://my.telegram.org 获取。');
    rl.close();
    return;
  }

  console.log('===== Telegram 登录助手 =====');
  console.log('');
  console.log('需要两个值: api_id 和 api_hash');
  console.log('它们是 Telegram 发给「第三方客户端应用」的应用凭证 ——');
  console.log('不是手机号, 不是登录密码, 也不是 bot token。');
  console.log('');
  console.log('获取步骤:');
  console.log('  1. 浏览器打开 https://my.telegram.org  (国内需代理)');
  console.log('  2. 输入手机号(含国家码, 如 +8613800000000)');
  console.log('     验证码会发到 Telegram App 里名为「Telegram」的官方会话, 不是短信');
  console.log('  3. 登录后点 API development tools');
  console.log('  4. App title / Short name 随便填(如 websign / websign) → Create application');
  console.log('  5. 页面上 App api_id (一串数字) 和 App api_hash (32 位字符) 就是这两个值');
  console.log('');
  console.log('提示: 一个账号只需创建一次, 以后一直复用; 换 api_id 会让旧 session 失效。');
  console.log('');

  let apiId = process.env.TELEGRAM_API_ID || process.argv[2];
  let apiHash = process.env.TELEGRAM_API_HASH || process.argv[3];

  // api_id 必须是纯数字, 输错时重问
  for (let i = 0; i < 3; i++) {
    if (apiId) {
      if (/^\d+$/.test(String(apiId).trim())) break;
      console.log(`⚠️ api_id 必须是纯数字, 你输入的是「${apiId}」, 请重新输入`);
      apiId = '';
    }
    apiId = await ask('api_id (纯数字, 如 1234567): ');
  }
  if (!apiId || !/^\d+$/.test(String(apiId).trim())) {
    console.error('❌ api_id 格式不正确, 退出。请到 https://my.telegram.org 重新确认。');
    rl.close();
    process.exit(1);
  }

  if (!apiHash) apiHash = await ask('api_hash (32 位字符): ');
  if (!apiHash) {
    console.error('❌ api_hash 不能为空');
    rl.close();
    process.exit(1);
  }
  if (!/^[a-f0-9]{32}$/i.test(String(apiHash).trim())) {
    console.log(`⚠️ api_hash 通常是 32 位十六进制字符, 你输入的是 ${String(apiHash).length} 位, 请确认没粘错(继续执行)`);
  }

  const client = new TelegramClient(
    new StringSession(''),
    Number(String(apiId).trim()),
    String(apiHash).trim(),
    { connectionRetries: 5, timeout: 30 }
  );

  console.log('\n正在连接 Telegram...\n');

  await client.start({
    phoneNumber: async () => await ask('手机号 (含国家码, 如 +8613800000000): '),
    password: async () => await ask('两步验证密码 (没开启直接回车): '),
    phoneCode: async () => await ask('Telegram 收到的验证码: '),
    onError: (err) => console.error('⚠️ 登录过程提示:', err && err.message ? err.message : err),
  });

  const me = await client.getMe();
  const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || String(me.id);
  const session = client.session.save();

  console.log('\n===== 登录成功 =====');
  console.log(`账号: ${name} (@${me.username || '无用户名'})  id: ${me.id}`);
  console.log('\n----- session (请妥善保存, 不要外泄) -----');
  console.log(session);
  console.log('------------------------------------------');

  console.log('\n===== 可直接粘贴到青龙环境变量 TELEGRAM_ACCOUNTS 的配置 =====');
  console.log(JSON.stringify({
    api_id: Number(String(apiId).trim()),
    api_hash: String(apiHash).trim(),
    session,
    bots: [
      { username: 'aaa_bot', command: '/checkin' },
      { username: 'bbb_bot', command: '/daily sign' },
    ],
  }, null, 2));
  console.log('\n把 bots 数组里的示例换成你实际要签到的 bot 和命令即可。');
  console.log('群组签到加 "target": "@群用户名", 并补 "botUsername" 指明响应的 bot。');
  console.log('想把汇总推到频道, 在配置里加 "notify": "@你的频道"。');

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ 登录失败:', e && e.message ? e.message : e);
  process.exit(1);
});
