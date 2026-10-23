# 多站点自动签到

青龙面板自动签到脚本，支持 Isvoro 网站签到、Telegram bot 命令签到，架构上预留其他网站扩展。

## 文件结构

```
websign/
├── checkin.js               # 主入口 (站点注册表)
├── runner.js                # 签到运行器 (调度、汇总)
├── telegram-login.js        # Telegram 登录助手 (生成 session, 只需跑一次)
├── config/
│   └── config.example.yaml  # 统一配置模板 (复制为 config.yaml 使用)
├── lib/
│   ├── config.js            # 统一配置加载 (所有站点共用)
│   ├── yaml.js              # 轻量 YAML 解析器 (零依赖)
│   ├── telegram-config.js   # Telegram 配置加载
│   └── telegram-proxy.js    # Telegram 代理解析
├── handlers/
│   ├── base.js              # 站点处理器基类 (定义接口规范)
│   ├── isvoro.js            # Isvoro 签到处理器
│   ├── telegram.js          # Telegram bot 签到处理器
│   └── example.js           # 示例模板 (新增网站时复制修改)
```

> 只有 `config/config.example.yaml` 进仓库；你自己填的 `config/config.yaml` 已被 `.gitignore` 忽略。

## 青龙面板配置

### 1. 添加脚本

将以下文件放入青龙面板的 `scripts/websign/` 目录：

- `checkin.js`
- `runner.js`
- `handlers/base.js`
- `handlers/isvoro.js`
- `handlers/telegram.js`（要用 Telegram 签到才需要）
- `lib/config.js`、`lib/yaml.js`、`lib/telegram-config.js`、`lib/telegram-proxy.js`
- `config/config.example.yaml`（配置模板；青龙订阅默认不同步 yaml，见 2.1）
- `telegram-login.js`（只在你自己电脑上跑，不用放青龙）

> 用订阅拉取时，如果脚本管理里看不到 `config/` 目录，看下一节 2.1。

### 2. 创建配置文件

**所有配置都在 `config/config.yaml` 一个文件里，不需要配任何环境变量。**

```bash
cp config/config.example.yaml config/config.yaml
```

模板里每一项都写了注释，照着填即可。最简可用版本：

```yaml
isvoro:
  accounts:
    - name: 主号
      cookie: 'pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz'

telegram:
  - name: 主账号
    api_id: 1234567
    api_hash: '0123456789abcdef0123456789abcdef'
    session: '1BVtsOK...'
    proxy: 'socks5://127.0.0.1:10808'
    bots:
      - username: aaa_bot
        command: /checkin
```

不需要的站点整段删掉即可，脚本会自动跳过。

**YAML 三个容易踩的坑：**

| 坑 | 错误写法 | 正确写法 |
|---|---|---|
| 冒号后缺空格 | `name:主号` | `name: 主号` |
| 用了 Tab 缩进 | Tab | 2 个空格 |
| 值里有 `;` `=` `:` `#` 没加引号 | `cookie: pmt_access=a; x` | `cookie: 'pmt_access=a; x'` |

写错了不会静默跳过，会直接告诉你第几行错在哪：

```
❌ 配置文件有误:
读取配置文件失败: config/config.yaml
  第 12 行: 缩进不一致 (同级列表项应为 4 个空格, 这一行是 5 个)
```

**配置文件放哪**（按优先级查找，命中即用）：

1. 环境变量 `CONFIG_FILE` 指定的路径
2. `<项目>/config/config.yaml`
3. `/ql/data/config/websign.yaml`（青龙数据目录，**自动识别，推荐**）
4. `<项目>/config/config.yml`
5. `config/config.json` / `config/config.js`（兼容旧版，不再推荐）

### 2.1 青龙脚本管理里看不到 config 目录 / 没有 yaml 模板

**原因**：青龙订阅拉取（`ql repo`）只同步**指定后缀**的文件。这个后缀由
`/ql/data/config/config.sh` 里的 `RepoFileExtensions` 决定，默认值是：

