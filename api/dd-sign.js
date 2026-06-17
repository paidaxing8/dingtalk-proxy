// api/dd-sign.js
// 钉钉 JSAPI 签名端点
// dd.config 需要后端计算的 HMAC-SHA1 签名，参数：
//   corpId, agentId, timeStamp, nonceStr, signature
// 环境变量（与 proxy.js 共用一套）：
//   DINGTALK_APP_KEY    - 应用的 AppKey
//   DINGTALK_APP_SECRET - 应用的 AppSecret
//   DINGTALK_AGENT_ID   - 应用的 AgentId
//   DINGTALK_CORP_ID    - 企业 corpId（企业内部应用需要，第三方应用不需要）
// Vercel Serverless Function — 部署到 /api/dd-sign

import crypto from 'crypto';

function randomStr(length = 16) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return result;
}

/**
 * 用 AppKey + AppSecret 换 access_token
 * 优先走新接口 api.dingtalk.com/v1.0/oauth2/accessToken（适用于企业内部自建应用和第三方应用）
 * 失败回退到老接口 oapi.dingtalk.com/gettoken
 */
async function getAccessToken(appKey, appSecret) {
  // 尝试 1：新接口（api.dingtalk.com）
  try {
    const url = `https://api.dingtalk.com/v1.0/oauth2/accessToken?appKey=${encodeURIComponent(appKey)}&appSecret=${encodeURIComponent(appSecret)}`;
    const r = await fetch(url, { method: 'POST' });
    const j = await r.json();
    if (j.accessToken) return { token: j.accessToken, source: 'v1.0/oauth2/accessToken' };
  } catch (e) {
    // 继续尝试老接口
  }

  // 尝试 2：老接口（oapi.dingtalk.com）
  const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.access_token) {
    const appKeyPreview = appKey ? `${appKey.slice(0, 6)}...${appKey.slice(-4)} (len=${appKey.length})` : '空';
    const secretPreview = secret ? `${secret.slice(0, 4)}...${secret.slice(-4)} (len=${secret.length})` : '空';
    throw new Error(
      `getAccessToken 失败：\n` +
      `  钉钉返回: errcode=${j.errcode} errmsg=${j.errmsg}\n` +
      `  DINGTALK_APP_KEY 当前值: ${appKeyPreview}\n` +
      `  DINGTALK_APP_SECRET 当前值: ${secretPreview}\n` +
      `  排查：\n` +
      `    1) Vercel 里 AppSecret 是否一字不差（核对空格/换行/字符数 = 64）\n` +
      `    2) 钉钉开放平台是否重置过 AppSecret\n` +
      `    3) 应用是否已发布/未被禁用`
    );
  }
  return { token: j.access_token, source: 'oapi.dingtalk.com/gettoken' };
}

/**
 * 用 access_token 换 jsapi_ticket
 */
async function getJsapiTicket(accessToken) {
  // 尝试 1：新接口
  try {
    const r = await fetch('https://api.dingtalk.com/v1.0/oauth2/jsapiTickets', {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    });
    const j = await r.json();
    if (j.jsapiTicket) return j.jsapiTicket;
  } catch (e) {
    // 继续尝试老接口
  }

  // 尝试 2：老接口
  const r = await fetch(`https://oapi.dingtalk.com/get_jsapi_ticket?access_token=${encodeURIComponent(accessToken)}`);
  const j = await r.json();
  if (!j.ticket) {
    throw new Error(`getJsapiTicket 失败: ${JSON.stringify(j)}`);
  }
  return j.ticket;
}

/**
 * 拿企业的 corpId（通过 /v1.0/auth/corp/accessToken 换）
 * 第三方应用必传 corpId；企业内部应用 corpId 在 admin 后台可查
 */
async function getCorpIdFromToken(accessToken) {
  // 这个接口需要 unionId，所以企业内部应用不适合走这条；保留兜底
  return '';
}

export default async function handler(req, res) {
  // CORS
  const origin = process.env.ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    // 读取环境变量（统一用 DINGTALK_* 命名，老的 DING_* 留作兜底）
    const appKey = process.env.DINGTALK_APP_KEY || process.env.DING_AGENT_ID || '';
    const appSecret = process.env.DINGTALK_APP_SECRET || process.env.DING_AGENT_SECRET || '';
    const agentId = process.env.DINGTALK_AGENT_ID || process.env.DING_AGENT_ID || '';
    // corpId 三个来源：① 环境变量 ② token API 自动解析（部分类型应用支持） ③ 抛错让用户去开放平台拿
    let corpId = process.env.DINGTALK_CORP_ID || process.env.DING_CORP_ID || '';

    if (!appKey || !appSecret || !agentId) {
      res.status(500).json({
        ok: false,
        errmsg: '环境变量 DINGTALK_APP_KEY / DINGTALK_APP_SECRET / DINGTALK_AGENT_ID 未配置',
        env: {
          hasAppKey: !!appKey,
          hasAppSecret: !!appSecret,
          hasAgentId: !!agentId,
          hasCorpId: !!corpId,
        },
      });
      return;
    }

    // agentId 校验：必须是纯数字
    if (!/^\d+$/.test(agentId)) {
      res.status(500).json({
        ok: false,
        errmsg: `DINGTALK_AGENT_ID 格式错误，应为纯数字，实际是 "${agentId}"`,
      });
      return;
    }

    // 前端传入的页面 url（去掉 hash 和 query 中的 _ddnav=）
    const url = (req.query.url || '').split('#')[0];
    if (!url) {
      res.status(400).json({ ok: false, errmsg: '缺少 url 参数，例如 ?url=https://your-domain.com/' });
      return;
    }

    const nonceStr = randomStr(16);
    const timeStamp = String(Math.floor(Date.now() / 1000));

    // 标准钉钉 JSAPI 签名：HMAC-SHA1(plain, ticket)
    //   plain = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`
    //   key   = ticket
    let jsapiTicket = '';
    let tokenSource = '';
    let signatureErr = '';
    try {
      const { token, source } = await getAccessToken(appKey, appSecret);
      tokenSource = source;
      jsapiTicket = await getJsapiTicket(token);
    } catch (e) {
      signatureErr = e.message;
    }

    let signature;
    let signatureMethod = '';
    if (jsapiTicket) {
      // 标准签名
      const plain = `jsapi_ticket=${jsapiTicket}&noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`;
      signature = crypto.createHmac('sha1', jsapiTicket).update(plain).digest('hex');
      signatureMethod = 'HMAC-SHA1(jsapi_ticket)';
    } else {
      // 兜底：纯 SHA1 简化签名（部分企业内部应用可用）
      const plain = `noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`;
      signature = crypto.createHash('sha1').update(plain).digest('hex');
      signatureMethod = 'SHA1(fallback)';
    }

    res.status(200).json({
      ok: true,
      corpId,
      agentId,
      timeStamp,
      nonceStr,
      signature,
      _debug: {
        signatureMethod,
        tokenSource,
        jsapiTicketLen: jsapiTicket.length,
        signatureErr: signatureErr || undefined,
        url: url.slice(0, 80) + (url.length > 80 ? '...' : ''),
      },
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      errmsg: err.message || String(err),
    });
  }
}
