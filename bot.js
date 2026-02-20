import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

const sessions = new Map();

export function startBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);

  bot.start((ctx) => {
    const sessionId = ctx.startPayload;
    if (!sessionId) return ctx.reply("Открой бота по ссылке с сайта.");

    sessions.set(ctx.from.id, sessionId);

    return ctx.reply(
      "Нажми кнопку чтобы подтвердить номер:",
      Markup.keyboard([Markup.button.contactRequest("📱 Поделиться номером")]).resize()
    );
  });

  bot.on("contact", async (ctx) => {
    const sessionId = sessions.get(ctx.from.id);
    if (!sessionId) return ctx.reply("Открой бота по ссылке с сайта заново.");

    const c = ctx.message.contact;

    if (c.user_id !== ctx.from.id) {
      return ctx.reply("❌ Можно отправить только свой номер.");
    }

    const phone = c.phone_number;

    const r = await fetch(`${process.env.SERVER_URL}/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-secret": process.env.BOT_SECRET,
      },
      body: JSON.stringify({ sessionId, phone }),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return ctx.reply(`❌ Ошибка: ${data?.error || "confirm failed"}`);
    }

    const backUrl = `${process.env.SITE_URL}/verify?sessionId=${sessionId}`;

    return ctx.reply(
      "✅ Подтверждено! Нажми чтобы вернуться на сайт:",
      Markup.inlineKeyboard([Markup.button.url("🚀 Вернуться на сайт", backUrl)])
    );
  });

  bot.launch();
  console.log("✅ Bot running...");
}