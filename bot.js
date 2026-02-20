import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
dotenv.config();

const sessions = new Map(); // tgId -> sessionId
const adminSessions = new Set(); // tgId тех кто уже прошёл как админ

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

// ─── Утилиты ───────────────────────────────────────────────────────────────

const normalizePhone = (p = "") => {
  let s = String(p).trim().replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) s = "+" + s.replace(/\+/g, "");
  return s;
};

async function isAdmin(phone) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/admin_phones?phone=eq.${encodeURIComponent(phone)}&select=phone`,
      { headers }
    );
    const data = await r.json().catch(() => []);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

async function getOrders(limit = 20) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?order=created_at.desc&limit=${limit}`,
    { headers }
  );
  return r.json().catch(() => []);
}

async function getOrderById(orderId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`,
    { headers }
  );
  const data = await r.json().catch(() => []);
  return data?.[0] || null;
}

async function getOrderItemsStatus(orderId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/order_items_status?order_id=eq.${orderId}`,
    { headers }
  );
  return r.json().catch(() => []);
}

async function toggleItemGiven(orderId, productId, newGiven) {
  // Upsert статуса (нужен unique constraint на order_id + product_id в Supabase)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/order_items_status`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([{ order_id: orderId, product_id: productId, given: newGiven }]),
  });

  if (!newGiven) return; // если снимаем галочку — не трогаем item_left

  // Если выдан — уменьшаем item_left у продукта
  try {
    const order = await getOrderById(orderId);
    if (!order?.items) return;

    const item = order.items.find((i) => String(i.id) === String(productId));
    if (!item) return;

    const qty = item.quantity || 1;

    const pr = await fetch(
      `${SUPABASE_URL}/rest/v1/perfumes?id=eq.${productId}&select=id,item_left`,
      { headers }
    );
    const [product] = await pr.json().catch(() => []);
    if (!product) return;

    const newLeft = Math.max(0, (product.item_left || 0) - qty);

    await fetch(`${SUPABASE_URL}/rest/v1/perfumes?id=eq.${productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ item_left: newLeft }),
    });
  } catch (e) {
    console.log("toggleItemGiven error:", e);
  }
}

// ─── Форматирование ─────────────────────────────────────────────────────────

function formatOrderMessage(order, statuses = []) {
  const date = new Date(order.created_at).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const allGiven =
    Array.isArray(order.items) &&
    order.items.length > 0 &&
    order.items.every((item) =>
      statuses.find((s) => String(s.product_id) === String(item.id))?.given
    );

  let msg = `${allGiven ? "✅" : "🛒"} *Заказ #${order.id.slice(0, 8)}*\n`;
  msg += `📅 ${date}\n`;
  if (order.customer_phone) msg += `📱 ${order.customer_phone}\n`;
  msg += `💰 Итого: *${order.total} USD*\n\n`;
  msg += `*Товары:*\n`;

  if (Array.isArray(order.items)) {
    order.items.forEach((item, i) => {
      const st = statuses.find((s) => String(s.product_id) === String(item.id));
      const icon = st?.given ? "✅" : "⬜";
      msg += `${icon} ${item.title} × ${item.quantity || 1} — ${item.price} USD\n`;
    });
  }

  msg += `\n_Нажми на товар чтобы отметить как выданный_`;
  return msg;
}

function buildOrderKeyboard(order, statuses) {
  const buttons = [];

  if (Array.isArray(order.items)) {
    order.items.forEach((item) => {
      const st = statuses.find((s) => String(s.product_id) === String(item.id));
      const given = st?.given || false;
      const label = `${given ? "✅" : "⬜"} ${item.title} × ${item.quantity || 1}`;
      buttons.push([
        Markup.button.callback(label, `tgl_${order.id}__${item.id}`),
      ]);
    });
  }

  buttons.push([Markup.button.callback("🔙 К списку заказов", "orders_list")]);
  return Markup.inlineKeyboard(buttons);
}

// ─── Главный экспорт ────────────────────────────────────────────────────────

export async function startBot() {
  if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
  if (!process.env.SERVER_URL) throw new Error("SERVER_URL missing");
  if (!process.env.SITE_URL) throw new Error("SITE_URL missing");

  const bot = new Telegraf(process.env.BOT_TOKEN);

  // ── /start ──────────────────────────────────────────────────────────────
  bot.start((ctx) => {
    const sessionId = ctx.startPayload;

    // Если уже авторизован как админ — сразу в панель
    if (adminSessions.has(ctx.from.id) && !sessionId) {
      return ctx.reply("👑 *Админ панель*", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("📦 Заказы", "orders_list")]]),
      });
    }

    if (!sessionId) return ctx.reply("Открой бота по ссылке с сайта.");

    sessions.set(ctx.from.id, sessionId);
    return ctx.reply(
      "Нажми кнопку чтобы подтвердить номер телефона:",
      Markup.keyboard([Markup.button.contactRequest("📱 Поделиться номером")]).resize()
    );
  });

  // ── /admin — быстрый вход в панель если уже авторизован ─────────────────
  bot.command("admin", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) {
      return ctx.reply("❌ У тебя нет доступа.");
    }
    return ctx.reply("👑 *Админ панель*", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("📦 Заказы", "orders_list")]]),
    });
  });

  // ── Получение контакта ───────────────────────────────────────────────────
  bot.on("contact", async (ctx) => {
    const sessionId = sessions.get(ctx.from.id);
    if (!sessionId) return ctx.reply("Открой бота по ссылке с сайта заново.");

    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) {
      return ctx.reply("❌ Можно отправить только свой номер.");
    }

    const phone = normalizePhone(c.phone_number);

    // Подтверждение верификации через сервер
    let confirmOk = false;
    try {
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
        return ctx.reply(`❌ Ошибка верификации: ${data?.error || "confirm failed"}`);
      }
      confirmOk = true;
    } catch (e) {
      return ctx.reply("❌ Сервер недоступен.");
    }

    if (!confirmOk) return;

    // Убираем клавиатуру
    await ctx.reply("✅ Номер подтверждён!", Markup.removeKeyboard());

    // Проверяем — админ?
    const admin = await isAdmin(phone);
    const backUrl = `${process.env.SITE_URL}/verify?sessionId=${sessionId}`;

    if (admin) {
      adminSessions.add(ctx.from.id);
      sessions.delete(ctx.from.id);

      return ctx.reply("👑 *Добро пожаловать, Администратор!*\n\nВыбери действие:", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📦 Заказы", "orders_list")],
          [Markup.button.url("🌐 Перейти на сайт", backUrl)],
        ]),
      });
    } else {
      sessions.delete(ctx.from.id);
      return ctx.reply(
        "Нажми чтобы вернуться на сайт:",
        Markup.inlineKeyboard([[Markup.button.url("🚀 Вернуться на сайт", backUrl)]])
      );
    }
  });

  // ── Список заказов ────────────────────────────────────────────────────────
  bot.action("orders_list", async (ctx) => {
    await ctx.answerCbQuery();

    if (!adminSessions.has(ctx.from.id)) {
      return ctx.answerCbQuery("❌ Нет доступа", { show_alert: true });
    }

    const orders = await getOrders(20);

    if (!Array.isArray(orders) || orders.length === 0) {
      return ctx.editMessageText("📭 Заказов пока нет.\n\nОбновить: нажми /admin", {
        ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Обновить", "orders_list")]]),
      });
    }

    const buttons = orders.map((o) => {
      const date = new Date(o.created_at).toLocaleDateString("ru-RU");
      const label = `#${o.id.slice(0, 8)} | ${o.total} USD | ${date}`;
      return [Markup.button.callback(label, `order_${o.id}`)];
    });

    buttons.push([Markup.button.callback("🔄 Обновить", "orders_list")]);

    return ctx.editMessageText("📦 *Последние 20 заказов:*", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    });
  });

  // ── Открыть конкретный заказ ──────────────────────────────────────────────
  bot.action(/^order_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    if (!adminSessions.has(ctx.from.id)) {
      return ctx.answerCbQuery("❌ Нет доступа", { show_alert: true });
    }

    const orderId = ctx.match[1];
    const order = await getOrderById(orderId);
    if (!order) {
      return ctx.answerCbQuery("Заказ не найден", { show_alert: true });
    }

    const statuses = await getOrderItemsStatus(orderId);
    const msg = formatOrderMessage(order, statuses);
    const kb = buildOrderKeyboard(order, statuses);

    return ctx.editMessageText(msg, { parse_mode: "Markdown", ...kb });
  });

  // ── Переключить статус товара (галочка) ───────────────────────────────────
  // Callback data формат: tgl_{orderId}__{productId}
  // Два подчёркивания как разделитель, т.к. orderId = UUID (содержит дефисы)
  bot.action(/^tgl_([0-9a-f-]+)__(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    if (!adminSessions.has(ctx.from.id)) {
      return ctx.answerCbQuery("❌ Нет доступа", { show_alert: true });
    }

    const orderId = ctx.match[1];
    const productId = ctx.match[2];

    // Получаем текущий статус
    const statuses = await getOrderItemsStatus(orderId);
    const current = statuses.find((s) => String(s.product_id) === String(productId));
    const newGiven = !(current?.given || false);

    await toggleItemGiven(orderId, productId, newGiven);

    // Обновляем сообщение
    const order = await getOrderById(orderId);
    if (!order) return;

    const newStatuses = await getOrderItemsStatus(orderId);
    const msg = formatOrderMessage(order, newStatuses);
    const kb = buildOrderKeyboard(order, newStatuses);

    await ctx.answerCbQuery(newGiven ? "✅ Отмечен как выданный" : "↩️ Отметка снята");
    return ctx.editMessageText(msg, { parse_mode: "Markdown", ...kb });
  });

  // ── Уведомление о новом заказе (вызывается из index.js) ──────────────────
  bot.notifyAdmins = async (order) => {
    try {
      // Получаем всех админов из Supabase
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/admin_phones?select=phone`,
        { headers }
      );
      const admins = await r.json().catch(() => []);

      // Находим tgId всех текущих сессий-админов
      const adminTgIds = [...adminSessions];

      if (adminTgIds.length === 0) {
        console.log("No active admin sessions to notify");
        return;
      }

      const msg =
        `🔔 *Новый заказ!*\n\n` +
        formatOrderMessage(order, []).replace(
          "_Нажми на товар чтобы отметить как выданный_",
          ""
        );

      for (const tgId of adminTgIds) {
        try {
          await bot.telegram.sendMessage(tgId, msg, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("📋 Открыть заказ", `order_${order.id}`)],
            ]),
          });
        } catch (e) {
          console.log(`Failed to notify admin ${tgId}:`, e.message);
        }
      }
    } catch (e) {
      console.log("notifyAdmins error:", e);
    }
  };

  try {
    await bot.launch();
    console.log("✅ Bot running...");
  } catch (e) {
    const msg = e?.response?.description || e?.message || String(e);
    console.log("❌ BOT LAUNCH ERROR:", msg);
    if (String(msg).includes("409")) return bot;
    throw e;
  }

  return bot;
}