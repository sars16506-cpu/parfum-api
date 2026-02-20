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

// Ссылка на бот (чтобы слать уведомления)
let botInstance = null;

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("OK"));

// ─── Начать верификацию ───────────────────────────────────────────────────────
app.post("/start-verify", async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: "Phone required" });

    const expectedPhone = normalizePhone(phone);

    const r = await fetch(`${SUPABASE_URL}/rest/v1/phone_verifications`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify([{ phone: expectedPhone, verified: false }]),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ error: data });

    const sessionId = data?.[0]?.id;
    if (!sessionId)
      return res.status(500).json({ error: "No sessionId returned" });

    res.json({
      sessionId,
      tgLink: `https://t.me/${process.env.BOT_USERNAME}?start=${sessionId}`,
    });
  } catch (err) {
    console.log("START-VERIFY ERROR:", err);
    res.status(500).json({ error: "server error" });
  }
});

// ─── Подтвердить номер (вызывается из бота) ───────────────────────────────────
app.post("/confirm", async (req, res) => {
  try {
    const secret = req.headers["x-bot-secret"];
    if (!BOT_SECRET || secret !== BOT_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { sessionId, phone } = req.body || {};
    if (!sessionId || !phone) {
      return res.status(400).json({ error: "sessionId and phone required" });
    }

    const incomingPhone = normalizePhone(phone);

    // Получаем сессию из Supabase
    const rr = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${sessionId}&select=id,phone,verified`,
      { headers }
    );
    const rows = await rr.json().catch(() => []);
    if (!rr.ok) return res.status(400).json({ error: rows });

    const row = rows?.[0];
    if (!row) return res.status(404).json({ error: "Session not found" });

    const expectedPhone = normalizePhone(row.phone);

    if (incomingPhone !== expectedPhone) {
      return res.status(400).json({
        error: "Phone mismatch",
        expected: expectedPhone,
        got: incomingPhone,
      });
    }

    // Отмечаем как подтверждённый
    const upd = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${sessionId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ verified: true }),
      }
    );

    if (!upd.ok) {
      const e = await upd.json().catch(() => ({}));
      return res.status(400).json({ error: e });
    }

    res.json({ ok: true });
  } catch (err) {
    console.log("CONFIRM ERROR:", err);
    res.status(500).json({ error: "confirm error" });
  }
});

// ─── Статус верификации ───────────────────────────────────────────────────────
app.get("/status/:id", async (req, res) => {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${req.params.id}&select=verified`,
      { headers }
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ error: data });

    res.json({ verified: data?.[0]?.verified === true });
  } catch (err) {
    console.log("STATUS ERROR:", err);
    res.status(500).json({ error: "status error" });
  }
});

// ─── Создать заказ (вызывается с сайта) ──────────────────────────────────────
// Тело запроса: { customer_phone, total, items: [{id, title, price, quantity}] }
app.post("/order", async (req, res) => {
  try {
    const secret = req.headers["x-bot-secret"];
    if (!BOT_SECRET || secret !== BOT_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { customer_phone, total, items } = req.body || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array required" });
    }
    if (total === undefined || total === null) {
      return res.status(400).json({ error: "total required" });
    }

    // Сохраняем заказ в Supabase
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify([
        {
          customer_phone: customer_phone
            ? normalizePhone(customer_phone)
            : null,
          total,
          items, // хранится как jsonb
        },
      ]),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ error: data });

    const order = data?.[0];
    if (!order) return res.status(500).json({ error: "Order not saved" });

    // Уведомляем администраторов в Telegram
    if (botInstance?.notifyAdmins) {
      botInstance.notifyAdmins(order).catch((e) =>
        console.log("Notify error:", e)
      );
    }

    res.json({ ok: true, orderId: order.id });
  } catch (err) {
    console.log("ORDER ERROR:", err);
    res.status(500).json({ error: "order error" });
  }
});

// ─── Получить список заказов (опционально для фронта) ────────────────────────
app.get("/orders", async (req, res) => {
  try {
    const secret = req.headers["x-bot-secret"];
    if (!BOT_SECRET || secret !== BOT_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const limit = parseInt(req.query.limit) || 50;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?order=created_at.desc&limit=${limit}`,
      { headers }
    );
    const data = await r.json().catch(() => []);
    if (!r.ok) return res.status(400).json({ error: data });

    res.json(data);
  } catch (err) {
    console.log("ORDERS ERROR:", err);
    res.status(500).json({ error: "orders error" });
  }
});

// ─── Запуск ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log("✅ Server running on port", PORT);
  try {
    botInstance = await startBot();
    console.log("✅ Bot started");
  } catch (e) {
    console.log("❌ Bot failed to start:", e.message);
  }
});