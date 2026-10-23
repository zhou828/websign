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
 *     "notify": "@my_channel",
 *     "bots": [
 *       { "username": "aaa_bot", "command": "/checkin" },
 *       { "username": "bbb_bot", "command": "/daily sign", "waitSeconds": 10 },
 *       { "username": "ccc_bot", "command": "/start", "clickButton": "签到" },
 *       { "target": "@my_group", "command": "/checkin", "botUsername": "ddd_bot" },
 *       { "target": "-1001234567890", "command": "/qd", "botUsername": "eee_bot" }
 *     ]
 *   }
 *
 * 目标 (username / target) 三种写法:
 *   "aaa_bot"                  私聊 bot
 *   "https://t.me/my_group"    公开群/频道
 *   "-1001234567890"           私有群/频道 (数字 id)
 *
 * 每个目标支持的字段:
 *   username / target  必填, 目标 bot 用户名、群组或频道
 *   command            必填, 要发送的命令; 数组形式可发多条, 如 ["/start", "/checkin"]
 *   botUsername        群/频道签到建议填, 指定响应的 bot, 用于过滤无关消息
 *   clickButton        可选, 若回复带内联按钮, 自动点击文字匹配的按钮 (如 "签到")
 *   waitSeconds        可选, 等待回复的秒数, 默认 8
 *   successKeywords / skipKeywords / failKeywords  可选, 自定义结果关键词
 *   enabled            可选, 设为 false 可临时跳过
 *
 * 账户级 notify (可选): 签到结束后把汇总发到指定频道/群
 *   "notify": "@my_channel"
 *   "notify": { "target": "-1001234567890", "onlyOnFailure": true }
 *
 * 注意: 频道里 bot 不会响应命令, 频道只适合用 notify 接收签到汇总。
 */

