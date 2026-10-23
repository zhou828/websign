/**
 * Telegram Bot 签到处理器
 *
 * 场景: 需要给多个 Telegram bot 发送各自的签到命令 (每个 bot 命令不同)
 *
 * 重要说明:
 *   Telegram 禁止 bot 与 bot 互相通信, 所以不能用「自己的 bot」去给目标 bot 发消息。
 *   本处理器使用「用户账号」(MTProto 协议) 登录, 以你自己的身份向目标 bot 发送命令,
 *   这是唯一可行且稳定的方式。
 *
 * 前置条件:
 *   1. 申请 api_id / api_hash: https://my.telegram.org → API development tools
 *   2. 用 telegram-login.js 生成 session 字符串 (只需一次)
 *   3. 青龙安装依赖: 依赖管理 → Nodejs → 安装 `telegram`
 *
 * 配置格式 (环境变量 TELEGRAM_ACCOUNTS):
 *   {
 *     "api_id": 123456,
 *     "api_hash": "abcdef0123456789",
 *     "session": "1BVtsOK...",
 *     "bots": [
 *       { "username": "aaa_bot", "command": "/checkin" },
 *       { "username": "bbb_bot", "command": "/daily sign", "waitSeconds": 10 },
 *       { "username": "ccc_bot", "command": "/start", "clickButton": "签到" }
 *     ]
 *   }
 *
 * 每个 bot 支持的字段:
 *   username      必填, bot 用户名 (可带 @)
 *   command       必填, 要发送的命令; 数组形式可发多条, 如 ["/start", "/checkin"]
 *   clickButton   可选, 若 bot 回复带内联按钮, 自动点击文字匹配的按钮 (如 "签到")
 *   waitSeconds   可选, 等待 bot 回复的秒数, 默认 8
 *   successKeywords / skipKeywords / failKeywords  可选, 自定义结果关键词
 *   enabled       可选, 设为 false 可临时跳过该 bot
 */

const { SiteHandler } = require('./base');

const DEFAULTS = {
  waitSeconds: 8,
  pollIntervalMs: 2000,
  betweenBotsMs: 1500,
  skipKeywords: ['已签到', '已经签到', '重复签到', '今日已', 'already'],
  failKeywords: ['失败', '错误', '异常', '无效', '过期', '不支持', 'error', 'failed'],
  successKeywords: ['成功', '获得', '已领取', '签到完成', 'success'],
};

class TelegramHandler extends SiteHandler {
  constructor(account, logger) {
    super(account, logger);
    this.account = account;
    this.client = null;
    this.tg = null;
  }

  /**
   * 懒加载 telegram 依赖 (未配置 TG 时不影响其他站点)
   * 优先 gramjs 官方包 telegram, 其次其活跃分支 teleproto (API 兼容)
   */
  _loadTg() {
    if (this.tg) return this.tg;
    const errors = [];
    for (const pkg of ['telegram', 'teleproto']) {
      try {
        // eslint-disable-next-line global-require
        const main = require(pkg);
        // eslint-disable-next-line global-require
        const sessions = require(`${pkg}/sessions`);
        if (main.TelegramClient && sessions.StringSession) {
          this.tg = { TelegramClient: main.TelegramClient, Api: main.Api, StringSession: sessions.StringSession };
          return this.tg;
        }
      } catch (e) {
        errors.push(`${pkg}: ${e.message}`);
      }
    }
    throw new Error(
      '缺少 telegram 依赖, 无法执行 Telegram 签到。\n' +
      '安装方法 (任选其一):\n' +
      '  1. 青龙面板 → 依赖管理 → Nodejs → 名称填 telegram → 安装\n' +
      '  2. docker exec -it qinglong npm install -g telegram\n' +
      `原始错误: ${errors.join(' | ')}`
    );
  }

