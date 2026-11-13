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

/* ---------------- ตัวช่วยสร้างข้อความ ---------------- */
const text = (t) => ({ type: 'text', text: t });
const reply = (e, messages) => client.replyMessage({ replyToken: e.replyToken, messages });
const TRIGGERS = ['การบ้าน', 'hw', '/hw'];

/* ---------------- สร้างข้อความแจ้งเตือน ---------------- */
function reminderText(g) {
  const due = g.homework
    .filter((h) => !h.done && g.settings.days.includes(daysLeft(h.due)))
    .sort((a, b) => a.due.localeCompare(b.due));
  if (!due.length) return null;
  const lines = due.map((h) => `• ${h.subject}: ${h.title}\n  ส่ง ${fmt(h.due)} (${leftText(daysLeft(h.due))})`);
  return `⏰ แจ้งเตือนการบ้าน\n\n${lines.join('\n')}\n\nพิมพ์ "การบ้าน" เพื่อดูรายการที่ค้าง`;
}

/* ---------------- จัดการ event ----------------
   การเพิ่มการบ้าน/ตั้งแจ้งเตือนทำในเว็บ (/web) แล้ว
   บอทแค่จำกลุ่มจากทุก event, แจ้งเตือนอัตโนมัติ และตอบรายการค้างเมื่อพิมพ์ "การบ้าน" */
const USE_PUSH = process.env.USE_PUSH === '1'; // ตั้ง USE_PUSH=1 ถ้าอยากใช้ push (กินโควตา LINE)

function enqueue(g, t) {
  g.queue = g.queue || [];
  g.queue.push(t);
  if (g.queue.length > 10) g.queue.shift();
  save();
}
// ส่งข้อความเข้ากลุ่ม: ถ้าไม่เปิด push (หรือ push ไม่สำเร็จ) จะเข้าคิว แล้วบอทตอบกลับให้ตอนมีคนพิมพ์ในกลุ่ม (reply ไม่กินโควตา)
async function deliver(gid, g, t) {
  if (USE_PUSH) {
    try { await client.pushMessage({ to: gid, messages: [text(t)] }); return 'pushed'; }
    catch (err) { console.error('push failed → queue', gid, err.message); }
  }
  enqueue(g, t);
  return 'queued';
}

function listText(g) {
  const items = g.homework.filter((h) => !h.done).sort((a, b) => a.due.localeCompare(b.due));
  if (!items.length) return 'ไม่มีการบ้านค้างเลย 🎉';
  const lines = items.slice(0, 15).map((h, i) => `${i + 1}. ${h.subject}: ${h.title}\n   ส่ง ${fmt(h.due)} (${leftText(daysLeft(h.due))})`);
  return `📋 การบ้านที่ค้าง (${items.length})\n\n${lines.join('\n')}`;
}

/* ---------------- จัดการ event ----------------
   เพิ่มการบ้าน/ตั้งแจ้งเตือนทำในเว็บ (/web)
   บอทแจ้งเตือนด้วยการ "ตอบกลับ" ตอนมีคนพิมพ์ในกลุ่ม (ไม่กินโควตา push):
   - ข้อความแรกของวัน หลังถึงเวลาที่ตั้ง → แนบแจ้งเตือนการบ้านให้
   - ประกาศ/แจ้งเตือนที่สั่งจากเว็บ → รอในคิว แล้วส่งตอนมีคนพิมพ์ครั้งถัดไป */
async function handleEvent(e) {
  const gid = e.source.groupId || e.source.roomId || e.source.userId;
  if (e.type === 'leave') { delete db.groups[gid]; save(); return; } // บอทถูกเตะออก → เอากลุ่มออกจากรายการ
  const g = getGroup(gid); // จำกลุ่มไว้ให้เว็บเลือก

  if (e.type === 'join' || e.type === 'follow') {
    return reply(e, [text('สวัสดี! บอทนี้จะคอยแจ้งเตือนการบ้านในกลุ่มนะ พิมพ์ "การบ้าน" เพื่อดูรายการที่ยังไม่ส่ง')]);
  }
  if (e.type !== 'message') return;

  const out = [];
  if (e.message.type === 'text' && TRIGGERS.includes(e.message.text.trim().toLowerCase())) out.push(text(listText(g)));

  let dirty = false;
  while (g.queue && g.queue.length && out.length < 5) { out.push(text(g.queue.shift())); dirty = true; }

  if (g.lastSent !== today() && bkk().getUTCHours() >= g.settings.hour && out.length < 5) {
    g.lastSent = today(); dirty = true;
    g.homework = g.homework.filter((h) => daysLeft(h.due) >= -7);
    const m = reminderText(g);
    if (m) out.push(text(m));
  }

  if (dirty) save();
  if (out.length) return reply(e, out);
}

