// api/proxy.js
// 钉钉知识库代理 — 部署到 Vercel
// 暴露两个 action：
//   ?action=listTables               列出当前用户有权限的 AI 表格
//   ?action=query&appUuid=xxx        拉取某张表格的所有记录（最多 1000 条）
// 环境变量（在 Vercel 后台配置）：
//   DING_CORP_ID        企业 corp id (dingxxxxxxxx)
//   DING_AGENT_ID       应用 agent id
//   DING_AGENT_SECRET   应用 agent secret（重置后只能创建时显示一次）
// 可选：
//   DING_API_BASE       钉钉 API 域名（默认 https://oapi.dingtalk.com）
//   ALLOW_ORIGIN        允许的来源（默认 *，生产建议改成工具所在域名）

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json; charset=utf-8',
});

let _tokenCache = { value: '', expires: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache.value && now < _tokenCache.expires) return _tokenCache.value;

    // 同时支持 DING_* 和 DINGTALK_APP_* 两套变量名（向后兼容）
    const corpId = process.env.DING_CORP_ID || process.env.DINGTALK_CORP_ID || '';
    const agentId = process.env.DING_AGENT_ID || process.env.DINGTALK_AGENT_ID || '';
    const secret = process.env.DING_AGENT_SECRET || process.env.DINGTALK_APP_SECRET || '';
    const appKey = process.env.DINGTALK_APP_KEY || process.env.DING_AGENT_ID || '';
    if (!appKey || !secret) {
      throw new Error('环境变量 DINGTALK_APP_KEY / DINGTALK_APP_SECRET 未配置');
    }

    // 企业内部应用：用 appKey + secret 换 token
    const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(secret)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.access_token) {
    throw new Error('gettoken 失败：' + (j.errmsg || JSON.stringify(j)));
  }
  _tokenCache = { value: j.access_token, expires: now + Math.max(60, (j.expires_in || 7200) - 200) * 1000 };
  return j.access_token;
}

