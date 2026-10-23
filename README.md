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

| Cookie 名 | 作用 | 有效期 |
|-----------|------|--------|
| `pmt_access` | 访问令牌（身份认证核心） | 约 15 分钟 |
| `pmt_refresh` | 刷新令牌（access 过期后用它续期） | 较长 |
| `pmt_csrf` | CSRF 保护（POST 请求必需） | - |

> ⚠️ **`pmt_refresh` 是最关键的一个**：`pmt_access` 只有 15 分钟有效期，没有 `pmt_refresh` 脚本就无法自动续期，只能每次手动换 Cookie。

**获取 Cookie 步骤（方法 A，最可靠）：**

1. 浏览器打开 https://isvoro.com 并**登录**
2. 按 `F12` 打开开发者工具
3. 切到 **Network（网络）** 面板
4. 在筛选框输入 `refresh`
5. 找到 `auth/refresh` 请求（没有就按 F5 刷新页面），点开它
6. 在 **Request Headers** 里找到 `Cookie:` 那一行，**整行值全部复制**

这一行里一定包含 `pmt_access`、`pmt_refresh`、`pmt_csrf` 三个。

**方法 B（备选）：**

F12 → **Application（应用程序）** → 左侧 **Cookies** → `https://isvoro.com`

⚠️ 注意看 **Path** 列！`pmt_refresh` 可能挂在 `/api/v1/auth` 这样的路径下，需要**展开所有 Path 分组**，不能只看 `/` 根路径下的。

**配置格式（直接粘贴，不要包 JSON）：**

```
pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz
```

青龙环境变量 `ISVORO_ACCOUNTS` 的值就填上面这一整串。

**也支持 JSON 格式：**
```
{"cookie":"pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz"}
```

**多账户**（每行一个 cookie）：
```
pmt_access=aaa; pmt_refresh=bbb; pmt_csrf=ccc
pmt_access=ddd; pmt_refresh=eee; pmt_csrf=fff
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

### 4. 网络代理（无需额外配置）

Isvoro 走 Cloudflare，国内服务器访问可能不稳定（`ETIMEDOUT`）。

**脚本会自动复用运行环境里已有的代理环境变量**（`HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` / `HTTP_PROXY` 等）。青龙面板已经配好代理的话，这里什么都不用做。

代理连不上时，脚本会自动降级为直连，不会因为代理失效而整体失败。

只有在需要给这个站点单独指定代理时，才加这个可选变量：

| 变量名 | 说明 |
|--------|------|
| `ISVORO_PROXY` | 仅 Isvoro 使用的代理，如 `http://192.168.1.10:7890` |

脚本已内置重试机制（网络错误自动重试 2 次，间隔 1s/2s）。

## Cookie 过期怎么办

`pmt_access` 只有约 15 分钟有效期，但服务端在每次请求的响应头里会**滚动下发新的 token**。脚本会把这些新 token 保存到本地缓存：

```
.cookie-store/isvoro-<账户>.json
```

下次运行时按这个顺序尝试：

1. 环境变量里的 `ISVORO_ACCOUNTS`
2. 上次运行保存的本地缓存

所以正常情况下，只要第一次能跑通，之后就能自动续期，不用天天手动换 Cookie。

如果两个来源都失效（日志会列出每个来源的失败原因），按上面的「方法 A」重新取一次 Cookie 填到环境变量即可，脚本会自动覆盖旧缓存。

> `.cookie-store/` 已加入 `.gitignore`，不会被提交到仓库。
> 想换个位置可以设 `ISVORO_COOKIE_DIR=/ql/data/config/cookie`。

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
| 积分余额 | GET | `/api/v1/points` | 查询当前积分（签到后用于显示累计） |
| CSRF | - | Cookie `pmt_csrf` → 请求头 `X-CSRF-Token` | POST 请求需要 |