  /** 给 promise 加超时, 避免网络异常时无限挂起 */
  _withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label || '操作'} 超时 (${Math.round(ms / 1000)}s)`)),
        ms
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * 解析 Telegram 代理
   * GramJS 只支持 SOCKS5 / MTProxy, 不支持 HTTP 代理
   *
   * 优先级: 账户 proxy > TG_PROXY > 环境 HTTPS_PROXY/ALL_PROXY/HTTP_PROXY (按 SOCKS5 尝试)
   */
  _resolveTgProxy() {
    const fromAccount = this.account.proxy;
    if (fromAccount) {
      const p = typeof fromAccount === 'object' ? this._cleanProxy(fromAccount, false) : this._parseProxy(fromAccount, false);
      if (p) return p;
    }

    for (const key of ['TG_PROXY', 'TELEGRAM_PROXY']) {
      const v = (process.env[key] || '').trim();
      if (v) {
        const p = this._parseProxy(v, false);
        if (p) return p;
      }
    }

    // 复用运行环境已有的代理 (青龙通常已配置)
    for (const key of ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      const v = (process.env[key] || '').trim();
      if (!v || /^(none|false|0|null|direct)$/i.test(v)) continue;
      const p = this._parseProxy(v, true);
      if (p) return p;
    }

    return null;
  }

  /** 字符串 → GramJS proxy 对象 */
  _parseProxy(str, assumed) {
    let s = String(str).trim();
    let assumedSocks = assumed;

    if (/^socks5:\/\//i.test(s) || /^socks:\/\//i.test(s)) {
      s = s.replace(/^socks5?:\/\//i, '');
      assumedSocks = false;
    } else if (/^https?:\/\//i.test(s)) {
      s = s.replace(/^https?:\/\//i, '');
      assumedSocks = true; // HTTP 代理端口通常也开了 SOCKS, 先按 SOCKS5 试
    } else if (/^mtproxy:\/\//i.test(s)) {
      s = s.replace(/^mtproxy:\/\//i, '');
    }

    s = s.replace(/\/.*$/, ''); // 去掉路径

    let username;
    let password;
    const at = s.lastIndexOf('@');
    if (at > 0) {
      const auth = s.substring(0, at);
      s = s.substring(at + 1);
      const colon = auth.indexOf(':');
      if (colon > 0) {
        username = decodeURIComponent(auth.substring(0, colon));
        password = decodeURIComponent(auth.substring(colon + 1));
      } else {
        username = decodeURIComponent(auth);
      }
    }

    const m = s.match(/^\[?([^\]]+?)\]?:(\d+)$/) || s.match(/^(.+):(\d+)$/);
    if (!m) return null;

    return this._cleanProxy({ ip: m[1], port: Number(m[2]), username, password }, assumedSocks);
  }

  /** 规范化 proxy 对象, 只保留 GramJS 认识的字段 */
  _cleanProxy(obj, assumed) {
    if (!obj || !obj.ip || !obj.port) return null;
    const clean = {
      ip: String(obj.ip),
      port: Number(obj.port),
      socksType: Number(obj.socksType) || 5,
      timeout: Number(obj.timeout) || 10,
    };
    if (obj.username) clean.username = String(obj.username);
    if (obj.password) clean.password = String(obj.password);
    clean.assumed = !!assumed;
    return clean;
  }

  /** 账户标签 (日志用) */
  _label() {
    return this.account.name || this.account.phone || this.account.email || 'TG账号';
  }

  /**
   * 登录: 用 session 建立 MTProto 连接
   */
  async login() {
    const { TelegramClient, StringSession } = this._loadTg();

    const apiId = Number(this.account.api_id || process.env.TELEGRAM_API_ID);
    const apiHash = this.account.api_hash || process.env.TELEGRAM_API_HASH;
    const session = this.account.session || process.env.TELEGRAM_SESSION;

    if (!apiId || !apiHash) {
      throw new Error(
        '缺少 api_id / api_hash。\n' +
        '获取方式: 浏览器打开 https://my.telegram.org → 登录 → API development tools → 创建应用\n' +
        '然后填到环境变量 TELEGRAM_ACCOUNTS 的 api_id / api_hash 字段 (或单独设 TELEGRAM_API_ID / TELEGRAM_API_HASH)'
      );
    }
    if (!session) {
      throw new Error(
        '缺少 session。请先运行 telegram-login.js 生成:\n' +
        '  node telegram-login.js\n' +
        '按提示输入手机号、验证码(和两步验证密码), 最后会输出一串 session, 填到配置的 session 字段'
      );
    }

    const proxy = this._resolveTgProxy();
    this.logger.info(`连接 Telegram (api_id=${apiId})...`);
    if (proxy) {
      this.logger.info(
        `使用 SOCKS5 代理 ${proxy.ip}:${proxy.port}` +
        (proxy.assumed ? ' (由环境 HTTP 代理配置推断, 若失败请显式配置 "proxy":"socks5://ip:port")' : '')
      );
    }

    const baseOpts = { connectionRetries: 2, timeout: 30 };
    if (proxy) {
      const { assumed, ...gramProxy } = proxy;
      baseOpts.proxy = gramProxy;
    }
    const createClient = (useWSS) => new TelegramClient(
      new StringSession(String(session).trim()),
      apiId,
      StringHash(apiHash),
      { ...baseOpts, useWSS }
    );

    let lastErr = null;
    this.client = createClient(false);
    try {
      await this._withTimeout(this.client.connect(), 60000, '连接 Telegram');
    } catch (e) {
      lastErr = e;
      try { await this.client.disconnect(); } catch { /* ignore */ }

      // GramJS 不允许 useWSS 与代理同时使用, 有代理时不做 WSS 回退
      if (proxy) {
        this.logger.warn(`连接失败: ${e.message}`);
      } else {
        this.logger.warn(`常规连接失败 (${e.message}), 尝试 WebSocket 模式...`);
        try {
          this.client = createClient(true);
          await this._withTimeout(this.client.connect(), 60000, 'WebSocket 连接 Telegram');
          lastErr = null;
        } catch (e2) {
          lastErr = e2;
        }
      }
    }

    if (lastErr) {
      throw new Error(
        `无法连接 Telegram 服务器: ${lastErr.message}\n` +
        `当前网络: ${proxy ? `SOCKS5 代理 ${proxy.ip}:${proxy.port}` : '直连 (未配置代理)'}\n` +
        '常见原因与解决办法:\n' +
        (proxy
          ? '  1. 该端口不支持 SOCKS5 (如只开了 HTTP 代理) → 换成 SOCKS5 端口, Clash 混合端口 7890 同时支持两者\n'
          : '  1. 服务器在国内直连不通 → 配置 SOCKS5 代理: "proxy": "socks5://127.0.0.1:10808"\n') +
        '  2. 代理未启动或端口填错 (可先用 curl --socks5-hostname 127.0.0.1:10808 https://api.telegram.org 测试)\n' +
        '  3. 服务器时间偏差超过 5 分钟, MTProto 会拒绝连接 → 校准时间 (ntpdate)\n' +
        '  4. api_id / api_hash 填错'
      );
    }

    const authorized = await this._withTimeout(this.client.isUserAuthorized(), 20000, '校验登录状态');
    if (!authorized) {
      throw new Error(
        'session 已失效或未登录。请重新运行 telegram-login.js 生成新的 session。\n' +
        '常见原因: 在 Telegram 客户端里「终止了其他设备的登录」、长时间未使用、或更换了 api_id'
      );
    }

    const me = await this._withTimeout(this.client.getMe(), 20000, '获取账号信息');
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || String(me.id);
    this.logger.info(`Telegram 登录成功: ${name} (@${me.username || '无用户名'})`);
  }

  /**
   * Telegram bot 没有统一的「签到状态」接口, 直接发命令
   */
  async checkinStatus() {
    return null;
  }

  /**
   * 逐个 bot 发送签到命令
   */
  async doCheckin() {
    const bots = Array.isArray(this.account.bots) ? this.account.bots : [];
    if (!bots.length) {
      throw new Error('配置里没有 bots 列表。示例: {"username":"xxx_bot","command":"/checkin"}');
    }

    const enabled = bots
      .map((b, idx) => ({ bot: this._normalizeBot(b, idx), idx }))
      .filter(({ bot }) => bot.enabled !== false);

    this.logger.info(`共 ${enabled.length} 个 bot 待签到`);

    const results = [];
    let ok = 0;
    let skipped = 0;
    let failed = 0;

    try {
      for (let i = 0; i < enabled.length; i++) {
        const bot = enabled[i].bot;
        try {
          const r = await this._checkinBot(bot);
          results.push(r);
          if (r.status === 'success') ok++;
          else if (r.status === 'skipped') skipped++;
          else failed++;
        } catch (e) {
          failed++;
          results.push({ bot: bot.username, status: 'failed', message: e.message });
          this.logger.error(`@${bot.username} 签到失败: ${e.message}`);
        }

        if (i < enabled.length - 1) {
          await sleep(DEFAULTS.betweenBotsMs);
        }
      }
    } finally {
      try { await this.client.disconnect(); } catch { /* ignore */ }
      this.logger.info('Telegram 连接已断开');
    }

    const summary = `成功 ${ok}, 已签到 ${skipped}, 失败 ${failed}`;
    if (failed > 0 && ok + skipped === 0) {
      const detail = results.map(r => `  - @${r.bot}: ${r.message || r.status}`).join('\n');
      throw new Error(`全部 bot 签到失败 (${summary})\n${detail}`);
    }
    this.logger.info(`Telegram 签到完成: ${summary}`);

    return { total: enabled.length, ok, skipped, failed, results };
  }

  /**
   * 单个 bot 签到: 发命令 → 等回复 → 判定结果
   */
  async _checkinBot(rawBot) {
    const bot = rawBot;
    const commands = Array.isArray(bot.command) ? bot.command : [bot.command];
    const waitSeconds = bot.waitSeconds || DEFAULTS.waitSeconds;

    this.logger.info(`@${bot.username} → 发送命令: ${commands.join(' , ')}`);

    // 记录发送前的最后一条消息 id, 用于区分新回复
    let lastId = 0;
    try {
      const prev = await this._withTimeout(this.client.getMessages(bot.username, { limit: 1 }), 20000, '读取历史消息');
      if (prev && prev.length) lastId = prev[0].id;
    } catch {
      // 首次对话可能没有历史, 忽略
    }

    let sentId = lastId;
    for (const cmd of commands) {
      const msg = await this._withTimeout(
        this.client.sendMessage(bot.username, { message: String(cmd) }),
        20000,
        `发送命令 ${cmd}`
      );
      if (msg && msg.id) sentId = Math.max(sentId, msg.id);
      await sleep(800);
    }

    // 等待 bot 回复
    const replies = await this._waitReplies(bot.username, sentId, waitSeconds);

    if (!replies.length) {
      this.logger.warn(`@${bot.username} 未收到回复 (${waitSeconds}s), 命令已发送`);
      return { bot: bot.username, status: 'unknown', message: `已发送, ${waitSeconds}s 内未收到回复` };
    }

    let text = replies.map(m => this._textOf(m)).filter(Boolean).join('\n').trim();
    this.logger.info(`@${bot.username} 回复: ${truncate(text || '(无文字内容)', 200)}`);

    // 可选: 点击内联按钮 (很多签到 bot 是按钮式)
    if (bot.clickButton) {
      const clicked = await this._clickButton(replies, bot.clickButton);
      if (clicked) {
        this.logger.info(`@${bot.username} 已点击按钮: ${bot.clickButton}`);
        const more = await this._waitReplies(bot.username, sentId, waitSeconds);
        const moreText = more.map(m => this._textOf(m)).filter(Boolean).join('\n').trim();
        if (moreText) {
          text = moreText;
          this.logger.info(`@${bot.username} 按钮后回复: ${truncate(moreText, 200)}`);
        }
      } else {
        this.logger.warn(`@${bot.username} 未找到按钮「${bot.clickButton}」`);
      }
    }

    const status = this._classify(text, bot);
    if (status === 'skipped') {
      this.logger.success(`@${bot.username} 今日已签到`);
    } else if (status === 'success') {
      this.logger.success(`@${bot.username} 签到成功`);
    } else if (status === 'failed') {
      this.logger.error(`@${bot.username} 签到失败: ${truncate(text, 150)}`);
    } else {
      this.logger.warn(`@${bot.username} 已发送, 但未识别结果: ${truncate(text, 150)}`);
    }

    return { bot: bot.username, status, message: truncate(text, 300) };
  }

  /** 轮询等待 bot 的新回复 */
  async _waitReplies(username, afterId, waitSeconds) {
    const deadline = Date.now() + waitSeconds * 1000;
    const collected = new Map();

    while (Date.now() < deadline) {
      await sleep(DEFAULTS.pollIntervalMs);
      try {
        const msgs = await this._withTimeout(this.client.getMessages(username, { limit: 8 }), 15000, '读取回复');
        for (const m of msgs || []) {
          if (!m || m.out) continue;        // 跳过自己发的
          if (m.id <= afterId) continue;    // 跳过旧消息
          collected.set(m.id, m);
        }
        if (collected.size) break;          // 收到回复就返回, 不再等满
      } catch (e) {
        this.logger.warn(`读取 @${username} 消息失败: ${e.message}`);
      }
    }

    return [...collected.values()].sort((a, b) => a.id - b.id);
  }

  /** 取消息文本 */
  _textOf(msg) {
    if (!msg) return '';
    if (typeof msg.message === 'string' && msg.message) return msg.message;
    if (typeof msg.text === 'string' && msg.text) return msg.text;
    return '';
  }

  /** 点击内联键盘按钮 */
  async _clickButton(replies, buttonText) {
    for (const msg of [...replies].reverse()) {
      const markup = msg.replyMarkup || msg.reply_markup;
      if (!markup) continue;
      try {
        if (typeof msg.click === 'function') {
          await this._withTimeout(msg.click({ text: buttonText }), 15000, '点击按钮');
          return true;
        }
      } catch (e) {
        // 文字没匹配到 / 按钮不是回调类型, 继续找
        if (/not found|no button|invalid/i.test(e.message || '')) continue;
        this.logger.warn(`点击按钮失败: ${e.message}`);
        continue;
      }
    }
    return false;
  }

  /** 根据回复文本判定结果 */
  _classify(text, bot) {
    if (!text) return 'unknown';
    const t = text.toLowerCase();
    const skip = bot.skipKeywords || DEFAULTS.skipKeywords;
    const fail = bot.failKeywords || DEFAULTS.failKeywords;
    const succ = bot.successKeywords || DEFAULTS.successKeywords;

    if (skip.some(k => t.includes(String(k).toLowerCase()))) return 'skipped';
    if (fail.some(k => t.includes(String(k).toLowerCase()))) return 'failed';
    if (succ.some(k => t.includes(String(k).toLowerCase()))) return 'success';
    return 'unknown';
  }

  /**
   * 规范化 bot 配置
   * 支持简写字符串: "xxx_bot:/checkin" 或 "xxx_bot /checkin"
   */
  _normalizeBot(raw, idx) {
    let bot = raw;

    if (typeof raw === 'string') {
      const s = raw.trim();
      const sep = s.indexOf(':');
      if (sep > 0) {
        bot = { username: s.substring(0, sep).trim(), command: s.substring(sep + 1).trim() };
      } else {
        const sp = s.indexOf(' ');
        bot = sp > 0
          ? { username: s.substring(0, sp).trim(), command: s.substring(sp + 1).trim() }
          : { username: s, command: '/start' };
      }
    }

    if (!bot || !bot.username) {
      throw new Error(`第 ${idx + 1} 个 bot 配置缺少 username`);
    }

    const username = String(bot.username).trim().replace(/^@/, '');
    let command = bot.command;
    if (command === undefined || command === null || command === '') command = '/start';
    if (Array.isArray(command)) {
      command = command.map(c => String(c)).filter(Boolean);
    } else {
      command = [String(command)];
    }

    return {
      ...bot,
      username,
      command,
      waitSeconds: Number(bot.waitSeconds) > 0 ? Number(bot.waitSeconds) : DEFAULTS.waitSeconds,
    };
  }
}

/** api_hash 必须是字符串, 防止用户填成数字导致类型错误 */
function StringHash(v) {
  return String(v).trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function truncate(str, n) {
  const s = String(str || '');
  return s.length > n ? `${s.substring(0, n)}...` : s;
}

module.exports = { TelegramHandler };
