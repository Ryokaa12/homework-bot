require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cron = require('node-cron');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

/* ---------------- เก็บข้อมูล ----------------
   ถ้าตั้ง UPSTASH_REDIS_REST_URL/TOKEN → เก็บบน Upstash Redis (ข้อมูลไม่หายตอนรีสตาร์ท)
   ถ้าไม่ตั้ง → เก็บเป็นไฟล์ data.json (เหมาะกับรันบนเครื่องตัวเอง) */
const DB_FILE = process.env.DB_FILE || './data.json';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
let db = { groups: {} };

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

async function loadDb() {
  try {
    if (REDIS_URL) {
      const j = await redis(['GET', 'homework-db']);
      if (j.result) db = JSON.parse(j.result);
    } else {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (_) {}
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const body = JSON.stringify(db);
      if (REDIS_URL) await redis(['SET', 'homework-db', body]);
      else fs.writeFileSync(DB_FILE, body);
    } catch (e) { console.error('save failed', e.message); }
  }, 300);
}

function getGroup(id) {
  if (!db.groups[id]) {
    db.groups[id] = { homework: [], settings: { days: [0, 1], hour: 18 }, lastSent: '' };
    save();
  }
  return db.groups[id];
}

/* ---------------- วันที่ (เวลาไทย) ---------------- */
const bkk = () => new Date(Date.now() + 7 * 3600 * 1000);
const today = () => bkk().toISOString().slice(0, 10);
const daysLeft = (due) => Math.round((Date.parse(due) - Date.parse(today())) / 86400000);
const fmt = (d) =>
  new Date(d).toLocaleDateString('th-TH', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
const leftText = (d) => (d < 0 ? `เลยกำหนด ${-d} วัน` : d === 0 ? 'ส่งวันนี้!' : `อีก ${d} วัน`);
const leftColor = (d) => (d <= 0 ? '#E53935' : d <= 1 ? '#F57C00' : '#2E7D32');

/* ---------------- ตัวช่วยสร้างข้อความ ---------------- */
const text = (t, quick) => ({
  type: 'text', text: t,
  ...(quick && {
    quickReply: {
      items: quick.map((q) => ({
        type: 'action', action: { type: 'message', label: q, text: q },
      })),
    },
  }),
});
const btn = (label, data, style = 'secondary') => ({
  type: 'button', style, height: 'sm', action: { type: 'postback', label, data },
});
const flex = (altText, body) => ({
  type: 'flex', altText,
  contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body } },
});
const reply = (e, messages) => client.replyMessage({ replyToken: e.replyToken, messages });

/* ---------------- เมนูต่าง ๆ ---------------- */
const mainMenu = () =>
  flex('เมนูการบ้าน', [
    { type: 'text', text: '📚 เมนูการบ้าน', weight: 'bold', size: 'xl' },
    { type: 'text', text: 'เลือกสิ่งที่ต้องการทำ', size: 'sm', color: '#888888' },
    btn('➕ เพิ่มการบ้าน', 'action=add', 'primary'),
    btn('📋 การบ้านที่ค้าง', 'action=list'),
    btn('⏰ ตั้งแจ้งเตือน', 'action=remind'),
  ]);

const dueCard = () =>
  flex('เลือกวันส่ง', [
    { type: 'text', text: '📅 กำหนดส่งวันไหน?', weight: 'bold', size: 'lg' },
    {
      type: 'button', style: 'primary', height: 'sm',
      action: {
        type: 'datetimepicker', label: 'เลือกวันที่ส่ง', data: 'action=due',
        mode: 'date', initial: today(), min: today(),
      },
    },
    btn('ยกเลิก', 'action=cancel'),
  ]);

function hwRow(h) {
  const d = daysLeft(h.due);
  return {
    type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg',
    contents: [
      { type: 'text', text: h.subject, weight: 'bold', wrap: true },
      { type: 'text', text: h.title, wrap: true, size: 'sm' },
      { type: 'text', text: `ส่ง ${fmt(h.due)} · ${leftText(d)}`, size: 'xs', color: leftColor(d) },
      btn('✅ ส่งแล้ว / ลบ', `action=done&id=${h.id}`),
      { type: 'separator', margin: 'md' },
    ],
  };
}

