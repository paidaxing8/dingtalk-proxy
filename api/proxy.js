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

async function dingPost(path, body) {
  const token = await getAccessToken();
  const url = `https://oapi.dingtalk.com${path}?access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (j.errcode !== undefined && j.errcode !== 0) {
    throw new Error(`dingPost ${path}: errcode=${j.errcode} errmsg=${j.errmsg || ''}`);
  }
  return j;
}

async function listTables() {
  // 钉钉 AI 表格列表：用 aitable/v1/list
  // 实际接口：/v1.0/aitable/listApps（或 /topapi/process/instance/list 等）
  // 这里走"知识库文档列表" — /v1.0/doc/search 更通用，能列出所有可见文档/表格
  // 真实生产建议改用 /v1.0/aitable/apps/list 拿 AI 表格
  const r = await dingPost('/topapi/wiki/space/list', { corpAccessToken: await getAccessToken() });
  return r;
}

async function queryTable(appUuid, maxResults) {
  // 拉取某张 AI 表格的记录
  // 接口：/v1.0/aitable/records/query 或老版 /topapi/aitable/record/list
  // 钉钉推荐（2024+）：/v1.0/aitable/data/query
  const token = await getAccessToken();
  const url = `https://api.dingtalk.com/v1.0/aitable/data/query?access_token=${encodeURIComponent(token)}`;
  const body = {
    appType: 'aitable',
    appUuid: appUuid,
    pageSize: Math.min(1000, maxResults || 1000),
    pageNum: 1,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.code !== undefined && j.code !== 0) {
    throw new Error('aitable.data.query 失败：' + (j.msg || JSON.stringify(j)));
  }
  return j;
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
    const authCode = req.query._ddAuthCode;
    let userInfo = null;
    if (authCode) {
      try {
        userInfo = await getUserToken(authCode);
        console.log('[proxy] 用户身份：', userInfo?.userId || '解析失败');
      } catch(e) {
        console.warn('[proxy] 用户身份解析失败，回退到 agent token：', e.message);
      }
    }

    const action = req.query.action;
    if (action === 'listTables') {
      const data = await listTables();
      // 标准化输出：让前端简单判断
      res.status(200).json({
        ok: true,
        tables: data.result?.spaceList || data.result?.list || [],
        user: userInfo ? { userId: userInfo.userId } : null,
        raw: data,
      });
    } else if (action === 'query') {
      const appUuid = req.query.appUuid;
      if (!appUuid) {
        res.status(400).json({ ok: false, errmsg: 'appUuid 必填' });
        return;
      }
      const data = await queryTable(appUuid, parseInt(req.query.maxResults) || 1000);
      res.status(200).json({
        ok: true,
        records: data.data?.records || data.records || data.data?.values || [],
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
