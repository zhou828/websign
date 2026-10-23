# 多站点自动签到

青龙面板自动签到脚本，支持 Isvoro 网站签到、Telegram bot 命令签到，架构上预留其他网站扩展。

## 文件结构

```
websign/
├── checkin.js              # 主入口 (站点注册表)
├── runner.js               # 签到运行器 (调度、汇总)
├── telegram-login.js       # Telegram 登录助手 (生成 session, 只需跑一次)
├── config/
│   └── config.example.js   # 统一配置模板 (复制为 config.js 使用)
├── lib/
│   ├── config.js           # 统一配置加载 (所有站点共用)
│   ├── telegram-config.js  # Telegram 配置加载
│   └── telegram-proxy.js   # Telegram 代理解析
├── handlers/
│   ├── base.js             # 站点处理器基类 (定义接口规范)
│   ├── isvoro.js           # Isvoro 签到处理器
│   ├── telegram.js         # Telegram bot 签到处理器
│   └── example.js          # 示例模板 (新增网站时复制修改)
```

> 只有 `config/config.example.js` 进仓库；你自己填的 `config/config.js` 已被 `.gitignore` 忽略。

## 青龙面板配置

### 1. 添加脚本

将以下文件放入青龙面板的 `scripts/websign/` 目录：

- `checkin.js`
- `runner.js`
- `handlers/base.js`
- `handlers/isvoro.js`
- `handlers/telegram.js`（要用 Telegram 签到才需要）
- `lib/config.js`、`lib/telegram-config.js`、`lib/telegram-proxy.js`
- `config/config.example.js`（配置模板，复制成 `config.js` 后编辑）
- `telegram-login.js`（只在你自己电脑上跑，不用放青龙）

### 2. 创建配置文件

**所有配置都在一个文件里，不需要配任何环境变量。**

```bash
cp config/config.example.js config/config.js
```

然后编辑 `config/config.js`：

```js
module.exports = {
  // Isvoro 签到
  isvoro: {
    accounts: [
      { name: '主号', cookie: 'pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz' },
    ],
  },

  // Telegram 签到
  telegram: [
    {
      name: '主账号',
      api_id: 1234567,
      api_hash: '0123456789abcdef0123456789abcdef',
      session: '1BVtsOK...',
      proxy: 'socks5://127.0.0.1:10808',
      notify: '',
      bots: [
        { username: 'aaa_bot', command: '/checkin' },
      ],
    },
  ],
};
```

不需要的站点整段删掉即可，脚本会自动跳过。

**配置文件放哪**（按优先级查找）：

1. 环境变量 `CONFIG_FILE` 指定的路径
2. `<项目>/config/config.js`
3. `<项目>/config/config.json`

> ⚠️ 青龙里建议把配置放到 `/ql/data/config/config.js`，再设 `CONFIG_FILE=/ql/data/config/config.js`。
> `/ql/data/scripts/` 下的文件会被订阅更新覆盖，配置放那里容易丢。
>
> `config/config.js` 已加入 `.gitignore`，不会推到仓库。

> 环境变量（`ISVORO_ACCOUNTS`、`TELEGRAM_ACCOUNTS`、`TELEGRAM_API_ID` 等）仍可用作兼容回退，但**配置文件优先级更高**。新部署直接用配置文件即可。

### 3. 添加定时任务

```
名称: 多站点签到
命令: task websign/checkin.js
定时: 30 8 * * *
```

### 4. 网络代理（Isvoro 无需额外配置）

Isvoro 走 Cloudflare，国内服务器访问可能不稳定（`ETIMEDOUT`）。

**脚本会自动复用运行环境里已有的代理环境变量**（`HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` / `HTTP_PROXY` 等）。青龙面板已经配好代理的话，这里什么都不用做。代理连不上时会自动降级为直连。

也可以给 Isvoro 单独指定代理，写在配置文件里：

```js
isvoro: {
  accounts: [
    { name: '主号', cookie: '...', proxy: 'http://192.168.1.10:7890' },
  ],
},
```

脚本已内置重试机制（网络错误自动重试 2 次，间隔 1s/2s）。

---

## Isvoro 配置

### 方式一：Cookie 认证（推荐，绕过验证码）

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

**填到配置文件里**（整行 Cookie 直接粘到 `cookie` 字段，不需要转义）：

```js
isvoro: {
  accounts: [
    { name: '主号', cookie: 'pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz' },
  ],
},
```

