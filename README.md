# ChatGPT Session 注入工具 - 使用教程

## 原理

通过 `https://chatgpt.com/api/auth/session` 获取的 session.json 文件中，`sessionToken` 字段就是加密的鉴权 cookie。但由于其长度超过 4096 字符，浏览器 CDP 协议和 `document.cookie` API 均无法设置它。

本工具绕过限制，直接将 cookie 写入 Chromium 的 Cookies SQLite 数据库文件，浏览器启动时自动加载，实现免密登录。

---

## 准备工作

### 1. 安装依赖（仅首次）

```bash
npm install
npx playwright install chromium
```

### 2. 获取 session.json

在已登录 ChatGPT 的浏览器中访问：

```
https://chatgpt.com/api/auth/session
```

把页面返回的 JSON **全部复制**，保存为 `.json` 文件（例如 `account.json`）。

---

## 模式一：本地系统浏览器（chrome 模式）

用于快速测试 session 是否有效，或在不使用指纹浏览器时直接操作。

```bash
node inject-session.js ./account.json chrome
```

- 自动检测并使用系统中安装的 Chrome 或 Edge
- 弹出一个独立的浏览器窗口，已登录目标账号
- 按 `Enter` 关闭浏览器

### 安全提示

`chrome` 模式会创建临时浏览器 profile（`tmp-gpt-profile` 目录），关闭后 cookie 仍残留在该目录。如需彻底清理：

```bash
rm -rf ./tmp-gpt-profile
```

---

## 模式二：AdsPower 指纹浏览器（推荐）

每个账号配一个独立指纹环境，避免关联封号。

### 前置步骤（仅首次配置）

#### A. 确认 AdsPower 本地 API 已开启

打开 AdsPower → **设置 → 本地API**：
- ✅ 勾选「开启本地API服务」
- 端口默认 `50325`（不要改动）

#### B. 为每个账号创建独立的浏览器环境

1. 点击 AdsPower 主界面的 **「新建浏览器」**
2. 配置：
   - **名称**：填账号标识，如 `账号A`
   - **代理**：建议配置独立代理 IP（如无代理可先跳过，但同 IP 多账号有封号风险）
   - **指纹**：保持默认随机生成即可
3. 点击确定创建

#### C. 获取 Profile ID

刚创建的浏览器会在账号列表中。点击 **「打开」** 该浏览器，地址栏 URL 中包含 `user_id=`：

```
https://start.adspower.net/?id=example_id_001&host=...
                                  ^^^^^^^^^
                                  这就是 Profile ID
```

或者通过 API 查询（浏览器不需要打开）：

```bash
curl "http://127.0.0.1:50325/api/v1/user/list"
```

返回的 JSON 中 `user_id` 字段即为 ID。

### 使用

```bash
# 语法
node inject-session.js <session文件> adspower <profile_id>

# 示例
node inject-session.js ./account.json adspower example_id_001
```

脚本会自动：
1. 关闭目标 AdsPower 窗口（如果已打开）
2. 等待进程完全退出
3. 将 session cookie 写入该 profile 的数据库
4. 重新启动浏览器
5. 打开 ChatGPT（此时已是目标账号登录态）

---

## 模式三：Bit 浏览器

### 前置步骤

1. 打开 Bit Browser → **设置 → 本地API**：
   - ✅ 勾选「开启本地API服务」
   - 端口默认 `54345`

2. 为每个账号创建独立的浏览器环境，获取 Profile ID

### 使用

```bash
node inject-session.js <session文件> bit <profile_id>
```

脚本会自动：
1. 将 session cookie 写入该 profile 的数据库
2. 尝试通过 API 启动浏览器并打开 ChatGPT
3. 如果 API 启动失败，请手动从 Bit Browser 控制台打开对应 profile

> 注意：首次使用需先手动打开过该 profile（至少一次），以生成缓存文件。

---

## 日常使用流程

### 1. 获取 session.json

访问 `https://chatgpt.com/api/auth/session`，复制全部 JSON 内容。保存到本地，例如：

```
./sessions/account-20260516.json
```

### 2. 注入登录

```bash
node inject-session.js ./sessions/account-20260516.json adspower <ProfileID>
```

### 3. 操作账号

浏览器窗口自动打开，已登录目标账号，即可进行所需操作。

### 4. 关闭

回到终端按 `Enter` 关闭浏览器。

### 5. 切换下一个账号

```bash
node inject-session.js ./sessions/account-B-20260516.json adspower <另一个ProfileID>
```

---

## 多账号管理建议

| 账号 | Session 文件 | AdsPower Profile ID | 备注 |
|------|-------------|---------------------|------|
| 账号A | `sessions/账号A.json` | `example_id_001` | - |
| 账号B | `sessions/账号B.json` | `abc12345` | - |

> **重要**：每个账号使用独立的 AdsPower profile，且尽量配独立代理 IP。同一 IP 下多个 ChatGPT 账号操作容易被 OpenAI 风控。

---

## 常见问题

### Q: session 过期了怎么办？

重新访问 `https://chatgpt.com/api/auth/session` 获取新的 session.json。

Session 有效期通常为 1-3 个月。

### Q: AdsPower 模式报「未找到 profile 缓存目录」？

检查 AdsPower 是否已打开过该 profile（至少一次）。首次使用需要先手动在 AdsPower 中打开一次，让系统生成缓存文件。

### Q: 浏览器打开后仍然显示未登录？

- 检查 session 是否过期（看 `expires` 字段）
- 确认 AdsPower profile 中是否配置了代理（某些网络直连 ChatGPT 可能不通）
- 尝试用 `chrome` 模式先验证 session 有效性

### Q: 脚本卡在「等待浏览器进程退出」？

手动结束所有 SunBrowser 进程：
```bash
taskkill /f /im SunBrowser.exe
```

### Q: 能否同时操作多个账号？

不能同时。AdsPower 每个 profile 同时只能有一个窗口。完成一个账号的操作后，关闭窗口再操作下一个。

---

## 参数速查

```
node inject-session.js <session文件> [模式] [profile_id] [端口]

参数:
  session文件    必需。session.json 文件路径
  模式           可选。chrome(默认) / adspower / bit
  profile_id     指纹浏览器模式时必需
  端口           可选。AdsPower API 端口（默认 50325）
                 或 Bit 浏览器 API 端口（默认 54345）
```
