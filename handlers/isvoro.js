/**
 * Isvoro 网站签到处理器
 * 网站: https://isvoro.com
 *
 * API 分析 (来自前端 JS 逆向):
 *   基础路径: /api/v1
 *   登录:    POST /api/v1/auth/login          body: { email, password } (需要 hCaptcha 验证码)
 *   刷新:    POST /api/v1/auth/refresh        刷新 session (用 cookie)
 *   签到状态: GET  /api/v1/points/checkin/status
 *   签到:    POST /api/v1/points/checkin
 *   CSRF:    Cookie pmt_csrf → 请求头 X-CSRF-Token
 *
 * 认证方式:
 *   方式一 (推荐): Cookie 认证 — 用户在浏览器登录后复制 Cookie, 脚本直接用
 *     环境变量 ISVORO_ACCOUNTS 中配置 cookie 字段
 *   方式二: 密码登录 — 可能被 hCaptcha 拦截
 *     环境变量 ISVORO_ACCOUNTS 中配置 email + password 字段
 */

const https = require('https');
const http = require('http');
const tls = require('tls');
const { URL } = require('url');
const { SiteHandler } = require('./base');

class IsvoroHandler extends SiteHandler {
  constructor(account, logger) {
    super(account, logger);
    this.baseUrl = 'https://isvoro.com';
    this.apiPrefix = '/api/v1';
    this.cookies = {};
    // 代理: 自动复用运行环境已有的代理 (青龙容器通常已配置), 无需额外设置
    // 优先级: 账户级 proxy > ISVORO_PROXY (可选覆盖) > 系统标准代理环境变量
    this.proxy = this._resolveProxy(account.proxy);
    this.proxyDisabled = false; // 代理不可用时置为 true, 自动降级直连

    // 如果配置了 cookie 字符串, 解析为 cookies 对象
    if (account.cookie) {
      this._parseCookieString(account.cookie);
    }
  }

  /**
   * 解析代理地址
   * 青龙面板/容器一般已经配置好代理环境变量, 脚本直接复用即可,
   * 无需为签到脚本单独设置 ISVORO_PROXY。
   */
  _resolveProxy(accountProxy) {
    const candidates = [
      accountProxy,
      process.env.ISVORO_PROXY, // 可选: 单站点覆盖
      process.env.HTTPS_PROXY,
      process.env.https_proxy,
      process.env.ALL_PROXY,
      process.env.all_proxy,
      process.env.HTTP_PROXY,
      process.env.http_proxy,
    ];
    for (const c of candidates) {
      const v = (c || '').trim();
      if (v && !this._isNoProxy(v)) return v;
    }
    return '';
  }

  /** 排除无效/占位值 */
  _isNoProxy(v) {
    return /^(none|false|0|null|direct)$/i.test(v);
  }

  /**
   * 解析 Cookie 字符串为 { key: value } 对象
   * 容错处理: 过滤换行/回车/制表符/多余空格, 兼容带 "Cookie:" 前缀的复制内容
   */
  _parseCookieString(cookieStr) {
    // 去掉可能粘贴进来的 "Cookie:" 前缀
    let cleaned = String(cookieStr).replace(/^\s*Cookie\s*:\s*/i, '');
    // 换行/回车/制表符统一转成空格 (浏览器复制多行时会有)
    cleaned = cleaned.replace(/[\r\n\t]+/g, ' ');

    const pairs = cleaned.split(';');
    for (const pair of pairs) {
      const trimmedPair = pair.trim();
      if (!trimmedPair) continue;
      const idx = trimmedPair.indexOf('=');
      if (idx > 0) {
        const key = trimmedPair.substring(0, idx).trim();
        const val = trimmedPair.substring(idx + 1).trim();
        if (key && val) {
          this.cookies[key] = val;
        }
      }
    }
  }

