const express = require('express');
const crypto = require('crypto');
const https = require('https');

const app = express();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '770320';
const GAS_URL = process.env.GAS_URL || '';

const campaigns = {};

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

function verifySignature(req) {
  if (!LINE_CHANNEL_SECRET) return true;
  const sig = req.headers['x-line-signature'];
  const hmac = crypto.createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(req.rawBody).digest('base64');
  return sig === hmac;
}

function parseOrder(text) {
  if (!text) return null;
  const normalized = text.trim().replace(/[＋]/g, '+').replace(/[Ｘｘ]/g, 'x');
  const m = normalized.match(/^(.+?)\s*\+(\d+)(?:\s*[xX×]\s*(\d+))?$/);
  if (!m) return null;
  const productName = m[1].trim();
  if (!productName) return null;
  const base = parseInt(m[2], 10);
  const mult = m[3] ? parseInt(m[3], 10) : 1;
  return { productName, qty: base * mult };
}

function replyMessage(replyToken, text) {
  const body = JSON.stringify({ replyToken, messages: [{ type: 'text', text }] });
  const options = {
    hostname: 'api.line.me',
    path: '/v2/bot/message/reply',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    }
  };
  const req = https.request(options);
  req.write(body);
  req.end();
}

function pushMessage(groupId, text) {
  const body = JSON.stringify({ to: groupId, messages: [{ type: 'text', text }] });
  const options = {
    hostname: 'api.line.me',
    path: '/v2/bot/message/push',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    }
  };
  const req = https.request(options);
  req.write(body);
  req.end();
}

function getDisplayName(userId, groupId, callback) {
  const path = groupId
    ? `/v2/bot/group/${groupId}/member/${userId}`
    : `/v2/bot/profile/${userId}`;
  https.get({
    hostname: 'api.line.me', path,
    headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try { callback(JSON.parse(data).displayName || userId); }
      catch { callback(userId); }
    });
  }).on('error', () => callback(userId));
}

function syncToSheets(payload) {
  if (!GAS_URL) return;
  const url = new URL(GAS_URL);
  const body = JSON.stringify(payload);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  const req = https.request(options, (res) => {
    if (res.statusCode === 302 && res.headers.location) {
      const loc = new URL(res.headers.location);
      const r2 = https.request({
        hostname: loc.hostname,
        path: loc.pathname + loc.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      });
      r2.write(body);
      r2.end();
    }
  });
  req.on('error', (e) => console.error('GAS sync error:', e.message));
  req.write(body);
  req.end();
}

function buildList(productName, camp) {
  const total = camp.orders.reduce((s, o) => s + o.qty, 0);
  if (camp.orders.length === 0) return `「${productName}」目前還沒有人下單喔！`;
  const list = camp.orders.map((o, i) => `${i + 1}. ${o.displayName} ×${o.qty}`).join('\n');
  return `📋「${productName}」目前名單：\n${list}\n\n合計：${total} 件`;
}

