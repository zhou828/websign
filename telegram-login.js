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

  console.log('===== Telegram 登录助手 =====');
  console.log('api_id / api_hash 获取: https://my.telegram.org → API development tools\n');

  let apiId = process.env.TELEGRAM_API_ID || process.argv[2];
  let apiHash = process.env.TELEGRAM_API_HASH || process.argv[3];

  if (!apiId) apiId = await ask('api_id: ');
  if (!apiHash) apiHash = await ask('api_hash: ');

  if (!apiId || !apiHash) {
    console.error('❌ api_id / api_hash 不能为空');
    rl.close();
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(''),
    Number(apiId),
    String(apiHash),
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
    api_id: Number(apiId),
    api_hash: String(apiHash),
    session,
    bots: [
      { username: 'aaa_bot', command: '/checkin' },
      { username: 'bbb_bot', command: '/daily sign' },
    ],
  }, null, 2));
  console.log('\n把 bots 数组里的示例换成你实际要签到的 bot 和命令即可。');

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ 登录失败:', e && e.message ? e.message : e);
  process.exit(1);
});