  /**
   * 发送 HTTP 请求 (带重试)
   * @param {string} method
   * @param {string} path
   * @param {object} opts - { body, headers, timeout, retries }
   */
  async _request(method, path, opts = {}) {
    const retries = opts.retries === undefined ? 2 : opts.retries;
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this._requestOnce(method, path, opts);
      } catch (e) {
        lastErr = e;
        const msg = e.message || '';
        const isProxyErr = /代理/.test(msg);
        const isNetworkErr = /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|socket hang up|网络错误/i.test(msg);

        // 代理本身不可用 (连不上/认证失败) → 立即降级直连, 不占用重试次数
        if (isProxyErr && this.proxy && !this.proxyDisabled) {
          this.proxyDisabled = true;
          this.logger.warn(`代理 ${this.proxy} 不可用, 自动切换为直连重试`);
          attempt--;
          continue;
        }

        if (!isNetworkErr || attempt >= retries) {
          // 代理下网络始终不通 → 最后再试一次直连
          if (isNetworkErr && this.proxy && !this.proxyDisabled) {
            this.proxyDisabled = true;
            this.logger.warn('经代理访问失败, 尝试直连...');
            attempt = -1; // 重置计数, 用直连重新走一轮
            continue;
          }
          break;
        }

        const wait = 1000 * Math.pow(2, attempt); // 1s, 2s
        this.logger.warn(`请求失败 (${msg}), ${wait}ms 后第 ${attempt + 1} 次重试...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  /**
   * 单次 HTTP 请求
   */
  _requestOnce(method, path, { body, headers, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      // ── 错误包装 (保证 message 不为空) ──
      const wrapErr = (e) => {
        const msg = (e && e.message) ? e.message : (e && e.code) ? `网络错误 (${e.code})` : '未知网络错误';
        reject(new Error(`请求失败 ${method} ${path}: ${msg}`));
      };

      // ── 响应处理 ──
      const handleResponse = (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const setCookies = res.headers['set-cookie'];
          if (setCookies) {
            for (const sc of setCookies) {
              const match = sc.match(/^([^=]+)=([^;]*)/);
              if (match) {
                this.cookies[match[1].trim()] = match[2].trim();
              }
            }
          }

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }

          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        });
      };

      try {
        const isApiPath = path.startsWith('/') && !path.startsWith('//') && path !== '/' && !path.startsWith('/assets') && !path.startsWith('/fonts');
        const fullPath = path.startsWith('http') ? path : (isApiPath ? this.apiPrefix + path : path);
        const url = new URL(fullPath, this.baseUrl);
        const isHttps = url.protocol === 'https:';

        // 清理 cookie 值中的非法字符 (换行/回车/制表符会导致 HTTP 头校验失败)
        const cookieStr = Object.entries(this.cookies)
          .map(([k, v]) => `${String(k).trim()}=${String(v).replace(/[\r\n\t]/g, '').trim()}`)
          .join('; ');

        const reqHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Content-Type': 'application/json',
          'Referer': this.baseUrl + '/',
          'Origin': this.baseUrl,
          ...headers,
        };

        if (cookieStr) {
          reqHeaders['Cookie'] = cookieStr;
        }

        // CSRF Token
        const csrfToken = this.cookies['pmt_csrf'];
        if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
          reqHeaders['X-CSRF-Token'] = String(csrfToken).replace(/[\r\n\t]/g, '').trim();
        }

        const options = {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: method.toUpperCase(),
          headers: reqHeaders,
          timeout,
        };

        // ── 代理支持 (HTTP CONNECT 隧道), 自动复用环境代理 ──
        if (this.proxy && !this.proxyDisabled && isHttps) {
          const proxyUrl = new URL(this.proxy);
          const targetHost = url.hostname;
          const targetPort = url.port || 443;

          const connectReq = http.request({
            host: proxyUrl.hostname,
            port: proxyUrl.port || 80,
            method: 'CONNECT',
            path: `${targetHost}:${targetPort}`,
            headers: { Host: `${targetHost}:${targetPort}` },
            timeout,
          });

          connectReq.on('connect', (proxyRes, socket) => {
            if (proxyRes.statusCode !== 200) {
              socket.destroy();
              reject(new Error(`代理连接失败: HTTP ${proxyRes.statusCode}`));
              return;
            }

            const tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
              const req = https.request(
                { ...options, createConnection: () => tlsSocket },
                handleResponse
              );
              req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时: ${method} ${path}`)); });
              req.on('error', wrapErr);
              if (body) req.write(JSON.stringify(body));
              req.end();
            });
            tlsSocket.on('error', wrapErr);
          });

          connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error(`代理连接超时: ${this.proxy}`)); });
          connectReq.on('error', (e) => reject(new Error(`代理错误: ${(e && e.message) || (e && e.code) || '未知'}`)));
          connectReq.end();
          return;
        }

        // ── 直连 ──
        const lib = isHttps ? https : http;
        const req = lib.request(options, handleResponse);

        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`请求超时: ${method} ${path}`));
        });
        req.on('error', wrapErr);

        if (body) {
          req.write(JSON.stringify(body));
        }
        req.end();
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        reject(new Error(`请求构造失败 ${method} ${path}: ${msg}`));
      }
    });
  }

  /**
   * 登录 / 认证
   * 优先使用 Cookie 方式, 其次尝试密码登录
   */
  async login() {
    // ── 方式一: Cookie 认证 (推荐) ──
    if (this.account.cookie) {
      this.logger.info('使用 Cookie 方式认证');
      const cookieKeys = Object.keys(this.cookies);
      this.logger.info(`已解析 Cookie 字段: ${cookieKeys.join(', ') || '(空)'}`);

      const hasAccess = !!this.cookies['pmt_access'];
      const hasRefresh = !!this.cookies['pmt_refresh'];
      const hasCsrf = !!this.cookies['pmt_csrf'];

      if (!hasAccess && !hasRefresh) {
        throw new Error(
          '缺少关键认证 Cookie (pmt_access / pmt_refresh)。\n' +
          '当前只有: ' + (cookieKeys.join(', ') || '(空)') + '\n' +
          '请重新获取完整 Cookie: 浏览器登录 isvoro.com → F12 → Application → Cookies → 复制 pmt_access、pmt_refresh、pmt_csrf 三个值'
        );
      }

      // 第一步: 直接用 pmt_access 验证
      if (hasAccess) {
        const meRes = await this._request('GET', '/auth/me');
        this.logger.info(`/auth/me 响应: HTTP ${meRes.status}, data: ${JSON.stringify(meRes.data).substring(0, 300)}`);
        if (meRes.status === 200) {
          const user = meRes.data?.data || meRes.data;
          if (user && (user.id || user.email || user.username)) {
            this.logger.info(`Cookie 认证成功: ${user.email || user.username || '已登录用户'}`);
            return;
          }
        }
      }

      // 第二步: pmt_access 无效/缺失, 用 pmt_refresh 刷新
      if (hasRefresh) {
        this.logger.info('尝试用 pmt_refresh 刷新 access token...');
        const refreshRes = await this._request('POST', '/auth/refresh');
        this.logger.info(`刷新响应: HTTP ${refreshRes.status}, data: ${JSON.stringify(refreshRes.data).substring(0, 300)}`);
        this.logger.info(`刷新后 cookies: ${Object.keys(this.cookies).join(', ') || '(空)'}`);

        if (refreshRes.status === 200) {
          const meRes = await this._request('GET', '/auth/me');
          this.logger.info(`刷新后 /auth/me: HTTP ${meRes.status}, data: ${JSON.stringify(meRes.data).substring(0, 300)}`);
          if (meRes.status === 200) {
            const user = meRes.data?.data || meRes.data;
            if (user && (user.id || user.email || user.username)) {
              this.logger.info(`Cookie 认证成功: ${user.email || user.username || '已登录用户'}`);
              return;
            }
          }
        }
      }

      // 组装失败原因
      const missing = [];
      if (!hasRefresh) missing.push('pmt_refresh (刷新令牌, 缺它无法自动续期)');
      if (!hasAccess) missing.push('pmt_access (访问令牌)');
      if (!hasCsrf) missing.push('pmt_csrf (CSRF 令牌)');

      throw new Error(
        `Cookie 认证失败。当前解析到的字段: [${cookieKeys.join(', ') || '空'}]\n` +
        (missing.length ? `缺失: ${missing.join('、')}\n` : '') +
        `\n正确获取方式 (任选其一):\n` +
        `【方法A - 推荐】浏览器登录 isvoro.com → F12 → Network 面板 → 筛选 auth/refresh → 点开该请求 → Request Headers 里的 Cookie 整行复制\n` +
        `【方法B】F12 → Application → Cookies → https://isvoro.com → 展开所有 Path (注意 pmt_refresh 可能在不同 Path 下) → 复制全部 cookie\n` +
        `\n提示: pmt_access 有效期很短(约15分钟), 必须配合 pmt_refresh 才能长期自动续期。`
      );
    }

    // ── 方式二: 密码登录 (可能被验证码拦截) ──
    if (this.account.email && this.account.password) {
      this.logger.info(`使用密码登录: ${this.account.email}`);

      // 先访问首页获取初始 Cookie
      await this._request('GET', '/');

      const res = await this._request('POST', '/auth/login', {
        body: {
          email: this.account.email,
          password: this.account.password,
        },
      });

      if (res.status === 400 && res.data?.message?.includes('captcha')) {
        throw new Error(
          '登录需要 hCaptcha 验证码, 密码方式无法自动完成。\n' +
          '请改用 Cookie 方式: \n' +
          '1. 浏览器登录 https://isvoro.com\n' +
          '2. F12 打开开发者工具 → Application → Cookies → isvoro.com\n' +
          '3. 复制所有 cookie (或至少 pmt_csrf 和 session 相关的)\n' +
          '4. 环境变量配置: {"cookie":"pmt_csrf=xxx; session=xxx; ..."}'
        );
      }

      if (res.status !== 200) {
        throw new Error(`登录失败: HTTP ${res.status} ${JSON.stringify(res.data).substring(0, 300)}`);
      }

      const data = res.data;
      const innerData = data?.data || data;

      if (innerData?.tfa_required) {
        throw new Error('该账户开启了二步验证(2FA), 脚本暂不支持自动处理 2FA');
      }

      if (!innerData?.user && !data?.user) {
        throw new Error(`登录失败, 响应: ${JSON.stringify(data).substring(0, 300)}`);
      }

      const user = innerData?.user || data?.user;
      this.logger.info(`密码登录成功: ${user.email || this.account.email}`);
      return;
    }

    throw new Error('未配置认证信息, 请配置 cookie 或 email+password');
  }

  /**
   * 查询签到状态
   */
  async checkinStatus() {
    this.logger.info('查询签到状态...');

    const res = await this._request('GET', '/points/checkin/status');

    if (res.status !== 200) {
      throw new Error(`查询签到状态失败: HTTP ${res.status} ${JSON.stringify(res.data).substring(0, 200)}`);
    }

    const data = res.data?.data || res.data;
    this.logger.info(`签到状态: ${JSON.stringify(data)}`);

    return {
      checkedIn: data?.checked_in || data?.today_checked || data?.checked || false,
      raw: data,
    };
  }

  /**
   * 执行签到
   */
  async doCheckin() {
    this.logger.info('执行签到...');

    const res = await this._request('POST', '/points/checkin');

    if (res.status !== 200) {
      const errMsg = res.data?.message || JSON.stringify(res.data).substring(0, 200);
      throw new Error(`签到失败: HTTP ${res.status} ${errMsg}`);
    }

    const data = res.data?.data || res.data;

    if (data?.points !== undefined) {
      this.logger.info(`✅ 签到成功! 获得积分: ${data.points}, 累计: ${data.total_points || '未知'}`);
    } else {
      this.logger.info(`✅ 签到成功! 返回: ${JSON.stringify(data).substring(0, 200)}`);
    }

    return data;
  }
}

module.exports = { IsvoroHandler };