/* ---------------- งานเบื้องหลัง ----------------
   ลบการบ้านที่เลยกำหนดเกิน 7 วัน
   ถ้าเปิด USE_PUSH=1 จะส่งแจ้งเตือนรายวันแบบ push ด้วย (ภายใน 3 ชั่วโมงหลังเวลาที่ตั้ง) */
cron.schedule('* * * * *', async () => {
  const hour = bkk().getUTCHours();

  for (const [gid, g] of Object.entries(db.groups)) {
    const before = g.homework.length;
    g.homework = g.homework.filter((h) => daysLeft(h.due) >= -7);
    if (g.homework.length !== before) save();

    if (!USE_PUSH) continue;
    if (hour < g.settings.hour || hour >= g.settings.hour + 3) continue;
    if (g.lastSent === today()) continue;
    g.lastSent = today(); save();
    const msg = reminderText(g);
    if (msg) await deliver(gid, g, msg);
  }
}, { timezone: 'Asia/Bangkok' });

/* ---------------- เว็บจัดการการบ้าน (/web) ----------------
   ใช้ข้อมูลชุดเดียวกับบอท: เพิ่มการบ้าน/ตั้งแจ้งเตือนในเว็บ → บอทส่งข้อความเข้ากลุ่ม */
const path = require('path');
const errText = (e) => [e.status, e.body || e.message].filter(Boolean).join(' ');
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
    for (const [id, g] of Object.entries(db.groups)) {
      out.push({ id, name: await groupName(id, g), pending: g.homework.filter((h) => !h.done).length, queued: (g.queue || []).length });
    }
    res.json(out);
  }));

  // โควตาข้อความเดือนนี้ (ตัวเลขจริงจาก LINE API อัปเดตทันที ไม่ช้าเหมือนหน้า Manager)
  r.get('/api/quota', wrap(async (_, res) => {
    const H = { Authorization: `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` };
    const [q, u] = await Promise.all([
      fetch('https://api.line.me/v2/bot/message/quota', { headers: H }).then((x) => x.json()),
      fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: H }).then((x) => x.json()),
    ]);
    res.json({ type: q.type, limit: q.value, used: u.totalUsage });
  }));

  // ลบกลุ่มออกจากระบบ (ติ๊ก leave=1 เพื่อให้บอทออกจากกลุ่มด้วย)
  r.delete('/api/groups/:gid', wrap(async (req, res) => {
    const gid = req.params.gid;
    if (!db.groups[gid]) return res.status(404).json({ error: 'ไม่พบกลุ่มนี้' });
    let left = false;
    if (req.query.leave === '1') {
      try {
        if (gid.startsWith('C')) await client.leaveGroup(gid);
        else if (gid.startsWith('R')) await client.leaveRoom(gid);
        left = gid[0] === 'C' || gid[0] === 'R';
      } catch (e) { console.error('leave', e.message); }
    }
    delete db.groups[gid]; save();
    res.json({ ok: true, left });
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
    let notified = false, queued = false;
    if (notifyNow) {
      const how = await deliver(req.params.gid, g,
        `🆕 มีการบ้านใหม่\n📖 ${h.subject}: ${h.title}\n📅 ส่ง ${fmt(h.due)} (${leftText(daysLeft(h.due))})\n\nอย่าลืมส่งในกลุ่มนะทุกคน 🙌`);
      notified = how === 'pushed'; queued = how === 'queued';
    }
    res.json({ ok: true, notified, queued });
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
    const how = await deliver(req.params.gid, g, msg);
    res.json({ ok: true, queued: how === 'queued' });
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