```bash
RepoFileExtensions="js mjs py pyc"
```

`.yaml` 不在里面，所以 `config/config.example.yaml` 根本没被拉下来 ——
`config/` 变成空目录，青龙不显示空目录，脚本管理里自然看不到它。

**做法 1（推荐）：改全局后缀，所有订阅都生效**

```bash
docker exec -it qinglong sh
vi /ql/data/config/config.sh
```

把这一行改成（**在后面追加** `yaml yml`，原来的别删）：

```bash
RepoFileExtensions="js mjs py pyc yaml yml"
```

保存后重启青龙容器让配置生效：

```bash
docker restart qinglong
```

再回到订阅管理点「运行」，刷新脚本管理，`websign/config/` 和
`config.example.yaml` 就都出来了。

**做法 2：只改这一个订阅**

订阅管理 → 编辑订阅 → **「文件后缀」** 填：

```
js mjs py pyc yaml yml
```

> ⚠️ 两个坑：
> 1. **空格分隔**，不是逗号也不是 `&`。
> 2. 一旦这里填了值，就会**覆盖**全局的 `RepoFileExtensions`。所以必须把
>    `js mjs py pyc` 一起写上，只写 `yaml` 会导致连 `checkin.js` 都拉不下来。

保存后运行一次订阅即可。

**做法 3：配置不放 scripts，放青龙数据目录（最稳）**

如果只是想让脚本能读到配置、不在乎在脚本管理里看到它：

```bash
docker exec -it qinglong sh
mkdir -p /ql/data/config
vi /ql/data/config/websign.yaml    # 把 config.example.yaml 的内容粘进去，改好
```

脚本会自动查找 `/ql/data/config/websign.yaml`，不需要配任何环境变量。
更新订阅、删脚本、重装容器都不会碰到它。

> 注意：`config/config.yaml` 在 `.gitignore` 里，仓库只有 `config.example.yaml`。
> 所以订阅永远只会拉下模板，你自己复制出来的 `config.yaml` 不在仓库里，
> 订阅更新时可能被清掉 —— 这也是推荐做法 3 的原因。
> 在面板里可以直接右键 `config.example.yaml` → 复制 → 改名 `config.yaml`。

> 环境变量（`ISVORO_ACCOUNTS`、`TELEGRAM_ACCOUNTS`、`TELEGRAM_API_ID` 等）仍可用作兼容回退，但**配置文件优先级更高**。新部署直接用配置文件即可。
>
> YAML 解析优先用已安装的 `js-yaml` / `yaml` 包，青龙里没装也没关系 —— 项目自带零依赖解析器。

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

```yaml
isvoro:
  accounts:
    - name: 主号
      cookie: '...'
      proxy: 'http://192.168.1.10:7890'
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

**填到配置文件里**（整行 Cookie 直接粘到 `cookie` 字段，外面套单引号即可，不需要转义）：

```yaml
isvoro:
  accounts:
    - name: 主号
      cookie: 'pmt_access=xxx; pmt_refresh=yyy; pmt_csrf=zzz'
```

**多账户**：`accounts` 下面加多个 `- name:` 项即可：

```yaml
isvoro:
  accounts:
    - name: 主号
      cookie: 'pmt_access=aaa; pmt_refresh=bbb; pmt_csrf=ccc'
    - name: 小号
      cookie: 'pmt_access=ddd; pmt_refresh=eee; pmt_csrf=fff'
```

### 方式二：密码登录（可能被验证码拦截）

如果网站暂时关闭了验证码，可以改用密码方式：

```yaml
isvoro:
  accounts:
    - name: 主号
      email: your@email.com
      password: 'yourpassword'
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

运行结束会直接打印一段**可粘贴的 YAML 配置块**（含 `api_id` / `api_hash` / `session`），照着放进 `config/config.yaml` 即可。

> `session` 等于你的登录凭证，泄露等于账号被登录，切勿外传。

### 第 4 步：写进配置文件