**多账户**：`accounts` 数组里加多个对象即可：

```js
isvoro: {
  accounts: [
    { name: '主号', cookie: 'pmt_access=aaa; pmt_refresh=bbb; pmt_csrf=ccc' },
    { name: '小号', cookie: 'pmt_access=ddd; pmt_refresh=eee; pmt_csrf=fff' },
  ],
},
```

### 方式二：密码登录（可能被验证码拦截）

如果网站暂时关闭了验证码，可以改用密码方式：

```js
isvoro: {
  accounts: [
    { name: '主号', email: 'your@email.com', password: 'yourpassword' },
  ],
},
```

> 注意：登录接口正常情况下需要 hCaptcha 验证码，密码方式大概率会报错。请优先使用 Cookie 方式。

---

## Telegram bot 签到（可选）

给多个 Telegram bot 发送各自的签到命令（每个 bot 命令可以不一样）。

### 为什么必须用「用户账号」

Telegram 官方禁止 bot 与 bot 互相通信，所以不能用自己的 bot 去给目标 bot 发消息。脚本用 **MTProto 协议**以你自己的账号身份发送，这也是唯一稳定的方案。

### 第 1 步：装依赖

青龙面板 → **依赖管理** → Nodejs → 名称填 `telegram` → 安装。

（或 `docker exec -it qinglong npm install -g telegram`）

> 仓库里已带 `package.json`，如果你的青龙支持在脚本目录执行 npm，也可以直接 `npm install`。

### 第 2 步：申请 api_id / api_hash

`api_id` / `api_hash` 是 Telegram 发给「第三方客户端应用」的**应用凭证**——不是手机号，不是登录密码，也不是 bot token。一个账号创建一次就够，之后一直复用。

1. 浏览器打开 https://my.telegram.org（国内需代理）
2. 用你的手机号登录（验证码发到 Telegram App 里名为「Telegram」的官方会话，不是短信）
3. 进入 **API development tools**
4. 随便填个 App title / short name，创建后会得到 `api_id`（纯数字）和 `api_hash`（32 位字符）

### 第 3 步：生成 session（只做一次）

**在你自己的电脑上**执行（需要交互输入验证码，青龙里跑不了）：

```bash
npm install telegram
node telegram-login.js --proxy socks5://127.0.0.1:10808
```

