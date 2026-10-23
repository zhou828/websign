/**
 * Isvoro 网站签到处理器
 * 网站: https://isvoro.com
 *
 * API 分析 (来自前端 JS 逆向):
 *   基础路径: /api/v1
 *   登录:    POST /api/v1/auth/login          body: { email, password }
 *   签到状态: GET  /api/v1/points/checkin/status
 *   签到:    POST /api/v1/points/checkin
 *   CSRF:    从 Cookie 中的 pmt_csrf 值, 放入请求头 X-CSRF-Token
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
  }

  /**
   * 发送 HTTP 请求
   */
  _request(method, path, { body, headers, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      // 以 / 开头且非 API 路径(如首页 /), 不加前缀; 否则加 /api/v1
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

      // CSRF Token
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
   * 登录
   */
  async login() {
    this.logger.info(`正在登录 Isvoro: ${this.account.email}`);

    // 先访问首页获取初始 Cookie (可能包含 CSRF token)
    await this._request('GET', '/');

    const res = await this._request('POST', '/auth/login', {
      body: {
        email: this.account.email,
        password: this.account.password,
      },
    });

    if (res.status !== 200) {
      throw new Error(`登录失败: HTTP ${res.status} ${JSON.stringify(res.data)}`);
    }

    const data = res.data;
    if (data?.tfa_required) {
      throw new Error('该账户开启了二步验证(2FA), 脚本暂不支持自动处理 2FA');
    }

    if (!data?.user) {
      throw new Error(`登录失败: ${JSON.stringify(data)}`);
    }

    this.logger.info(`登录成功: ${data.user.email || this.account.email}`);

    // 如果有 CSRF cookie, 重新请求以获取有效 token
    if (!this.cookies['pmt_csrf']) {
      // 尝试刷新一次获取 CSRF
      await this._request('GET', '/auth/me');
    }
  }

  /**
   * 查询签到状态
   */
  async checkinStatus() {
    this.logger.info('查询签到状态...');

    const res = await this._request('GET', '/points/checkin/status');

    if (res.status !== 200) {
      throw new Error(`查询签到状态失败: HTTP ${res.status}`);
    }

    const data = res.data?.data || res.data;
    this.logger.info(`签到状态: ${JSON.stringify(data)}`);

    return {
      checkedIn: data?.checked_in || data?.today_checked || false,
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
      throw new Error(`签到失败: HTTP ${res.status} ${JSON.stringify(res.data)}`);
    }

    const data = res.data?.data || res.data;

    if (data?.points !== undefined) {
      this.logger.info(`✅ 签到成功! 获得积分: ${data.points}, 累计: ${data.total_points || '未知'}`);
    } else {
      this.logger.info(`✅ 签到成功! 返回: ${JSON.stringify(data)}`);
    }

    return data;
  }
}

module.exports = { IsvoroHandler };
