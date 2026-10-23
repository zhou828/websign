# Isvoro 多站点自动签到

青龙面板自动签到脚本，支持 Isvoro 网站签到，架构上预留其他网站扩展。

## 文件结构

```
websign/
├── checkin.js              # 主入口
├── runner.js               # 签到运行器 (解析环境变量、调度、汇总)
├── handlers/
│   ├── base.js             # 站点处理器基类 (定义接口规范)
│   ├── isvoro.js           # Isvoro 签到处理器
│   └── example.js          # 示例模板 (新增网站时复制修改)
```

## 青龙面板配置

### 1. 添加脚本

将以下文件放入青龙面板的 `scripts/websign/` 目录：
- `checkin.js`
- `runner.js`
- `handlers/base.js`
- `handlers/isvoro.js`

### 2. 添加环境变量

| 变量名 | 说明 |
|--------|------|
| `ISVORO_ACCOUNTS` | Isvoro 账户配置，JSON 格式 |

#### 方式一：Cookie 认证（推荐，绕过验证码）

Isvoro 登录接口有 hCaptcha 验证码，密码方式无法自动登录。推荐使用 Cookie 方式。

**关键：必须复制以下 3 个 Cookie（缺一不可）：**

| Cookie 名 | 作用 |
|-----------|------|
| `pmt_access` | 访问令牌（身份认证核心） |
| `pmt_refresh` | 刷新令牌（access 过期后用它续期） |
| `pmt_csrf` | CSRF 保护（POST 请求必需） |

**获取 Cookie 步骤：**

1. 浏览器打开 https://isvoro.com 并**登录**
2. 按 `F12` 打开开发者工具
3. 切到 **Application（应用程序）** → 左侧 **Cookies** → `https://isvoro.com`
4. 找到 `pmt_access`、`pmt_refresh`、`pmt_csrf` 三行，分别复制它们的 Value
5. 拼成如下格式（用分号分隔）：

```
pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz
```

**配置示例（单账户）：**
```
{"cookie":"pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz"}
```

**更简单的做法**：在开发者工具切到 **Network（网络）** 面板，随便点一个 `api/v1` 开头的请求，在 **Request Headers** 里找到 `Cookie:` 那一行，把整行的值全部复制，直接贴进去。

**多账户：**
```
[{"cookie":"pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz"},{"cookie":"..."}]
```

#### 方式二：密码登录（可能被验证码拦截）

如果网站暂时关闭了验证码，可以用密码方式：
```
{"email":"your@email.com","password":"yourpassword"}
```

> 注意：登录接口正常情况下需要 hCaptcha 验证码，密码方式大概率会报错。请优先使用 Cookie 方式。

### 3. 添加定时任务

```
名称: Isvoro 签到
命令: task websign/checkin.js
定时: 30 8 * * *
```

## Cookie 过期怎么办

Cookie 有有效期，过期后需要重新获取。如果日志中出现 `Cookie 已过期` 的提示，重复上述获取 Cookie 步骤，更新环境变量即可。

## 新增其他网站

1. 复制 `handlers/example.js` 为 `handlers/yoursite.js`
2. 修改类名和 API 逻辑
3. 在 `checkin.js` 的 `siteRegistry` 中注册：
   ```js
   const { YourSiteHandler } = require('./handlers/yoursite');
   
   const siteRegistry = {
     isvoro: { handler: IsvoroHandler, envKey: 'ISVORO_ACCOUNTS', label: 'Isvoro' },
     yoursite: { handler: YourSiteHandler, envKey: 'YOURSITE_ACCOUNTS', label: 'YourSite' },
   };
   ```
4. 添加环境变量 `YOURSITE_ACCOUNTS`

## Isvoro API 说明

通过前端 JS 逆向分析得到：

| 功能 | 方法 | 端点 | 说明 |
|------|------|------|------|
| 登录 | POST | `/api/v1/auth/login` | body: `{email, password}`，需要 hCaptcha |
| 刷新 | POST | `/api/v1/auth/refresh` | 刷新 session，用 cookie 认证 |
| 当前用户 | GET | `/api/v1/auth/me` | 验证 cookie 是否有效 |
| 签到状态 | GET | `/api/v1/points/checkin/status` | 查询今日是否已签到 |
| 签到 | POST | `/api/v1/points/checkin` | 执行签到 |
| CSRF | - | Cookie `pmt_csrf` → 请求头 `X-CSRF-Token` | POST 请求需要 |