function listMessage(g) {
  const items = g.homework.filter((h) => !h.done).sort((a, b) => a.due.localeCompare(b.due));
  if (!items.length) return text('ไม่มีการบ้านค้างเลย 🎉');
  return flex('การบ้านที่ค้าง', [
    { type: 'text', text: `📋 การบ้านที่ค้าง (${items.length})`, weight: 'bold', size: 'lg' },
    ...items.slice(0, 8).map(hwRow),
    ...(items.length > 8 ? [{ type: 'text', text: `...และอีก ${items.length - 8} รายการ`, size: 'xs', color: '#888888' }] : []),
  ]);
}

function remindMenu(g) {
  const s = g.settings;
  const dayOpts = [[0, 'วันส่ง'], [1, 'ก่อน 1 วัน'], [2, 'ก่อน 2 วัน'], [3, 'ก่อน 3 วัน']];
  const hours = [7, 12, 18, 20];
  return flex('ตั้งแจ้งเตือน', [
    { type: 'text', text: '⏰ ตั้งแจ้งเตือนการบ้าน', weight: 'bold', size: 'lg' },
    { type: 'text', text: 'แจ้งเตือนเมื่อ (เลือกได้หลายข้อ)', size: 'sm', color: '#888888' },
    ...dayOpts.map(([d, l]) => btn(`${s.days.includes(d) ? '✅' : '⬜'} ${l}`, `action=toggleDay&d=${d}`)),
    { type: 'text', text: 'ส่งแจ้งเตือนเวลา', size: 'sm', color: '#888888', margin: 'lg' },
    ...hours.map((h) => btn(`${s.hour === h ? '🔘' : '⚪'} ${String(h).padStart(2, '0')}:00 น.`, `action=setHour&h=${h}`)),
    btn('🔔 ทดสอบแจ้งเตือนตอนนี้', 'action=testRemind', 'primary'),
    btn('ปิด', 'action=cancel'),
  ]);
}

/* ---------------- สถานะการเพิ่มการบ้าน (จำแยกตามคน) ---------------- */
const sessions = new Map(); // key = groupId:userId
const SESSION_MS = 10 * 60 * 1000;
const SUBJECTS = ['คณิต', 'ภาษาไทย', 'อังกฤษ', 'วิทย์', 'สังคม'];
const TRIGGERS = ['เมนู', 'การบ้าน', 'menu', 'hw', '/menu'];

/* ---------------- สร้างข้อความแจ้งเตือน ---------------- */
function reminderText(g) {
  const due = g.homework
    .filter((h) => !h.done && g.settings.days.includes(daysLeft(h.due)))
    .sort((a, b) => a.due.localeCompare(b.due));
  if (!due.length) return null;
  const lines = due.map((h) => `• ${h.subject}: ${h.title}\n  ส่ง ${fmt(h.due)} (${leftText(daysLeft(h.due))})`);
  return `⏰ แจ้งเตือนการบ้าน\n\n${lines.join('\n')}\n\nพิมพ์ "เมนู" เพื่อดูหรือลบรายการ`;
}