> **国内必须带 `--proxy`**，否则会一直报 `connect ETIMEDOUT 149.154.167.91:80`——那是 Telegram 服务器地址，直连不通。
>
> 端口按你的客户端填：v2rayN 一般是 `10808`，Clash 是 `7890`，SSR 是 `1080`。
> 不写 `--proxy` 时脚本会自动读环境变量 `TG_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。
>
> 先验证代理可用：
> ```bash
> curl --socks5-hostname 127.0.0.1:10808 https://api.telegram.org
> ```
> 返回 302 就说明 SOCKS5 正常。

按提示输入 `api_id`、`api_hash`、手机号（含国家码如 `+8613800000000`）、Telegram 收到的验证码，如果开了两步验证再输密码。

运行结束会直接打印一段**可粘贴的配置块**（含 `api_id` / `api_hash` / `session`），照着放进 `config/config.js` 即可。

> `session` 等于你的登录凭证，泄露等于账号被登录，切勿外传。

### 第 4 步：写进配置文件

登录助手会直接打印一段可以直接粘贴的配置块，加到 `config/config.js` 的 `telegram` 数组里：

```js
telegram: [
  {
    name: '主账号',                                        // 日志里显示的名字
    api_id: 1234567,
    api_hash: '0123456789abcdef0123456789abcdef',
    session: '1BVtsOK...',                                // 长串直接放，不需要转义
    proxy: 'socks5://127.0.0.1:10808',                    // 可选
    notify: '',                                           // 可选: 签到汇总发到频道/群
    bots: [
      { username: 'aaa_bot', command: '/checkin' },
      { username: 'bbb_bot', command: '/daily sign' },
      { username: 'ccc_bot', command: ['/start', '/checkin'], clickButton: '签到' },
      { target: '@my_group', command: '/checkin', botUsername: 'ddd_bot' },
      { target: '-1001234567890', command: '/qd', botUsername: 'eee_bot' },
    ],
  },
],
```

> **session 为什么可以直接写在文件里**：它只是一个 JS 字符串，不经过 JSON 序列化，`+` `/` `=` 都不会出问题。脚本还会自动去掉粘贴时带入的换行和空格。

多账号就在 `telegram` 数组里加第二个对象，每个对象自带自己的 `api_id` / `api_hash` / `session`：

```js
telegram: [
  { name: '主账号', api_id: 1111111, api_hash: '...', session: '...', bots: [...] },
  { name: '小号',   api_id: 2222222, api_hash: '...', session: '...', bots: [...] },
],
```

**每个目标支持的字段：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `username` / `target` | 是 | 目标，三种写法见下方「发到群组 / 频道」 |
| `command` | 是 | 要发送的命令；数组可发多条，如 `["/start","/checkin"]` |
| `botUsername` | 否 | **群/频道里签到必填**，指定由哪个 bot 响应，用于过滤无关消息 |
| `clickButton` | 否 | 若回复带内联按钮，自动点击文字匹配的按钮（如 `"签到"`） |
| `waitSeconds` | 否 | 等待回复秒数，默认 8 |
| `successKeywords` | 否 | 自定义成功关键词 |
| `skipKeywords` | 否 | 自定义"已签到"关键词 |
| `failKeywords` | 否 | 自定义失败关键词 |
| `enabled` | 否 | 设 `false` 可临时跳过 |

也可以简写成字符串数组：`bots: ['aaa_bot:/checkin', 'bbb_bot /daily', 'https://t.me/mygroup /checkin']`

### 发到群组 / 频道

目标支持三种写法，私聊 bot、群组、频道都能用：

| 写法 | 示例 | 说明 |
|------|------|------|
| 用户名 | `"aaa_bot"` / `"@mygroup"` | 最常用，bot 私聊或公开群/频道 |
| 链接 | `"https://t.me/mygroup"` | 效果同上 |
| 数字 id | `"-1001234567890"` | 私有群/频道用这个（没有公开用户名） |

**三种场景的区别：**

| 场景 | 能做什么 | 说明 |
|------|---------|------|
| 私聊 bot | 发命令签到 | 最常见 |
| **群组** | 发命令签到 | 群里的签到 bot 会响应，**必须配 `botUsername`** 指明是哪个 bot 回复 |
| **频道** | 只能发通知 | 频道里 bot 不会响应命令；你的账号需是频道管理员才能发言 |

**取私有群的数字 id**：浏览器打开 https://web.telegram.org，进入该群，地址栏 `#-1001234567890` 里的那串就是。也可以直接粘贴 `https://t.me/c/1234567890/5` 这种链接，脚本会自动转成 `-1001234567890`。

### 签到结果推送到频道 / 群

账户级可选配置 `notify`，签到结束后自动把汇总发过去（用户账号需在该频道/群有发言权限）：

```js
notify: '@my_channel'
```

或只在有失败时推送：

```js
notify: { target: '-1001234567890', onlyOnFailure: true }
```

推送效果：

```
📋 签到汇总: 成功 2, 已签到 1, 失败 0
✅ @aaa_bot: 签到成功，获得 10 积分
☑️ @bbb_bot: 今日已签到
🕒 2026/10/23 18:50:00
```

### 第 5 步：跑一次看结果

日志会长这样：

```
[Telegram#1] 连接 Telegram (api_id=123456)...
[Telegram#1] 使用 SOCKS5 代理 127.0.0.1:10808
[Telegram#1] Telegram 登录成功: 你的名字 (@yourname)
[Telegram#1] 共 3 个目标待签到
[Telegram#1] @aaa_bot → 发送命令: /checkin
[Telegram#1] @aaa_bot 回复: 签到成功，获得 10 积分
[Telegram#1] ✅ @aaa_bot 签到成功
[Telegram#1] @my_group → 发送命令: /checkin
[Telegram#1] @my_group 回复: 签到成功
[Telegram#1] ✅ @my_group 签到成功
[Telegram#1] @ccc_bot 已点击按钮: 签到
[Telegram#1] 已发送签到汇总到 @my_channel
[Telegram#1] Telegram 签到完成: 成功 3, 已签到 0, 失败 0
```

### Telegram 代理说明

GramJS（MTProto 库）**只支持 SOCKS5 和 MTProxy，不支持 HTTP 代理**。

脚本会按这个顺序找代理：

1. 配置文件里该账号的 `proxy` 字段
2. 环境变量 `TG_PROXY` / `TELEGRAM_PROXY`
3. 环境变量 `ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`（按 SOCKS5 尝试）

