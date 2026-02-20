import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_USERNAME = process.env.BOT_USERNAME;

// общие headers для supabase
const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json"
};


// ✅ 1. пользователь ввёл номер → создаём проверку
app.post("/start-verify", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone)
      return res.status(400).json({ error: "Phone required" });

    const r = await fetch(`${SUPABASE_URL}/rest/v1/phone_verifications`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify([{ phone }])
    });

    const data = await r.json();

    const sessionId = data[0].id;

    res.json({
      sessionId,
      tgLink: `https://t.me/${BOT_USERNAME}?start=${sessionId}`
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "server error" });
  }
});


// ✅ 2. бот подтвердил номер
app.post("/confirm", async (req, res) => {
  try {
    const { sessionId } = req.body;

    await fetch(
      `${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${sessionId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ verified: true })
      }
    );

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ error: "confirm error" });
  }
});


// ✅ 3. сайт проверяет статус
app.get("/status/:id", async (req, res) => {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_verifications?id=eq.${req.params.id}&select=verified`,
      {
        headers
      }
    );

    const data = await r.json();

    res.json({
      verified: data[0]?.verified || false
    });

  } catch (err) {
    res.status(500).json({ error: "status error" });
  }
});


app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