/* ---------------- จัดการ event ---------------- */
async function handleEvent(e) {
  const gid = e.source.groupId || e.source.roomId || e.source.userId;
  const uid = e.source.userId;
  const g = getGroup(gid);
  const key = `${gid}:${uid}`;

  if (e.type === 'join' || e.type === 'follow') {
    return reply(e, [text('สวัสดี! เป็นบอทช่วยจดการบ้านนะ พิมพ์ "เมนู" เพื่อเริ่มใช้งานได้เลย'), mainMenu()]);
  }

  if (e.type === 'message' && e.message.type === 'text') {
    const t = e.message.text.trim();
    if (TRIGGERS.includes(t.toLowerCase())) {
      sessions.delete(key);
      return reply(e, [mainMenu()]);
    }
    const s = sessions.get(key);
    if (!s) return; // ไม่เกี่ยวกับบอท ไม่ต้องตอบ
    if (Date.now() - s.at > SESSION_MS) { sessions.delete(key); return; }
    if (t === 'ยกเลิก') { sessions.delete(key); return reply(e, [text('ยกเลิกแล้ว')]); }

    if (s.step === 'subject') {
      s.subject = t.slice(0, 30); s.step = 'title'; s.at = Date.now();
      return reply(e, [text(`วิชา "${s.subject}" ✔️\nการบ้านคืออะไร? (เช่น แบบฝึกหัดหน้า 25)`)]);
    }
    if (s.step === 'title') {
      s.title = t.slice(0, 100); s.step = 'due'; s.at = Date.now();
      return reply(e, [dueCard()]);
    }
    return;
  }

  if (e.type === 'postback') {
    const p = new URLSearchParams(e.postback.data);
    const action = p.get('action');

    if (action === 'add') {
      sessions.set(key, { step: 'subject', at: Date.now() });
      return reply(e, [text('วิชาอะไร? กดเลือกหรือพิมพ์ชื่อวิชาเองได้เลย\n(พิมพ์ "ยกเลิก" เพื่อยกเลิก)', SUBJECTS)]);
    }

    if (action === 'due') {
      const s = sessions.get(key);
      if (!s || s.step !== 'due' || Date.now() - s.at > SESSION_MS) {
        return reply(e, [text('หมดเวลาแล้ว หรือไม่ใช่รายการของคุณ ลองกด "เพิ่มการบ้าน" ใหม่นะ')]);
      }
      const due = e.postback.params.date;
      g.homework.push({
        id: Date.now().toString(36), subject: s.subject, title: s.title, due, done: false, addedBy: uid,
      });
      save(); sessions.delete(key);
      const d = daysLeft(due);
      return reply(e, [text(`✅ บันทึกการบ้านแล้ว\n📖 ${s.subject}: ${s.title}\n📅 ส่ง ${fmt(due)} (${leftText(d)})`)]);
    }

    if (action === 'cancel') { sessions.delete(key); return reply(e, [text('ยกเลิกแล้ว')]); }
    if (action === 'list') return reply(e, [listMessage(g)]);
    if (action === 'remind') return reply(e, [remindMenu(g)]);

    if (action === 'done') {
      const h = g.homework.find((x) => x.id === p.get('id'));
      if (h) { h.done = true; save(); }
      return reply(e, [text(h ? `✅ ลบ "${h.subject}: ${h.title}" แล้ว` : 'ไม่พบรายการนี้แล้ว'), listMessage(g)]);
    }

    if (action === 'testRemind') {
      const msg = reminderText(g);
      return reply(e, [text(msg || 'ตอนนี้ยังไม่มีการบ้านที่ตรงกับเงื่อนไขแจ้งเตือน (ลองเพิ่มการบ้านที่ส่งวันนี้หรือพรุ่งนี้ดู)')]);
    }

    if (action === 'toggleDay') {
      const d = Number(p.get('d'));
      const days = g.settings.days;
      g.settings.days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
      save();
      return reply(e, [remindMenu(g)]);
    }

    if (action === 'setHour') {
      g.settings.hour = Number(p.get('h'));
      g.lastSent = '';
      save();
      return reply(e, [remindMenu(g)]);
    }
  }
}

/* ---------------- ส่งแจ้งเตือนอัตโนมัติ ----------------
   ส่งวันละครั้งต่อกลุ่ม ภายใน 3 ชั่วโมงหลังเวลาที่ตั้ง
   (กันพลาดกรณีเซิร์ฟเวอร์เพิ่งตื่นหรือรีสตาร์ทตอนใกล้เวลา) */
cron.schedule('* * * * *', async () => {
  const hour = bkk().getUTCHours();

  for (const [gid, g] of Object.entries(db.groups)) {
    if (hour < g.settings.hour || hour >= g.settings.hour + 3) continue;
    if (g.lastSent === today()) continue;
    g.lastSent = today();

    // ลบการบ้านที่เลยกำหนดเกิน 7 วัน
    g.homework = g.homework.filter((h) => daysLeft(h.due) >= -7);
    save();

    const msg = reminderText(g);
    if (!msg) continue;
    try {
      await client.pushMessage({ to: gid, messages: [text(msg)] });
    } catch (err) {
      console.error('push failed', gid, err.message);
    }
  }
}, { timezone: 'Asia/Bangkok' });

/* ---------------- เว็บจัดการการบ้าน (/web) ----------------
   ใช้ข้อมูลชุดเดียวกับบอท: เพิ่มการบ้าน/ตั้งแจ้งเตือนในเว็บ → บอทส่งข้อความเข้ากลุ่ม */
const path = require('path');
const pushText = (to, t) => client.pushMessage({ to, messages: [text(t)] });

async function groupName(gid, g) {
  if (!g.name) {
    try {
      if (gid.startsWith('C')) g.name = (await client.getGroupSummary(gid)).groupName;
      else if (gid.startsWith('R')) g.name = 'ห้องแชท ' + gid.slice(1, 6);
      else g.name = 'แชทส่วนตัว';
      save();
    } catch (_) {}
  }
  return g.name || gid.slice(0, 8);
}

