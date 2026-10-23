#!/usr/bin/env node
/**
 * 列出 Telegram 账号加入的所有群组 / 频道, 方便填配置里的 target
 *
 * 用法:
 *   node list-groups.js                 # 列第 1 个账号的
 *   node list-groups.js --account 2     # 列第 2 个账号
 *   node list-groups.js --limit 800     # 最多拉多少个对话, 默认 500
 *
 * 依赖 config/config.yaml (或 /ql/data/config/websign.yaml) 里的 telegram 段,
 * 用里面的 api_id / api_hash / session 登录, 不需要交互输入。
 *
 * 输出里的 id 直接复制到配置的 target 即可:
 *   - target: '-1001234567890'
 *     text: '签到'
 *     botUsername: aaa_bot
 */

const { loadTelegramAccounts } = require('./lib/telegram-config');
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

const logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`⚠️  ${m}`),
  error: (m) => console.error(`❌ ${m}`),
  success: (m) => console.log(`✅ ${m}`),
};

function argValue(name, def) {
  const idx = process.argv.indexOf(name);
  if (idx > 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.split('=').slice(1).join('=');
  return def;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 (${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 中文按 2 个字符宽计算, 用于对齐 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function pad(s, width) {
  const str = String(s);
  return str + ' '.repeat(Math.max(0, width - dispWidth(str)));
}

/** entity → 配置里能直接用的 peer id */
function peerIdOf(entity) {
  const cls = entity.className;
  if (cls === 'Channel' || cls === 'ChannelForbidden') return Number(`-100${entity.id}`);
  if (cls === 'Chat' || cls === 'ChatForbidden') return -entity.id;
  return entity.id;
}

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log('用法: node list-groups.js [--account N] [--limit 500]');
    console.log('');
    console.log('  --account N   用配置里第 N 个 Telegram 账号 (默认 1)');
    console.log('  --limit N     最多拉取多少个对话 (默认 500)');
    console.log('');
    console.log('列出账号加入的所有群组/频道, 输出可直接填到配置的 target。');
    return;
  }

  const accounts = loadTelegramAccounts(logger);
  if (!accounts.length) {
    console.error('\n没有找到 Telegram 配置。');
    console.error('先在 config/config.yaml 里填好 telegram 段 (api_id / api_hash / session)。');
    process.exit(1);
  }

  const idx = Math.max(1, Number(argValue('--account', 1)) || 1) - 1;
  const acc = accounts[idx];
  if (!acc) {
    console.error(`配置里只有 ${accounts.length} 个 Telegram 账号, 没有第 ${idx + 1} 个`);
    process.exit(1);
  }
  if (!acc.api_id || !acc.api_hash || !acc.session) {
    console.error(`账号「${acc.name}」缺少 api_id / api_hash / session, 先跑 telegram-login.js`);
    process.exit(1);
  }

  const limit = Math.max(10, Number(argValue('--limit', 500)) || 500);
  const proxy = resolveProxy(acc.proxy);

  console.log(`账号: ${acc.name}`);
  console.log(`网络: ${describeProxy(proxy)}`);
  console.log('正在连接 Telegram...\n');

  const opts = { connectionRetries: 2, timeout: 30 };
  if (proxy) opts.proxy = toGramProxy(proxy);

  const client = new TelegramClient(
    new StringSession(acc.session),
    Number(acc.api_id),
    String(acc.api_hash),
    opts
  );

  try {
    await withTimeout(client.connect(), 60000, '连接 Telegram');
  } catch (e) {
    console.error(`❌ 连接失败: ${e.message}`);
    console.error('   国内一般需要 SOCKS5 代理, 在配置里给该账号加 proxy: \'socks5://127.0.0.1:10808\'');
    process.exit(1);
  }

  let dialogs;
  try {
    dialogs = await withTimeout(client.getDialogs({ limit }), 90000, '拉取对话列表');
  } catch (e) {
    console.error(`❌ 拉取对话列表失败: ${e.message}`);
    await client.disconnect().catch(() => {});
    process.exit(1);
  }

  const groups = [];
  const channels = [];

  for (const d of dialogs || []) {
    const entity = d.entity;
    if (!entity) continue;
    const cls = entity.className;
    if (cls !== 'Channel' && cls !== 'Chat' && cls !== 'ChannelForbidden' && cls !== 'ChatForbidden') continue;

    const isChannel = cls === 'Channel' || cls === 'ChannelForbidden';
    const item = {
      title: entity.title || d.title || '(无名称)',
      id: peerIdOf(entity),
      username: entity.username ? `@${entity.username}` : '',
      // 超级群在 GramJS 里也是 Channel, 用 megagroup 区分
      megagroup: Boolean(entity.megagroup),
    };
    (isChannel && !item.megagroup ? channels : groups).push(item);
  }

  const byTitle = (a, b) => a.title.localeCompare(b.title, 'zh-CN');
  groups.sort(byTitle);
  channels.sort(byTitle);

  const width = Math.min(
    40,
    Math.max(12, ...[...groups, ...channels].map((x) => dispWidth(x.title)))
  );

  const printRows = (rows) => {
    for (const r of rows) {
      console.log(
        `  ${pad(r.title, width)}  ${pad(String(r.id), 18)} ${r.username || '(私有, 无用户名)'}`
      );
    }
  };

  console.log(`共 ${groups.length} 个群组, ${channels.length} 个频道\n`);

  if (groups.length) {
    console.log(`群组 (可以在里面发签到内容)`);
    console.log(`  ${pad('名称', width)}  ${pad('id', 18)} 用户名`);
    console.log(`  ${'-'.repeat(width)}  ${'-'.repeat(18)} ${'-'.repeat(20)}`);
    printRows(groups);
    console.log('');
  }

  if (channels.length) {
    console.log(`频道 (bot 不响应命令, 只能用来接收 notify 汇总)`);
    console.log(`  ${pad('名称', width)}  ${pad('id', 18)} 用户名`);
    console.log(`  ${'-'.repeat(width)}  ${'-'.repeat(18)} ${'-'.repeat(20)}`);
    printRows(channels);
    console.log('');
  }

  if (!groups.length && !channels.length) {
    console.log('没找到群组或频道。可能这个账号还没加入任何群, 或者 session 对应的不是这个账号。');
  } else {
    console.log('把 id 复制到配置里, 例如:');
    console.log('');
    console.log('  bots:');
    console.log("    - target: '-1001234567890'");
    console.log("      text: '签到'");
    console.log('      botUsername: aaa_bot      # 群里响应签到的是哪个 bot');
    console.log('      mentionBot: true          # 自动补成 签到 @aaa_bot');
    console.log('');
    console.log('注意: 这里的 id 是「你的账号已经加入的」群, 没加入的群看不到。');
  }

  await client.disconnect().catch(() => {});
}

main().catch((e) => {
  console.error('\n❌ 执行失败:', e && e.message ? e.message : e);
  process.exit(1);
});
