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
const { URL } = require('url');
const { SiteHandler } = require('./base');

class IsvoroHandler extends SiteHandler {
  constructor(account, logger) {
    super(account, logger);
    this.baseUrl = 'https://isvoro.com';
    this.apiPrefix = '/api/v1';
    this.cookies = {};

    // 如果配置了 cookie 字符串, 解析为 cookies 对象
    if (account.cookie) {
      this._parseCookieString(account.cookie);
    }
  }

  /**
   * 解析 Cookie 字符串为 { key: value } 对象
   */
  _parseCookieString(cookieStr) {
    const pairs = cookieStr.split(';');
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const key = pair.substring(0, idx).trim();
        const val = pair.substring(idx + 1).trim();
        if (key && val) {
          this.cookies[key] = val;
        }
      }
    }
  }

  /**
   * 发送 HTTP 请求
   */
  _request(method, path, { body, headers, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const isApiPath = path.startsWith('/') && !path.startsWith('//') && path !== '/' && !path.startsWith('/assets') && !path.startsWith('/fonts');
      const fullPath = path.startsWith('http') ? path : (isApiPath ? this.apiPrefix + path : path);
      const url = new URL(fullPath, this.baseUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const cookieStr = Object.entries(this.cookies)
        .map(([k, v]) => `${k}=${v}`)
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

      // CSRF Token (从 pmt_csrf cookie 取)
      const csrfToken = this.cookies['pmt_csrf'];
      if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
        reqHeaders['X-CSRF-Token'] = csrfToken;
      }

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers: reqHeaders,
        timeout,
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // 解析 Set-Cookie
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
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`请求超时: ${method} ${path}`));
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
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
      const hasCsrf = !!this.cookies['pmt_csrf'];

      // 先尝试刷新 session
      if (hasCsrf) {
        try {
          await this._request('POST', '/auth/refresh');
          this.logger.info('Session 刷新成功');
        } catch (e) {
          this.logger.warn('Session 刷新失败, 尝试直接调用 API');
        }
      }

      // 验证 cookie 是否有效
      const res = await this._request('GET', '/auth/me');
      if (res.status === 200 && (res.data?.data?.id || res.data?.data?.email || res.data?.id)) {
        const user = res.data?.data || res.data;
        this.logger.info(`Cookie 认证成功: ${user.email || '已登录用户'}`);
        return;
      }

      // 如果 cookie 无效, 尝试刷新 CSRF
      this.logger.warn('Cookie 可能已过期, 尝试刷新...');
      const refreshRes = await this._request('POST', '/auth/refresh');
      if (refreshRes.status === 200) {
        const meRes = await this._request('GET', '/auth/me');
        if (meRes.status === 200 && (meRes.data?.data?.id || meRes.data?.id)) {
          const user = meRes.data?.data || meRes.data;
          this.logger.info(`Cookie 刷新后认证成功: ${user.email || '已登录用户'}`);
          return;
        }
      }

      throw new Error('Cookie 已过期, 请重新从浏览器获取 Cookie。方法: 浏览器登录 isvoro.com → F12 → Application → Cookies → 复制完整 cookie 字符串');
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