function mountWeb(app) {
  const r = express.Router();
  r.use(express.json());
  r.get('/', (_, res) => res.sendFile(path.join(__dirname, 'web.html')));

  r.use('/api', (req, res, next) => {
    const pw = process.env.ADMIN_PASSWORD;
    if (pw && req.get('x-password') !== pw) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    next();
  });
  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((e) => {
      console.error('web api', e.message);
      res.status(500).json({ error: e.message });
    });
  const grp = (req, res) => {
    const g = db.groups[req.params.gid];
    if (!g) res.status(404).json({ error: 'ไม่พบกลุ่มนี้' });
    return g;
  };

  r.get('/api/groups', wrap(async (_, res) => {
    const out = [];
    for (const [id, g] of Object.entries(db.groups)) out.push({ id, name: await groupName(id, g) });
    res.json(out);
  }));

  r.get('/api/groups/:gid', wrap(async (req, res) => {
    const g = grp(req, res); if (!g) return;
    res.json({ homework: g.homework, settings: g.settings, today: today() });
  }));

  r.post('/api/groups/:gid/homework', wrap(async (req, res) => {
    const g = grp(req, res); if (!g) return;
    const { subject, title, due, notifyNow } = req.body || {};
    if (!subject || !title || !/^\d{4}-\d\d-\d\d$/.test(due || '')) {
      return res.status(400).json({ error: 'กรอกวิชา ชื่องาน และวันส่งให้ครบ' });
    }
    const h = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      subject: String(subject).slice(0, 30), title: String(title).slice(0, 100),
      due, done: false, addedBy: 'web',
    };
    g.homework.push(h); save();
    let notified = false;
    if (notifyNow) {
      try {
        await pushText(req.params.gid,
          `🆕 มีการบ้านใหม่\n📖 ${h.subject}: ${h.title}\n📅 ส่ง ${fmt(h.due)} (${leftText(daysLeft(h.due))})\n\nอย่าลืมส่งในกลุ่มนะทุกคน 🙌`);
        notified = true;
      } catch (e) { console.error('push new hw', e.message); }
    }
    res.json({ ok: true, notified });
  }));

  r.put('/api/groups/:gid/homework/:id', wrap(async (req, res) => {
    const g = grp(req, res); if (!g) return;
    const h = g.homework.find((x) => x.id === req.params.id);
    if (!h) return res.status(404).json({ error: 'ไม่พบการบ้านนี้' });
    if (typeof req.body.done === 'boolean') h.done = req.body.done;
    save(); res.json({ ok: true });
  }));

  r.delete('/api/groups/:gid/homework/:id', wrap(async (req, res) => {
    const g = grp(req, res); if (!g) return;
    g.homework = g.homework.filter((x) => x.id !== req.params.id);
    save(); res.json({ ok: true });
  }));

  r.put('/api/groups/:gid/settings', wrap(async (req, res) => {
    const g = grp(req, res); if (!g) return;
    const { days, hour } = req.body || {};
    if (Array.isArray(days)) {
      g.settings.days = [...new Set(days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 7).sort();
    }
    if (Number.isInteger(hour) && hour >= 0 && hour <= 21) {
      if (hour !== g.settings.hour) g.lastSent = '';
      g.settings.hour = hour;
    }
    save(); res.json({ ok: true });
  }));

  // ส่งแจ้งเตือนเข้ากลุ่มตอนนี้ (ปุ่มทดสอบ)
  r.post('/api/groups/:gid/remind', wrap(async (req, res) => {
    const g = grp(req, res); if (!g) return;
    const msg = reminderText(g) || '🔔 ทดสอบแจ้งเตือนจากเว็บ — ตอนนี้ยังไม่มีการบ้านที่ตรงกับเงื่อนไขแจ้งเตือน';
    try { await pushText(req.params.gid, msg); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: 'บอทส่งเข้ากลุ่มไม่ได้ (' + e.message + ')' }); }
  }));

  app.use('/web', r);
}

/* ---------------- เซิร์ฟเวอร์ ---------------- */
const app = express();
mountWeb(app);
app.get('/', (_, res) => res.send('Homework bot is running'));
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map((e) => handleEvent(e).catch((err) => console.error(err))))
    .then(() => res.sendStatus(200));
});

loadDb().then(() => {
  app.listen(process.env.PORT || 3000, () => console.log('listening'));
});
