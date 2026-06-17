# 钉钉知识库代理 + 学习报告生成器（钉钉 H5 微应用版）

一键部署到 Vercel，嵌入钉钉工作台，在钉钉里直接选知识库表格生成学习报告。

## 架构

```
┌─────────────────────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│   钉钉客户端（手机 / 桌面）   │────▶│    Vercel（部署在本仓库）    │────▶│  钉钉 OpenAPI    │
│  打开工作台 → 点工具图标     │     │                           │     │  gettoken        │
│                            │     │  /           index.html   │     │  listTables      │
│  dd.config → dd.ready      │     │  /api/proxy  代理转发     │     │  query           │
│  → 用户选知识库表           │     │  /api/dd-sign JSAPI 签名  │     │  getuserinfo     │
│  → 字段映射 → 生成报告      │     └──────────────────────────┘     └─────────────────┘
└─────────────────────────────┘
```

- **HTTPS 域名**：钉钉只认 HTTPS 地址，所以 V5.3.html 搬到 Vercel 上以 `public/index.html` 静态文件形式托管在 `/`
- **API 代理**：`/api/proxy` 帮前端换 access_token 并转发 AI 表格查询，corpSecret 不走前端
- **JSAPI 签名**：`/api/dd-sign` 用 HMAC-SHA1 算 dd.config 签名，保证在钉钉客户端内识别应用
- **用户身份**：前端 `dd.runtime.permission.requestAuthCode` 拿免登码 → 传给代理 → 换 userId

## 30 分钟部署路径

### 1. 在钉钉开放平台创建应用（5 分钟）

1. 打开 https://open-dev.dingtalk.com →「应用开发」→ 左侧「企业内部开发」→「H5 微应用」→「创建应用」
2. 填写应用名称（如「学习报告生成器」），点确定
3. 点进应用 → 左侧「凭证与基础信息」→ 复制：
   - **AppKey**（即 agentId）
   - **AppSecret**（agentSecret，**只能创建/重置时看一次，先记下来**）
   - **CorpId**（在「企业信息」或「凭证与基础信息」页面，形如 `dingxxxxxxxx`）

### 2. 部署到 Vercel（10 分钟）

#### 方式 A：网页一键导入（最简单）

1. 把整个 `dingtalk-proxy/` 目录上传到 GitHub 仓库（新建一个空仓库 `dingtalk-proxy`）
2. 打开 https://vercel.com → 用 GitHub 登录 →「New Project」→ 选刚上传的 `dingtalk-proxy` 仓库
3. 点 Deploy（Vercel 会自动识别 `vercel.json` 里的静态文件 + API 路由配置）
4. 部署完成后得到域名，**记下来**，形如：`https://dingtalk-proxy-xxx.vercel.app`

#### 方式 B：CLI 命令行

```bash
cd dingtalk-proxy
npm i -g vercel
vercel        # 第一次登录取名，跟着提示走
vercel --prod # 部署到生产环境
```

### 3. 配置环境变量（3 分钟）

1. Vercel 项目页面 → Settings → Environment Variables
2. 依次添加：

| Name | Value | 备注 |
|------|-------|------|
| `DINGTALK_APP_KEY` | `dingorqezq2hsweg6mxu` | 步骤 1 拿到的 AppKey（企业内部自建应用以 `ding` 开头） |
| `DINGTALK_APP_SECRET` | `OO911nuBR8p_...` | AppSecret |
| `DINGTALK_AGENT_ID` | `4684948052` | 应用的 AgentId（纯数字） |
| `DINGTALK_CORP_ID` | `dingbd0f8b6e65b535dea1320dcb25e91351` | 企业 corpId（`ding` 开头的 32 位 hex） |
| `ALLOW_ORIGIN` | `*` | 允许的来源，本地测试用 `*`，后续可改成 Vercel 域名 |

3. 点 Save → **再点一次 Deploy** 让环境变量生效

### 4. 把工具配到钉钉工作台（5 分钟）