// 用免登授权码换用户级 access_token（可选：当前端传了 _ddAuthCode）
async function getUserToken(authCode) {
  if (!authCode) return null;
    // 同时支持 DING_* 和 DINGTALK_APP_* 两套变量名
    const agentId = process.env.DING_AGENT_ID || process.env.DINGTALK_AGENT_ID || '';
    const secret = process.env.DING_AGENT_SECRET || process.env.DINGTALK_APP_SECRET || '';
    const corpId = process.env.DING_CORP_ID || process.env.DINGTALK_CORP_ID || '';
    if (!agentId || !secret || !corpId) return null;

  try {
    // 先换 app 级 token
    const appToken = await getAccessToken();
    // 再用 authCode 换用户 token
    const r = await fetch(
      `https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(appToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: authCode }),
      }
    );
    const j = await r.json();
    if (j.errcode === 0 && j.result && j.result.userid) {
      // 返回 userid，后续 API 调用可以用这个身份
      return { userId: j.result.userid, accessToken: appToken };
    }
    console.warn('getuserinfo 失败：', j.errmsg);
    return null;
  } catch (e) {
    console.warn('getUserToken 失败：', e.message);
    return null;
  }
}

async function dingGet(path, query = {}, operatorId = '') {
  // 钉钉新版 OpenAPI 用 ACS token header 鉴权
  const token = await getAccessToken();
  const qs = new URLSearchParams(query).toString();
  const url = `https://api.dingtalk.com${path}${qs ? '?' + qs : ''}`;
  const headers = {
    'x-acs-dingtalk-access-token': token,
    'Content-Type': 'application/json',
  };
  if (operatorId) {
    // 钉钉新版 v2.0 接口同时支持 query 和 header 两种 operatorId
    headers['x-acs-operator-id'] = operatorId;
  }
  const r = await fetch(url, { method: 'GET', headers });
  const j = await r.json();
  if (j.code !== undefined && j.code !== 0) {
    throw new Error(`dingGet ${path}: code=${j.code} message=${j.message || ''}`);
  }
  return j;
}

async function dingPost(path, body, operatorId = '') {
  const token = await getAccessToken();
  const url = `https://api.dingtalk.com${path}`;
  const headers = {
    'x-acs-dingtalk-access-token': token,
    'Content-Type': 'application/json',
  };
  if (operatorId) {
    headers['x-acs-operator-id'] = operatorId;
  }
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (j.code !== undefined && j.code !== 0) {
    throw new Error(`dingPost ${path}: code=${j.code} message=${j.message || ''}`);
  }
  return j;
}

async function listTables(operatorId) {
  // 钉钉新版知识库列表（OpenAPI 官方）
  // GET /v2.0/wiki/workspaces
  // 必须传 operatorId（前端 dd.config 拿到的 unionId/userid）
  // ⚠️ operatorId 只走 header（x-acs-operator-id），不要塞 query，避免中文/特殊字符触发 fetch 的 ByteString 报错
  return await dingGet('/v2.0/wiki/workspaces', {
    maxResults: 30,
    orderBy: 'MODIFIED_TIME_DESC',
  }, operatorId);
}

async function queryTable(appUuid, maxResults, operatorId) {
  // 知识库节点列表
  return await dingGet('/v2.0/wiki/nodes', {
    workspaceId: appUuid,
    maxResults: Math.min(50, maxResults || 50),
  }, operatorId);
}

export default async function handler(req, res) {
  // CORS
  const headers = CORS(req.headers.origin);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    // 如果前端传了 dd 免登授权码，优先用用户身份
    // ⚠️ 兼容两种传法：
    //   - URL query: ?_ddAuthCode=xxx  (历史写法)
    //   - HTTP header: x-dd-authcode: xxx  (新写法，避免 URL 编码/特殊字符问题)
    const authCode =
      req.query._ddAuthCode ||
      req.headers['x-dd-authcode'] ||
      req.headers['x-acs-dingtalk-authcode'] ||
      '';
    let userInfo = null;
    if (authCode) {
      try {
        userInfo = await getUserToken(authCode);
        console.log('[proxy] 用户身份：', userInfo?.userId || '解析失败');
      } catch(e) {
        console.warn('[proxy] 用户身份解析失败，回退到 agent token：', e.message);
      }
    }

    // operatorId：v2.0 接口必须传用户 unionId/userid
    // 接收顺序：query.operatorId > header.x-dd-operator-id > 从 authCode 解析
    // ⚠️ operatorId 永远走 header 传给钉钉 API，绝不放 URL query（中文/特殊字符会触发 fetch ByteString 报错）
    const operatorId =
      req.query.operatorId ||
      req.headers['x-dd-operator-id'] ||
      (userInfo && userInfo.userId) ||
      '';

    const action = req.query.action;
    if (action === 'whoami') {
      // ⚠️ 单独提供"用 authCode 换 userid"端点，前端首次进入钉钉时调用
      // 返回 { ok, userId, nick, unionId } —— 前端拿到后存到 localStorage 后续所有请求都传
      if (!userInfo) {
        res.status(400).json({
          ok: false,
          errcode: 'MissingAuthCode',
          errmsg: 'whoami 需要传 x-dd-authcode header（从 dd.runtime.permission.requestAuthCode 拿到的 code）。请确认页面是在钉钉容器里打开的。',
        });
        return;
      }
      res.status(200).json({
        ok: true,
        userId: userInfo.userId,
        agentId: process.env.DING_AGENT_ID || process.env.DINGTALK_AGENT_ID || '',
        corpId: process.env.DING_CORP_ID || process.env.DINGTALK_CORP_ID || '',
      });
      return;
    }
    if (action === 'listTables') {
      if (!operatorId) {
        res.status(400).json({
          ok: false,
          errcode: 'MissingOperatorId',
          errmsg: 'listTables 需要传 operatorId（用户 unionId/userid）。请在钉钉里打开页面让前端自动从 dd.config 拿到；或在 URL 后面加 ?operatorId=YOUR_USERID。',
        });
        return;
      }
      const data = await listTables(operatorId);
      // 标准化输出：让前端简单判断
      const workspaces = data.workspaces || data.data?.workspaces || data.result?.list || [];
      res.status(200).json({
        ok: true,
        tables: workspaces.map(w => ({
          id: w.workspaceId || w.uuid,
          name: w.name,
          url: w.url,
          modified: w.gmtModified,
        })),
        user: userInfo ? { userId: userInfo.userId } : null,
        raw: data,
      });
    } else if (action === 'query') {
      const appUuid = req.query.appUuid;
      if (!appUuid) {
        res.status(400).json({ ok: false, errmsg: 'appUuid 必填（用 listTables 返回的 id）' });
        return;
      }
      if (!operatorId) {
        res.status(400).json({
          ok: false,
          errcode: 'MissingOperatorId',
          errmsg: 'query 需要传 operatorId。请在钉钉里打开页面，或加 ?operatorId=YOUR_USERID。',
        });
        return;
      }
      const data = await queryTable(appUuid, parseInt(req.query.maxResults) || 50, operatorId);
      const nodes = data.nodes || data.data?.nodes || data.result?.list || [];
      res.status(200).json({
        ok: true,
        records: nodes.map(n => ({
          id: n.nodeId || n.uuid,
          name: n.name,
          type: n.type || n.dentryType,
          url: n.url,
        })),
        user: userInfo ? { userId: userInfo.userId } : null,
        raw: data,
      });
    } else {
      res.status(400).json({
        ok: false,
        errmsg: '未知 action，可选：listTables / query',
      });
    }
  } catch (err) {
    res.status(500).json({
      ok: false,
      errcode: -1,
      errmsg: err.message || String(err),
    });
  }
}