app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) return res.status(401).send('Invalid signature');
  res.sendStatus(200);

  const events = req.body.events || [];
  events.forEach(event => {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const text = event.message.text.trim();
    const userId = event.source.userId;
    const groupId = event.source.groupId || event.source.roomId || null;
    const contextId = groupId || userId;

    if (!campaigns[contextId]) campaigns[contextId] = {};

    if (text.startsWith('#群內+')) {
      const productName = text.replace('#群內+', '').trim();
      if (!productName) {
        replyMessage(event.replyToken, '請輸入商品名稱，例如：#群內+ 小寶寶書');
        return;
      }
      const dateStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '-');
      const sheetName = `${productName}_${dateStr}`.replace(/[\\/*?[\]':]/g, '');
      campaigns[contextId][productName] = {
        sheetName,
        orders: [],
        startTime: new Date().toISOString()
      };
      syncToSheets({ action: 'init', sheetName, campaignName: productName, startTime: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) });
      replyMessage(event.replyToken,
        `✅ 已開始統計「${productName}」\n` +
        `回覆「${productName}+1」下單\n` +
        `支援格式：+1 / +2 / +1x2\n\n` +
        `查看名單：#名單 ${productName}\n` +
        `結束統計：#結團 ${productName}`
      );
      return;
    }

    if (text.startsWith('#結團')) {
      const productName = text.replace('#結團', '').trim();
      if (!productName) {
        replyMessage(event.replyToken, '請輸入商品名稱，例如：#結團 小寶寶書');
        return;
      }
      const camp = campaigns[contextId][productName];
      if (!camp) {
        replyMessage(event.replyToken, `⚠️ 找不到「${productName}」的團購，請確認名稱是否正確`);
        return;
      }
      const total = camp.orders.reduce((s, o) => s + o.qty, 0);
      syncToSheets({ action: 'close', sheetName: camp.sheetName, totalPeople: camp.orders.length, totalQty: total, endTime: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) });
      const listText = buildList(productName, camp);
      replyMessage(event.replyToken,
        `🎉「${productName}」已結團！\n共 ${camp.orders.length} 人 × ${total} 件\n\n${listText}`
      );
      delete campaigns[contextId][productName];
      return;
    }

    if (text.startsWith('#名單')) {
      const productName = text.replace('#名單', '').trim();
      if (!productName) {
        const active = Object.keys(campaigns[contextId]);
        if (active.length === 0) {
          replyMessage(event.replyToken, '目前沒有進行中的團購');
          return;
        }
        const summary = active.map(p => {
          const c = campaigns[contextId][p];
          const total = c.orders.reduce((s, o) => s + o.qty, 0);
          return `・${p}：${c.orders.length} 人 / ${total} 件`;
        }).join('\n');
        replyMessage(event.replyToken, `📋 目前進行中的團購：\n${summary}`);
        return;
      }
      const camp = campaigns[contextId][productName];
      if (!camp) {
        replyMessage(event.replyToken, `⚠️ 找不到「${productName}」的團購`);
        return;
      }
      replyMessage(event.replyToken, buildList(productName, camp));
      return;
    }

    const order = parseOrder(text);
    if (!order) return;

    const { productName, qty } = order;
    const camp = campaigns[contextId][productName];
    if (!camp) return;

    getDisplayName(userId, groupId, (displayName) => {
      const now = new Date().toISOString();
      const existing = camp.orders.find(o => o.userId === userId);
      const isUpdate = !!existing;
      if (isUpdate) {
        existing.qty = qty;
        existing.time = now;
        existing.displayName = displayName;
      } else {
        camp.orders.push({ userId, displayName, qty, time: now });
      }
      syncToSheets({
        action: 'upsert',
        sheetName: camp.sheetName,
        userId, displayName, qty, isUpdate,
        time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
      });
      if (groupId) {
        pushMessage(groupId, buildList(productName, camp));
      }
    });
  });
});

app.get('/admin', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });
  const gid = req.query.group;
  if (gid) return res.json(campaigns[gid] || {});
  const summary = Object.entries(campaigns).map(([id, products]) => ({
    groupId: id,
    products: Object.entries(products).map(([name, c]) => ({
      name, count: c.orders.length, total: c.orders.reduce((s, o) => s + o.qty, 0)
    }))
  }));
  res.json(summary);
});

app.get('/csv', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(401).send('密碼錯誤');
  const gid = req.query.group;
  const product = req.query.product;
  const camp = campaigns[gid] && campaigns[gid][product];
  if (!camp) return res.status(404).send('找不到資料');
  const rows = [['編號','名稱','數量','下單時間'], ...camp.orders.map((o,i) => [i+1, o.displayName, o.qty, new Date(o.time).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})])];
  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${product}.csv"`);
  res.send('\uFEFF' + csv);
});

app.get('/', (req, res) => res.send('MA.LAB +1 Bot is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