1. 回到 https://open-dev.dingtalk.com → 你的应用 → 左侧「开发管理」
2. **应用首页地址**：填 `https://dingtalk-proxy-xxx.vercel.app`
3. **PC 端首页地址**：同上
4. **服务器出口 IP**：留空
5. 左侧「安全设置」→ **安全域名**：添加 `dingtalk-proxy-xxx.vercel.app`
6. 点「保存」→「版本管理与发布」→ 点「发布」
7. 发布成功后，在钉钉客户端（手机/PC）的工作台就能看到「学习报告生成器」图标

### 5. 在工具里填代理 URL（1 分钟）

1. 在钉钉里打开发布后的工具，或浏览器访问 `https://dingtalk-proxy-xxx.vercel.app`
2. 点「📡 钉钉知识库」按钮
3. 弹窗底部的「代理 URL」填：`https://dingtalk-proxy-xxx.vercel.app/api/proxy`
4. 按回车或点「🔄 重新加载」
5. 等列出表格 → 点你要的那张 → 自动进字段映射 → 导入
6. **代理 URL 会自动保存在浏览器/钉钉 localStorage 里，下次不用重新填**

### 6. 测试

浏览器打开：
```
https://dingtalk-proxy-xxx.vercel.app
```

应该看到学习报告生成器完整页面。再打开：
```
https://dingtalk-proxy-xxx.vercel.app/api/proxy?action=listTables
```

应该返回 JSON 带 `tables` 数组。

---

## dd.config 工作原理

代码已在 `public/index.html` 末尾的 `initDingTalkJSAPI()` 中写好。工作流程：

1. 页面加载 → 检查 `typeof dd !== 'undefined'`（只在钉钉客户端里存在）
2. 调 `/api/dd-sign?url=当前页面URL` 拿 `{ corpId, agentId, timeStamp, nonceStr, signature }`
3. `dd.config({...})` 鉴权
4. `dd.ready()` → `dd.runtime.permission.requestAuthCode()` → 拿到免登码
5. 后续点「📡 钉钉知识库」→ `callKBProxy()` 自动附带 `_ddAuthCode`
6. 代理用 authCode 换 userId，以用户身份调钉钉 API

**在普通浏览器里打开**：dd 对象不存在，所有 dd.xxx 代码静默跳过，工具仍然能用 Excel/JSON 导入功能。

---

## 故障排查

| 现象 | 原因 | 修复 |
|------|------|------|
| `环境变量未配置` | Vercel 没设 / 没重新部署 | 重设环境变量 → Redeploy |
| `gettoken 失败: invalid appkey` | agentId 填错 | 去开放平台重新复制 AppKey |
| `errcode=40001` | access_token 过期（极少见，Worker 内已自动重试） | 重试 |
| `errcode=60011` | 当前用户没该表格权限 | 让表格 owner 把表分享给应用 |
| 弹窗一直转圈 | 代理 URL 写错（漏了 `/api/proxy`） | 检查 URL 末尾 |
| CORS 报错 | ALLOW_ORIGIN 写错了 / 没设 | 临时改 `*` 测试 |

---

## 安全提醒

- **永远不要** 把 agentSecret commit 到 git / 写在前端代码里
- **永远不要** 把 Vercel 项目的 Environment Variables 截图发群里（含 secret 的截图都危险）
- ALLOW_ORIGIN 生产环境务必改成你的工具域名（默认 `*` 方便测试，但任何网站都能调你的代理）
- 如果怀疑 secret 泄露，去开放平台「重置 AppSecret」

---

## 进阶：换 Cloudflare Workers

如果想部署到 Cloudflare Workers（每天 10 万次免费，国内访问比 Vercel 快）：

把 `api/proxy.js` 改成 Cloudflare 的 fetch handler 即可，逻辑不变。需要的转化：
- `export default async function handler(req, res)` → Cloudflare 的 `addEventListener('fetch', event => event.respondWith(handle(event.request)))`
- `res.setHeader` / `res.status().json()` → 改成 `new Response(JSON.stringify(...), { headers, status })`