const { SiteHandler } = require('./base');
const { resolveProxy, toGramProxy, describeProxy } = require('../lib/telegram-proxy');
const { normalizeSession } = require('../lib/telegram-config');

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
    return resolveProxy(this.account.proxy);
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
    // session 可能被复制时带入换行/空格, 必须清理后再用
    const session = normalizeSession(this.account.session || process.env.TELEGRAM_SESSION);

    if (!apiId || !apiHash) {
      throw new Error(
        '缺少 api_id / api_hash。\n' +
        '获取方式: 浏览器打开 https://my.telegram.org → 登录 → API development tools → 创建应用\n' +
        '然后把 api_id / api_hash 填到 config/config.yaml 里该账号的对应字段\n' +
        '(多账号就是 telegram 数组里多个对象, 各自填自己的)'
      );
    }
    if (!session) {
      throw new Error(
        '缺少 session。请先运行 telegram-login.js 生成:\n' +
        '  node telegram-login.js --proxy socks5://127.0.0.1:10808\n' +
        '按提示输入手机号、验证码(和两步验证密码), 最后会打印一段配置块\n' +
        '把里面的 session 值填到 config/config.yaml 里即可'
      );
    }

    // 提前校验 session 格式, 避免复制不完整时报出难懂的 "Not a valid string"
    try {
      // eslint-disable-next-line no-new
      new StringSession(session);
    } catch (e) {
      throw new Error(
        `session 格式不正确: ${e.message}\n` +
        '常见原因:\n' +
        '  1. 复制不完整 (session 很长, 一般 300~400 个字符, 确认没被截断)\n' +
        '  2. 粘贴时混入了换行/引号/空格以外的多余字符\n' +
        '  3. 把 api_hash 或别的值填到了 session 字段\n' +
        '解决: 重新运行 telegram-login.js 生成一份新的 session'
      );
    }

    const proxy = this._resolveTgProxy();
    this.logger.info(`连接 Telegram (api_id=${apiId})...`);
    if (proxy) {
      this.logger.info(
        `使用 ${describeProxy(proxy)}` +
        (proxy.assumed ? ', 若连接失败请显式配置 "proxy":"socks5://ip:port"' : '')
      );
    }

    const baseOpts = { connectionRetries: 2, timeout: 30 };
    if (proxy) {
      baseOpts.proxy = toGramProxy(proxy);
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
        `当前网络: ${describeProxy(proxy)}\n` +
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
      throw new Error(
        '没有配置任何签到目标 (bots 为空)。\n' +
        `请在配置文件里添加 bots: ${this.account._source || 'config/telegram.js'}\n` +
        '示例:\n' +
        "  bots: [\n" +
        "    { username: 'aaa_bot', command: '/checkin' },\n" +
        "    { target: '@my_group', command: '/checkin', botUsername: 'aaa_bot' },\n" +
        "  ]"
      );
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
          results.push({ bot: bot.label, status: 'failed', message: e.message });
          this.logger.error(`${bot.label} 签到失败: ${e.message}`);
        }

        if (i < enabled.length - 1) {
          await sleep(DEFAULTS.betweenBotsMs);
        }
      }

      // 可选: 把汇总发到指定频道/群
      const summaryText = `成功 ${ok}, 已签到 ${skipped}, 失败 ${failed}`;
      await this._sendNotify(results, summaryText);
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

    return {
      total: enabled.length,
      ok,
      skipped,
      failed,
      results,
      // 全部都是"今天已签过" → 上层记为已签到, 不算新签到成功
      alreadyChecked: ok === 0 && failed === 0 && skipped > 0,
    };
  }

  /**
   * 单个目标签到: 发命令 → 等回复 → 判定结果
   * 目标可以是 bot 私聊、群组、频道 (群/频道里由群内 bot 响应命令)
   */
  async _checkinBot(rawBot) {
    const bot = rawBot;
    const commands = Array.isArray(bot.command) ? bot.command : [bot.command];
    const waitSeconds = bot.waitSeconds || DEFAULTS.waitSeconds;

    const entity = await this._getEntity(bot.target);
    this.logger.info(`${bot.label} → 发送命令: ${commands.join(' , ')}`);

    // 群/频道里需要知道是哪个 bot 在响应, 用于过滤无关消息
    let botId = null;
    if (bot.botUsername) {
      try {
        const botEntity = await this._getEntity(bot.botUsername);
        botId = botEntity && botEntity.id;
      } catch (e) {
        this.logger.warn(`解析响应 bot ${bot.botUsername} 失败: ${e.message}`);
      }
    }

    // 记录发送前的最后一条消息 id, 用于区分新回复
    let lastId = 0;
    try {
      const prev = await this._withTimeout(this.client.getMessages(entity, { limit: 1 }), 20000, '读取历史消息');
      if (prev && prev.length) lastId = prev[0].id;
    } catch {
      // 首次对话可能没有历史, 忽略
    }

    let sentId = lastId;
    const sentIds = [];
    for (const cmd of commands) {
      const msg = await this._withTimeout(
        this.client.sendMessage(entity, { message: String(cmd) }),
        20000,
        `发送命令 ${cmd}`
      );
      if (msg && msg.id) {
        sentId = Math.max(sentId, msg.id);
        sentIds.push(msg.id);
      }
      await sleep(800);
    }

    // 等待回复
    const replies = await this._waitReplies(entity, sentId, waitSeconds, { sentIds, botId, label: bot.label });

    if (!replies.length) {
      this.logger.warn(`${bot.label} 未收到回复 (${waitSeconds}s), 命令已发送`);
      return { bot: bot.label, status: 'unknown', message: `已发送, ${waitSeconds}s 内未收到回复` };
    }

    let text = replies.map(m => this._textOf(m)).filter(Boolean).join('\n').trim();
    this.logger.info(`${bot.label} 回复: ${truncate(text || '(无文字内容)', 200)}`);

    // 可选: 点击内联按钮 (很多签到 bot 是按钮式)
    if (bot.clickButton) {
      const clicked = await this._clickButton(replies, bot.clickButton);
      if (clicked) {
        this.logger.info(`${bot.label} 已点击按钮: ${bot.clickButton}`);
        const more = await this._waitReplies(entity, sentId, waitSeconds, { sentIds, botId, label: bot.label });
        const moreText = more.map(m => this._textOf(m)).filter(Boolean).join('\n').trim();
        if (moreText) {
          text = moreText;
          this.logger.info(`${bot.label} 按钮后回复: ${truncate(moreText, 200)}`);
        }
      } else {
        this.logger.warn(`${bot.label} 未找到按钮「${bot.clickButton}」`);
      }
    }

    const status = this._classify(text, bot);
    if (status === 'skipped') {
      this.logger.success(`${bot.label} 今日已签到`);
    } else if (status === 'success') {
      this.logger.success(`${bot.label} 签到成功`);
    } else if (status === 'failed') {
      this.logger.error(`${bot.label} 签到失败: ${truncate(text, 150)}`);
    } else {
      this.logger.warn(`${bot.label} 已发送, 但未识别结果: ${truncate(text, 150)}`);
    }

    return { bot: bot.label, status, message: truncate(text, 300) };
  }

  /**
   * 轮询等待新回复
   * 群/频道里噪音多, 优先取「回复了我们的消息」或「发送者为指定 bot」的消息
   */
  async _waitReplies(entity, afterId, waitSeconds, opts = {}) {
    const { sentIds = [], botId = null, label = '' } = opts;
    const deadline = Date.now() + waitSeconds * 1000;
    const strong = new Map(); // 高置信度: 回复我们 / 来自目标 bot
    const weak = new Map();   // 兜底: 任意新消息

    while (Date.now() < deadline) {
      await sleep(DEFAULTS.pollIntervalMs);
      try {
        const msgs = await this._withTimeout(this.client.getMessages(entity, { limit: 15 }), 15000, '读取回复');
        for (const m of msgs || []) {
          if (!m || m.out) continue;      // 跳过自己发的
          if (m.id <= afterId) continue;  // 跳过旧消息

          const replyTo = m.replyTo && (m.replyTo.replyToMsgId || m.replyTo.reply_to_msg_id);
          const isReplyToUs = replyTo && sentIds.includes(replyTo);
          const isFromBot = botId && m.senderId && String(m.senderId) === String(botId);

          if (isReplyToUs || isFromBot) strong.set(m.id, m);
          else weak.set(m.id, m);
        }
        if (strong.size) break;
        // 私聊场景没有 botId 时, 新消息基本就是回复
        if (!botId && weak.size) break;
      } catch (e) {
        this.logger.warn(`读取 ${label || '目标'} 消息失败: ${e.message}`);
      }
    }

    const picked = strong.size ? strong : weak;
    return [...picked.values()].sort((a, b) => a.id - b.id);
  }

  /**
   * 把用户配置的目标解析成 GramJS 能识别的 entity 标识
   * 支持: @username / username / t.me/name / https://t.me/name /
   *       t.me/c/123456789/1 / 数字 id (-100 开头为频道/超级群)
   */
  _resolveTarget(raw) {
    let s = String(raw || '').trim();
    if (!s) throw new Error('目标为空');

    // 私有群/频道链接: https://t.me/c/1234567890/123 → -1001234567890
    const priv = s.match(/t(?:elegram)?\.me\/c\/(\d+)/i);
    if (priv) return Number(`-100${priv[1]}`);

    s = s.replace(/^https?:\/\//i, '')
      .replace(/^t(?:elegram)?\.me\//i, '')
      .replace(/^@/, '')
      .replace(/\/.*$/, '');

    if (/^-?\d+$/.test(s)) return Number(s);
    return s;
  }

  /** 解析目标为 entity, 数字 id 未缓存时拉取对话列表重试 */
  async _getEntity(raw) {
    const resolved = this._resolveTarget(raw);
    try {
      return await this._withTimeout(this.client.getEntity(resolved), 20000, '解析目标');
    } catch (e) {
      if (typeof resolved === 'number') {
        this.logger.info(`目标 ${raw} 不在缓存中, 拉取对话列表后重试...`);
        try {
          await this._withTimeout(this.client.getDialogs({ limit: 500 }), 60000, '拉取对话列表');
          return await this._withTimeout(this.client.getEntity(resolved), 20000, '解析目标');
        } catch (e2) {
          throw new Error(
            `无法解析目标 ${raw} (数字 id ${resolved}): ${e2.message}\n` +
            '请确认: 1) 该群/频道在你的账号里 2) id 格式正确 (-100 开头为超级群/频道) 3) 账号没有被踢出'
          );
        }
      }
      throw new Error(
        `无法解析目标 ${raw}: ${e.message}\n` +
        '私有群/频道请改用数字 id (-100 开头), 可从 https://web.telegram.org 打开该群后看地址栏'
      );
    }
  }

  /**
   * 发送签到汇总通知到指定频道/群
   * 配置: "notify": "@mychannel"  或  "notify": {"target":"@mychannel","onlyOnFailure":true}
   */
  async _sendNotify(results, summary) {
    const cfg = this.account.notify;
    if (!cfg) return;

    const target = typeof cfg === 'string' ? cfg : cfg.target;
    if (!target) return;

    const onlyFail = typeof cfg === 'object' && cfg.onlyOnFailure;
    const failedCount = results.filter(r => r.status === 'failed').length;
    if (onlyFail && failedCount === 0) {
      this.logger.info('无失败项, 按配置跳过通知');
      return;
    }

    const icon = { success: '✅', skipped: '☑️', unknown: '❔', failed: '❌' };
    const lines = [`📋 签到汇总: ${summary}`];
    for (const r of results) {
      lines.push(`${icon[r.status] || '•'} ${r.bot}: ${truncate(r.message || r.status, 100)}`);
    }
    lines.push(`🕒 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);

    try {
      const entity = await this._getEntity(target);
      await this._withTimeout(
        this.client.sendMessage(entity, { message: lines.join('\n') }),
        20000,
        '发送汇总通知'
      );
      this.logger.info(`已发送签到汇总到 ${target}`);
    } catch (e) {
      this.logger.warn(`发送汇总到 ${target} 失败: ${e.message}`);
    }
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
   * 目标可以是 bot 私聊 / 群组 / 频道:
   *   { "username": "aaa_bot", "command": "/checkin" }
   *   { "target": "@mygroup", "command": "/checkin", "botUsername": "aaa_bot" }
   *   { "target": "-1001234567890", "command": "/checkin" }
   * 简写字符串: "aaa_bot:/checkin" / "aaa_bot /checkin" / "https://t.me/mygroup /checkin"
   */
  _normalizeBot(raw, idx) {
    let bot = raw;

    if (typeof raw === 'string') {
      const s = raw.trim();
      if (/^(https?:\/\/|t\.me\/|telegram\.me\/)/i.test(s)) {
        // 链接形式: 链接 + 空格 + 命令
        const sp = s.search(/\s/);
        bot = sp > 0
          ? { target: s.substring(0, sp), command: s.substring(sp + 1).trim() }
          : { target: s, command: '/start' };
      } else {
        const sep = s.indexOf(':');
        if (sep > 0) {
          bot = { target: s.substring(0, sep).trim(), command: s.substring(sep + 1).trim() };
        } else {
          const sp = s.indexOf(' ');
          bot = sp > 0
            ? { target: s.substring(0, sp).trim(), command: s.substring(sp + 1).trim() }
            : { target: s, command: '/start' };
        }
      }
    }

    const targetRaw = bot && (bot.target || bot.username || bot.chat || bot.channel);
    if (!targetRaw) {
      throw new Error(`第 ${idx + 1} 个配置缺少 target / username (bot 用户名、群组或频道)`);
    }

    const target = String(targetRaw).trim();
    // 显示用标签: 用户名形式显示 @xxx, 数字 id 原样显示
    const bare = target
      .replace(/^https?:\/\//i, '')
      .replace(/^t(?:elegram)?\.me\//i, '')
      .replace(/^@/, '');
    const label = /^-?\d+$/.test(bare) ? `[${bare}]` : `@${bare.split('/')[0]}`;

    let command = bot.command;
    if (command === undefined || command === null || command === '') command = '/start';
    command = Array.isArray(command)
      ? command.map(c => String(c)).filter(Boolean)
      : [String(command)];

    const botUsername = bot.botUsername ? String(bot.botUsername).trim().replace(/^@/, '') : '';

    return {
      ...bot,
      target,
      label,
      botUsername,
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
