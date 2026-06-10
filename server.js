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
  if (!text) return 0;
  const normalized = text.trim().replace(/[＋]/g, '+').replace(/[Ｘｘ]/g, 'x');
  const m = normalized.match(/^\+(\d+)(?:\s*[xX×]\s*(\d+))?/);
  if (!m) return 0;
  return parseInt(m[1], 10) * (m[2] ? parseInt(m[2], 10) : 1);
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

    if (text.startsWith('#開團')) {
      const name = text.replace('#開團', '').trim() || '本次團購';
      const dateStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '-');
      const sheetName = `${name}_${dateStr}`.replace(/[\\/*?[\]':]/g, '');
      campaigns[contextId] = { campaignName: name, sheetName, orders: [], startTime: new Date().toISOString() };
      syncToSheets({ action: 'init', sheetName, campaignName: name, startTime: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) });
      replyMessage(event.replyToken,
        `✅ 已開始統計「${name}」\n請大家回覆 +1 下單\n支援格式：+1 / +2 / +1x2 / +1 x3\n\n輸入「#名單」查看目前名單\n輸入「#結團」結束統計\n\n📊 訂單同步寫入 Google Sheets`
      );
      return;
    }

    if (text === '#結團') {
      const camp = campaigns[contextId];
      if (!camp) { replyMessage(event.replyToken, '⚠️ 目前沒有進行中的團購'); return; }
      const total = camp.orders.reduce((s, o) => s + o.qty, 0);
      syncToSheets({ action: 'close', sheetName: camp.sheetName, totalPeople: camp.orders.length, totalQty: total, endTime: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) });
      replyMessage(event.replyToken, `🎉「${camp.campaignName}」已結團！\n共 ${camp.orders.length} 人 × ${total} 件\n\n📊 名單已同步至 Google Sheets ✅`);
      return;
    }

    if (text === '#名單') {
      const camp = campaigns[contextId];
      if (!camp || camp.orders.length === 0) { replyMessage(event.replyToken, '目前還沒有人下單喔！'); return; }
      const total = camp.orders.reduce((s, o) => s + o.qty, 0);
      const list = camp.orders.map((o, i) => `${i + 1}. ${o.displayName} ×${o.qty}`).join('\n');
      replyMessage(event.replyToken, `📋「${camp.campaignName}」目前名單：\n${list}\n\n合計：${total} 件`);
      return;
    }

    const qty = parseOrder(text);
    if (qty <= 0) return;
    const camp = campaigns[contextId];
    if (!camp) return;

    getDisplayName(userId, groupId, (displayName) => {
      const now = new Date().toISOString();
      const existing = camp.orders.find(o => o.userId === userId);
      const isUpdate = !!existing;
      if (isUpdate) {
        existing.qty = qty; existing.time = now; existing.displayName = displayName;
      } else {
        camp.orders.push({ userId, displayName, qty, time: now });
      }
      syncToSheets({ action: 'upsert', sheetName: camp.sheetName, userId, displayName, qty, isUpdate, time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) });
    });
  });
});

app.get('/admin', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });
  const gid = req.query.group;
  if (gid) return res.json(campaigns[gid] || { error: '找不到此群組' });
  const summary = Object.entries(campaigns).map(([id, c]) => ({
    groupId: id, campaignName: c.campaignName, sheetName: c.sheetName,
    count: c.orders.length, total: c.orders.reduce((s, o) => s + o.qty, 0)
  }));
  res.json(summary);
});

app.get('/csv', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(401).send('密碼錯誤');
  const camp = campaigns[req.query.group];
  if (!camp) return res.status(404).send('找不到此群組');
  const rows = [['編號','名稱','數量','下單時間'], ...camp.orders.map((o,i) => [i+1, o.displayName, o.qty, new Date(o.time).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})])];
  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send('\uFEFF' + csv);
});

app.get('/', (req, res) => res.send('MA.LAB +1 Bot is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