> 也就是说：配置文件的 `proxy` 写了就用它；没写就自动复用青龙环境里已有的代理。

自测代理是否可用：

```bash
curl --socks5-hostname 127.0.0.1:10808 https://api.telegram.org
```

返回 302 就说明 SOCKS5 可用。Clash 的混合端口（默认 7890）同时支持 HTTP 和 SOCKS5，最省事。

### 常见问题

| 现象 | 原因 / 解决 |
|------|------------|
| `缺少 telegram 依赖` | 青龙依赖管理里装 `telegram` |
| `未找到 Telegram 配置, 跳过` | `config/config.js` 里还没有 `telegram` 段，按第 4 步加上 |
| `缺少 api_id / api_hash / session` | 配置文件里该账号这三个字段没填全，重跑 `telegram-login.js` 拿值 |
| `session 格式不正确: Not a valid string` | session 复制不完整或被截断，重跑 `telegram-login.js` |
| `没有配置任何签到目标 (bots 为空)` | 配置里该账号的 `bots` 数组还没填 |
| `connect ETIMEDOUT 149.154.167.91` | 直连不通，加 `--proxy socks5://127.0.0.1:10808`（登录）或配置 `proxy`（签到） |
| `连接 Telegram 超时` | 没配 SOCKS5 代理，或端口不支持 SOCKS5 |
| `session 已失效` | 在客户端里被"终止其他设备登录"了，重跑 `telegram-login.js` |
| `未收到回复` | bot 要求先 `/start`，把 `command` 改成 `["/start","/checkin"]` |
| 群里签到收到别人的消息 | 补上 `botUsername` 指定响应的 bot |
| `无法解析目标` | 私有群/频道用数字 id（`-100` 开头），或确认账号还在群里 |
| `发送汇总失败` | 用户账号没有该频道/群的发言权限（频道需管理员） |
| `未识别结果` | bot 回复文案特殊，加 `successKeywords` / `skipKeywords` 自定义 |
| 命令发了但没签到 | 可能是按钮式签到，加 `clickButton: "签到"` |

---

## Cookie 过期怎么办

`pmt_access` 只有约 15 分钟有效期，但服务端在每次请求的响应头里会**滚动下发新的 token**。脚本会把这些新 token 保存到本地缓存：

```
.cookie-store/isvoro-<账户>.json
```

下次运行时按这个顺序尝试：

1. 配置文件 `config/config.js` 里 `isvoro.accounts` 的 `cookie`
2. 上次运行保存的本地缓存

所以正常情况下，只要第一次能跑通，之后就能自动续期，不用天天手动换 Cookie。

如果两个来源都失效（日志会列出每个来源的失败原因），按上面的「方法 A」重新取一次 Cookie 填到 `config/config.js` 里即可，脚本会自动覆盖旧缓存。

> `.cookie-store/` 已加入 `.gitignore`，不会被提交到仓库。
> 想换个位置可以设 `ISVORO_COOKIE_DIR=/ql/data/config/cookie`。

## 新增其他网站

1. 复制 `handlers/example.js` 为 `handlers/yoursite.js`，修改类名和 API 逻辑
2. 在 `lib/config.js` 里加一个加载函数（照抄 `loadIsvoroAccounts` 改个名字）：
   ```js
   function loadYoursiteAccounts(logger) {
     const section = getSection('yoursite');
     if (section === null) return null; // 回退环境变量
     const list = toAccountList(section);
     ...
   }
   ```
3. 在 `checkin.js` 的 `siteRegistry` 中注册：
   ```js
   const { YourSiteHandler } = require('./handlers/yoursite');
   const { loadYoursiteAccounts } = require('./lib/config');

   const siteRegistry = {
     isvoro: { handler: IsvoroHandler, loadAccounts: loadIsvoroAccounts, envKey: 'ISVORO_ACCOUNTS', label: 'Isvoro' },
     yoursite: { handler: YourSiteHandler, loadAccounts: loadYoursiteAccounts, envKey: 'YOURSITE_ACCOUNTS', label: 'YourSite' },
   };
   ```
4. 在 `config/config.js` 里加一段 `yoursite: { accounts: [...] }`

> 不写 `loadAccounts` 时，运行器会直接读 `envKey` 对应的环境变量（旧行为），所以老站点不用改。

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
