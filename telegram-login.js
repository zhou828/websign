#!/usr/bin/env node
/**
 * Telegram 登录助手 — 生成签到脚本所需的 session 字符串
 *
 * 用法 (在你自己的电脑上跑, 不要放青龙里跑, 因为需要交互输入验证码):
 *   npm install telegram
 *   node telegram-login.js --proxy socks5://127.0.0.1:10808
 *
 * 参数:
 *   [api_id] [api_hash]   可省略, 省略时交互式询问
 *   --proxy <url>         SOCKS5 代理 (GramJS 不支持 HTTP 代理), 国内必需
 *                         不写时自动读取 TG_PROXY / HTTPS_PROXY / ALL_PROXY
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
const { resolveProxy, toGramProxy, describeProxy } = require('./lib/telegram-proxy');

let TelegramClient;
let StringSession;
try {
  ({ TelegramClient } = require('telegram'));
  ({ StringSession } = require('telegram/sessions'));
} catch (e) {
  console.error('\n❌ 缺少 telegram 依赖, 先执行: npm install telegram\n');
  process.exit(1);
}

/** 取 --proxy 参数值 */
function getArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx > 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const prefixed = process.argv.find(a => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.split('=').slice(1).join('=');
  return '';
}

function createAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(String(a || '').trim())));
  return { rl, ask };
}

/** 给 promise 加超时, 避免网络不通时无限挂起 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || '操作'} 超时 (${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const { rl, ask } = createAsk();

  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log('用法: node telegram-login.js [api_id] [api_hash] [--proxy socks5://127.0.0.1:10808]');
    console.log('');
    console.log('  --proxy   指定 SOCKS5 代理 (GramJS 不支持 HTTP 代理)');
    console.log('            不写时会自动读取环境变量 TG_PROXY / HTTPS_PROXY / ALL_PROXY');
    console.log('');
    console.log('示例:');
    console.log('  node telegram-login.js --proxy socks5://127.0.0.1:10808');
    console.log('  node telegram-login.js 1234567 0123456789abcdef0123456789abcdef --proxy socks5://127.0.0.1:10808');
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

  // ── 代理 (GramJS 只支持 SOCKS5) ──
  const proxy = resolveProxy(getArgValue('--proxy'));
  const clientOpts = { connectionRetries: 3, timeout: 30 };
  if (proxy) clientOpts.proxy = toGramProxy(proxy);

  console.log('');
  console.log(`网络: ${describeProxy(proxy)}`);
  if (!proxy) {
    console.log('提示: 国内直连 Telegram 一般不通, 若卡住或报 ETIMEDOUT, 请加参数 --proxy socks5://127.0.0.1:10808');
  }
  console.log('');

  const client = new TelegramClient(
    new StringSession(''),
    Number(String(apiId).trim()),
    String(apiHash).trim(),
    clientOpts
  );

  console.log('正在连接 Telegram...\n');

  try {
    await withTimeout(client.connect(), 60000, '连接 Telegram');
  } catch (e) {
    console.error(`\n❌ 连接 Telegram 失败: ${e.message}`);
    console.error(`当前网络: ${describeProxy(proxy)}`);
    console.error('可能原因:');
    if (proxy) {
      console.error('  1. 该端口不支持 SOCKS5 (只开了 HTTP 代理) → 换成 SOCKS5 端口');
      console.error('     Clash 混合端口 7890 同时支持 HTTP 和 SOCKS5, 可以直接用');
    } else {
      console.error('  1. 直连不通 → 加代理参数: node telegram-login.js --proxy socks5://127.0.0.1:10808');
      console.error('     常见端口: v2rayN 10808 / Clash 7890 / SSR 1080');
    }
    console.error('  2. 代理没启动, 或端口填错');
    console.error('  3. 系统时间偏差超过 5 分钟, MTProto 会拒绝连接');
    console.error('\n验证代理是否可用: curl --socks5-hostname 127.0.0.1:10808 https://api.telegram.org');
    console.error('(返回 302 就说明 SOCKS5 正常)');
    rl.close();
    process.exit(1);
  }

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
