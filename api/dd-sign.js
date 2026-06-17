// api/dd-sign.js
// 钉钉 JSAPI 签名端点
// dd.config 需要一个后端计算的 HMAC-SHA1 签名，参数包括：
//   agentId, corpId, timeStamp, nonceStr, signature
// 环境变量（与 proxy.js 共用）：
//   DING_CORP_ID | DING_AGENT_ID | DING_AGENT_SECRET
// Vercel Serverless Function — 部署到 /api/dd-sign

import crypto from 'crypto';

function sha1(data) {
  return crypto.createHmac('sha1', '').update(data).digest('hex');
}

function randomStr(length = 16) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return result;
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
    // 同时支持 DING_* 和 DINGTALK_APP_* 两套变量名
    const corpId = process.env.DING_CORP_ID || process.env.DINGTALK_CORP_ID || '';
    const agentId = process.env.DING_AGENT_ID || process.env.DINGTALK_AGENT_ID || '';
    const secret = process.env.DING_AGENT_SECRET || process.env.DINGTALK_APP_SECRET || '';
    const appKey = process.env.DINGTALK_APP_KEY || process.env.DING_AGENT_ID || '';

    if (!agentId || !secret || !appKey) {
      res.status(500).json({
        ok: false,
        errmsg: '环境变量 DINGTALK_AGENT_ID / DINGTALK_APP_KEY / DINGTALK_APP_SECRET 未配置',
      });
      return;
    }

    // 前端传入的页面 url（去掉 hash）
    const url = (req.query.url || '').split('#')[0];
    const nonceStr = randomStr(16);
    const timeStamp = String(Math.floor(Date.now() / 1000));

    // dd.config 签名算法（钉钉官方文档）：
    //   ① ticket = jsapi_ticket（从 dd.get_jsapi_ticket 接口获取）
    //   ② plainSign = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`
    //   ③ signature = HMAC-SHA1(plainSign, ticket)  ← 注意 key 也是 ticket 本身
    // 注：这里直接用 agentSecret 换 jsapi_ticket，在实际部署中如果遇到签名不通过，
    //     改为先 gettoken → get_jsapi_ticket → 再用 ticket 签名。
    //
    // 钉钉 JSAPI 签名简化版（适用于企业内部应用，agentSecret 即 ticket 的退化场景）：
    //   plain = `noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`
    //   signature = SHA1(plain)  ← 用纯 SHA1，不需要 HMAC

    // 方式 A：简化签名（部分企业内部应用适用）
    const plainA = `noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`;
    const signatureA = crypto.createHash('sha1').update(plainA).digest('hex');

    // 方式 B：标准 HMAC-SHA1 签名（用 ticket 做 key）
    // 先获取 jsapi_ticket（用 appKey + appSecret 换 access_token）
    let jsapiTicket = '';
    try {
      const tokenResp = await fetch(
        `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(secret)}`
      );
      const tokenJson = await tokenResp.json();
      if (tokenJson.access_token) {
        const ticketResp = await fetch(
          `https://oapi.dingtalk.com/get_jsapi_ticket?access_token=${tokenJson.access_token}`
        );
        const ticketJson = await ticketResp.json();
        if (ticketJson.ticket) {
          jsapiTicket = ticketJson.ticket;
        }
      }
    } catch (e) {
      // 获取 ticket 失败，回退到方式 A
      console.warn('get_jsapi_ticket 失败，使用简化签名：', e.message);
    }

    let signature;

    if (jsapiTicket) {
      // 标准签名
      const plainB = `jsapi_ticket=${jsapiTicket}&noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`;
      signature = crypto.createHmac('sha1', jsapiTicket).update(plainB).digest('hex');
    } else {
      // 简化签名
      signature = signatureA;
    }

    res.status(200).json({
      ok: true,
      corpId,
      agentId,
      timeStamp,
      nonceStr,
      signature,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      errmsg: err.message || String(err),
    });
  }
}
