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

**单账户：**
```
{"email":"your@email.com","password":"yourpassword"}
```

**多账户：**
```
[{"email":"a@test.com","password":"111"},{"email":"b@test.com","password":"222"}]
```

### 3. 添加定时任务

```
名称: Isvoro 签到
命令: task websign/checkin.js
定时: 30 8 * * *
```

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
| 登录 | POST | `/auth/login` | body: `{email, password}` |
| 签到状态 | GET | `/points/checkin/status` | 查询今日是否已签到 |
| 签到 | POST | `/points/checkin` | 执行签到 |
| CSRF | - | Cookie `pmt_csrf` → 请求头 `X-CSRF-Token` | POST 请求需要 |