登录助手会直接打印一段可以直接粘贴的配置块，加到 `config/config.yaml` 的 `telegram` 列表里：

```yaml
telegram:
  - name: 主账号                          # 日志里显示的名字
    api_id: 1234567
    api_hash: '0123456789abcdef0123456789abcdef'
    session: '1BVtsOK...'                 # 长串直接放单引号里，不需要转义
    proxy: 'socks5://127.0.0.1:10808'     # 可选
    notify: ''                            # 可选: 签到汇总发到频道/群
    bots:
      - username: aaa_bot
        command: /checkin
      - username: bbb_bot
        command: /daily sign
      - username: ccc_bot
        command: ['/start', '/checkin']
        clickButton: '签到'
      - target: '@my_group'
        command: /checkin
        botUsername: ddd_bot
      - target: '-1001234567890'
        command: /qd
        botUsername: eee_bot
```

> **session 为什么可以直接写在文件里**：它只是一段文本，不经过 JSON 序列化，`+` `/` `=` 都不会出问题。脚本还会自动去掉粘贴时带入的换行和空格。

多账号就在 `telegram` 下面加第二个 `- name:` 项，每个账号自带自己的 `api_id` / `api_hash` / `session`：

```yaml
telegram:
  - name: 主账号
    api_id: 1111111
    api_hash: '...'
    session: '...'
    bots:
      - username: aaa_bot
        command: /checkin

  - name: 小号
    api_id: 2222222
    api_hash: '...'
    session: '...'
    bots:
      - username: aaa_bot
        command: /checkin
```

**每个目标支持的字段：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `username` / `target` | 是 | 目标，三种写法见下方「发到群组 / 频道」 |
| `command` | 是 | 要发送的命令；数组可发多条，如 `['/start', '/checkin']` |
| `botUsername` | 否 | **群/频道里签到必填**，指定由哪个 bot 响应，用于过滤无关消息 |
| `clickButton` | 否 | 若回复带内联按钮，自动点击文字匹配的按钮（如 `'签到'`） |
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
| 用户名 | `aaa_bot` / `'@mygroup'` | 最常用，bot 私聊或公开群/频道 |
| 链接 | `'https://t.me/mygroup'` | 效果同上 |
| 数字 id | `'-1001234567890'` | 私有群/频道用这个（没有公开用户名） |

> `-100` 开头的负数一定要加引号，否则会被当成数字处理。

**三种场景的区别：**

| 场景 | 能做什么 | 说明 |
|------|---------|------|
| 私聊 bot | 发命令签到 | 最常见 |
| **群组** | 发命令签到 | 群里的签到 bot 会响应，**必须配 `botUsername`** 指明是哪个 bot 回复 |
| **频道** | 只能发通知 | 频道里 bot 不会响应命令；你的账号需是频道管理员才能发言 |

**取私有群的数字 id**：浏览器打开 https://web.telegram.org，进入该群，地址栏 `#-1001234567890` 里的那串就是。也可以直接粘贴 `https://t.me/c/1234567890/5` 这种链接，脚本会自动转成 `-1001234567890`。

### 签到结果推送到频道 / 群

账户级可选配置 `notify`，签到结束后自动把汇总发过去（用户账号需在该频道/群有发言权限）：

```yaml
    notify: '@my_channel'
```

或只在有失败时推送（用嵌套写法）：

