import express from "express";
import dotenv from "dotenv";
import { startBot } from "./bot.js";
import { startBot } from "./bot.js";
dotenv.config();

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
  let s = String(p).trim();
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) s = "+" + s.replace(/\+/g, "");
  return s;
};

app.post("/start-verify", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone required" });

    const expectedPhone = normalizePhone(phone);

    const r = await fetch(`${SUPABASE_URL}/rest/v1/phone_verifications`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify([{ phone: expectedPhone, verified: false }]),
    });

    const data = await r.json();
    if (!r.ok) return res.status(400).json({ error: data });

    const sessionId = data?.[0]?.id;
    if (!sessionId) return res.status(500).json({ error: "No sessionId returned" });

    res.json({
      sessionId,
      tgLink: `https://t.me/${process.env.BOT_USERNAME}?start=${sessionId}`,
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/confirm", async (req, res) => {
  try {
    const secret = req.headers["x-bot-secret"];
    if (!BOT_SECRET || secret !== BOT_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { sessionId, phone } = req.body;
    if (!sessionId || !phone) {
      return res.status(400).json({ error: "sessionId and phone required" });
    }

    const incomingPhone = normalizePhone(phone);

    const rr = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${sessionId}&select=id,phone,verified`,
      { headers }
    );

    const rows = await rr.json();
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
    console.log(err);
    res.status(500).json({ error: "confirm error" });
  }
});

app.get("/status/:id", async (req, res) => {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${req.params.id}&select=verified`,
      { headers }
    );

    const data = await r.json();
    if (!r.ok) return res.status(400).json({ error: data });

    res.json({ verified: data?.[0]?.verified === true });
  } catch (err) {
    res.status(500).json({ error: "status error" });
  }
});

app.listen(PORT || 3000, () => {
  console.log("✅ Server running on port", PORT || 3000);
  startBot();
});
console.log("STARTING APP...");
console.log({
  PORT: process.env.PORT,
  BOT_TOKEN: !!process.env.BOT_TOKEN,
  SUPABASE_URL: !!process.env.SUPABASE_URL
});