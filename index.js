import express from "express";
import dotenv from "dotenv";
import { startBot } from "./bot.js";

dotenv.config();

console.log("STARTING APP...");
console.log({
  PORT: process.env.PORT,
  BOT_TOKEN: !!process.env.BOT_TOKEN,
  SUPABASE_URL: !!process.env.SUPABASE_URL,
  SUPABASE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
  BOT_SECRET: !!process.env.BOT_SECRET,
});

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,x-bot-secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_SECRET = process.env.BOT_SECRET;

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

const normalizePhone = (p = "") => {
  let s = String(p).trim().replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) s = "+" + s.replace(/\+/g, "");
  return s;
};

let botInstance = null;

app.get("/", (req, res) => res.send("OK"));

app.get("/ping", (req, res) => {
  console.log("🏓 Ping:", new Date().toLocaleTimeString("ru-RU"));
  res.json({ status: "ok", uptime: Math.floor(process.uptime()), time: new Date() });
});

app.get("/is-admin", async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.json({ isAdmin: false });
    const normalized = normalizePhone(phone);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/admins_phones_numbers?select=phone`, { headers });
    const data = await r.json().catch(() => []);
    if (!Array.isArray(data)) return res.json({ isAdmin: false });
    const isAdmin = data.some((row) => {
      const stored = typeof row.phone === "string"
        ? row.phone.replace(/^"|"$/g, "").trim()
        : String(row.phone).trim();
      return normalizePhone(stored) === normalized;
    });
    res.json({ isAdmin });
  } catch (err) {
    console.error("IS-ADMIN ERROR:", err);
    res.json({ isAdmin: false });
  }
});

app.post("/start-verify", async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: "Phone required" });
    const expectedPhone = normalizePhone(phone);
    const secretCode = String(Math.floor(100000 + Math.random() * 900000));
    const r = await fetch(`${SUPABASE_URL}/rest/v1/phone_verifications`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify([{ phone: expectedPhone, verified: false, secret_code: secretCode }]),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ error: data });
    const sessionId = data?.[0]?.id;
    if (!sessionId) return res.status(500).json({ error: "No sessionId returned" });
    res.json({
      sessionId,
      secretCode,
      tgLink: `https://t.me/${process.env.BOT_USERNAME}?start=${sessionId}`,
    });
  } catch (err) {
    console.error("START-VERIFY ERROR:", err);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/confirm", async (req, res) => {
  try {
    const secret = req.headers["x-bot-secret"];
    if (!BOT_SECRET || secret !== BOT_SECRET) return res.status(401).json({ error: "Unauthorized" });
    const { sessionId, phone, code } = req.body || {};
    if (!sessionId || !phone) return res.status(400).json({ error: "sessionId and phone required" });
    const incomingPhone = normalizePhone(phone);
    const rr = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${sessionId}&select=id,phone,verified,secret_code`,
      { headers }
    );
    const rows = await rr.json().catch(() => []);
    if (!rr.ok) return res.status(400).json({ error: rows });
    const row = rows?.[0];
    if (!row) return res.status(404).json({ error: "Session not found" });
    if (normalizePhone(row.phone) !== incomingPhone)
      return res.status(400).json({ error: "Phone mismatch" });
    if (row.secret_code && code && String(row.secret_code) !== String(code))
      return res.status(400).json({ error: "Wrong code" });
    const upd = await fetch(`${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${sessionId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ verified: true }),
    });
    if (!upd.ok) {
      const e = await upd.json().catch(() => ({}));
      return res.status(400).json({ error: e });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("CONFIRM ERROR:", err);
    res.status(500).json({ error: "confirm error" });
  }
});

app.get("/status/:id", async (req, res) => {
  try {
    const { code } = req.query;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${req.params.id}&select=verified,secret_code,phone`,
      { headers }
    );
    const data = await r.json().catch(() => []);
    if (!r.ok) return res.status(400).json({ error: data });
    const row = data?.[0];
    if (!row) return res.status(404).json({ error: "Session not found" });
    if (code && row.secret_code && String(row.secret_code) !== String(code))
      return res.status(403).json({ error: "Wrong code" });
    res.json({ verified: row.verified === true });
  } catch (err) {
    console.error("STATUS ERROR:", err);
    res.status(500).json({ error: "status error" });
  }
});

// ─── Создать заказ ────────────────────────────────────────────────────────────
// POST /order
// {
//   "customer_phone": "+998901234567",
//   "total": 4242,
//   "valute": "USD",          ← валюта заказа (из таблицы orders)
//   "items": [
//     {
//       "product_id": "uuid",
//       "title": "Polo Sport",
//       "ml_sizes": 100,
//       "quantity": 2,
//       "price": 2121
//     }
//   ]
// }
app.post("/order", async (req, res) => {
  try {
    const secret = req.headers["x-bot-secret"];
    if (!BOT_SECRET || secret !== BOT_SECRET) return res.status(401).json({ error: "Unauthorized" });

    const { customer_phone, total, valute, items } = req.body || {};

    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: "items array required" });
    if (total === undefined || total === null)
      return res.status(400).json({ error: "total required" });

    for (const item of items) {
      if (!item.product_id) return res.status(400).json({ error: "Each item must have product_id" });
      if (!item.title)      return res.status(400).json({ error: "Each item must have title" });
      if (!item.ml_sizes)   return res.status(400).json({ error: "Each item must have ml_sizes" });
      if (!item.quantity || item.quantity < 1) return res.status(400).json({ error: "Each item must have quantity >= 1" });
      if (item.price === undefined) return res.status(400).json({ error: "Each item must have price" });
    }

    // Только нужные поля — минимально
    const normalizedItems = items.map((item) => ({
      product_id: item.product_id,
      title:      item.title,
      ml_sizes:   item.ml_sizes,
      quantity:   item.quantity,
      price:      item.price,
    }));

    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify([{
        customer_phone: customer_phone ? normalizePhone(customer_phone) : null,
        total,
        valute: valute || "USD",
        items: normalizedItems,
      }]),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ error: data });

    const order = data?.[0];
    if (!order) return res.status(500).json({ error: "Order not saved" });

    if (botInstance?.notifyAdmins) {
      botInstance.notifyAdmins(order).catch((e) => console.error("Notify error:", e));
    }

    res.json({ ok: true, orderId: order.id });
  } catch (err) {
    console.error("ORDER ERROR:", err);
    res.status(500).json({ error: "order error" });
  }
});

app.get("/orders", async (req, res) => {
  try {
    const secret = req.headers["x-bot-secret"];
    if (!BOT_SECRET || secret !== BOT_SECRET) return res.status(401).json({ error: "Unauthorized" });
    const limit = parseInt(req.query.limit) || 50;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?order=created_at.desc&limit=${limit}&select=*`,
      { headers }
    );
    const data = await r.json().catch(() => []);
    if (!r.ok) return res.status(400).json({ error: data });
    res.json(data);
  } catch (err) {
    console.error("ORDERS ERROR:", err);
    res.status(500).json({ error: "orders error" });
  }
});

app.listen(PORT, async () => {
  console.log("✅ Server running on port", PORT);

  if (process.env.SERVER_URL) {
    setInterval(async () => {
      try {
        const res = await fetch(`${process.env.SERVER_URL}/ping`);
        console.log("🔁 Self-ping:", res.status);
      } catch (e) {
        console.error("🔁 Self-ping failed:", e.message);
      }
    }, 60_000);
  }

  try {
    botInstance = await startBot();
    console.log("✅ Bot started");
  } catch (e) {
    console.error("❌ Bot failed to start:", e.message);
  }
});