```yaml
    notify:
      target: '-1001234567890'
      onlyOnFailure: true
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
| `未找到 Telegram 配置, 跳过` | `config/config.yaml` 里还没有 `telegram` 段，按第 4 步加上 |
| `配置文件里没有 telegram 段, 跳过` | 正常提示，说明你只配了 Isvoro，不需要处理 |
| `缺少 api_id / api_hash / session` | 配置文件里该账号这三个字段没填全，重跑 `telegram-login.js` 拿值 |
| `session 格式不正确: Not a valid string` | session 复制不完整或被截断，重跑 `telegram-login.js` |
| `没有配置任何签到目标 (bots 为空)` | 配置里该账号的 `bots` 列表还没填 |
| `connect ETIMEDOUT 149.154.167.91` | 直连不通，加 `--proxy socks5://127.0.0.1:10808`（登录）或配置 `proxy`（签到） |
| `连接 Telegram 超时` | 没配 SOCKS5 代理，或端口不支持 SOCKS5 |
| `session 已失效` | 在客户端里被"终止其他设备登录"了，重跑 `telegram-login.js` |
| `未收到回复` | bot 要求先 `/start`，把 `command` 改成 `['/start', '/checkin']` |
| 群里签到收到别人的消息 | 补上 `botUsername` 指定响应的 bot |
| `无法解析目标` | 私有群/频道用数字 id（`-100` 开头，记得加引号），或确认账号还在群里 |
| `发送汇总失败` | 用户账号没有该频道/群的发言权限（频道需管理员） |
| `未识别结果` | bot 回复文案特殊，加 `successKeywords` / `skipKeywords` 自定义 |
| 命令发了但没签到 | 可能是按钮式签到，加 `clickButton: '签到'` |

---

## 配置文件常见问题

| 现象 | 原因 / 解决 |
|------|------------|
| `第 N 行: 缩进不一致` | 同一级的键必须对齐，用 2 个空格一级，别混 Tab |
| `第 N 行: 缩进不能用 Tab` | 编辑器把 Tab 插进来了，改成空格 |
| `第 N 行: 引号没有闭合` | 值里有 `'` 或漏了结尾引号；单引号里要写 `''` |
| `第 N 行: 不是合法的 "键: 值" 格式` | 冒号后面要有一个空格：`name: 主号` |
| `不支持多行文本块 (| 或 >)` | cookie/session 都写一行，用引号包住 |
| `读取配置文件失败` | 上面会给出具体行号，按提示改那一行 |
| 配置改了但日志还是旧的 | 青龙里脚本没更新，或 `CONFIG_FILE` 指向了别的文件 |

---

## 运行结果常见问题

| 日志 | 含义 / 处理 |
|------|------------|
| `✅ 今日已签到 (POINT_ALREADY_CHECKED_IN)` | **正常**。今天已经签过了，记为「已签到」而不是失败，退出码为 0 |
| `查询签到状态失败, 继续尝试签到` | 状态接口超时（15s 不重试），不影响结果，签到接口会给出最终答案 |
| `请求失败 (网络错误 ETIMEDOUT), 1000ms 后第 1 次重试` | 网络抖动，脚本自动重试；连续失败就检查代理 |
| `已保存 Cookie 缓存: .../isvoro-主号.json` | 滚动下发的新 token 已存本地，下次直接复用 |
| `jwt malformed` / `状态更新失败(Validation failed)` | **青龙自身**在更新任务状态时 token 失效，跟签到无关。重新登录青龙面板，或 `docker restart qinglong` |
| 退出码 1 | 只有真的失败（网络不通、Cookie 失效、bot 全挂）才会这样；「已签到」不算失败 |

---

## Cookie 过期怎么办

`pmt_access` 只有约 15 分钟有效期，但服务端在每次请求的响应头里会**滚动下发新的 token**。脚本会把这些新 token 保存到本地缓存：

```
.cookie-store/isvoro-<账户>.json
```

下次运行时按这个顺序尝试：

1. 配置文件 `config/config.yaml` 里 `isvoro.accounts` 的 `cookie`
2. 上次运行保存的本地缓存

所以正常情况下，只要第一次能跑通，之后就能自动续期，不用天天手动换 Cookie。

如果两个来源都失效（日志会列出每个来源的失败原因），按上面的「方法 A」重新取一次 Cookie 填到 `config/config.yaml` 里即可，脚本会自动覆盖旧缓存。

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
4. 在 `config/config.yaml` 里加一段：
   ```yaml
   yoursite:
     accounts:
       - name: 主号
         username: xxx
         password: 'yyy'
   ```

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
