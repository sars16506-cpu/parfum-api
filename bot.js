import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
dotenv.config();

const sessions = new Map();    // tgId -> sessionId
const pendingCode = new Map(); // tgId -> { sessionId, phone }
const adminSessions = new Set();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

// ─── Утилиты ──────────────────────────────────────────────────────────────────

const normalizePhone = (p = "") => {
  let s = String(p).trim().replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) s = "+" + s.replace(/\+/g, "");
  return s;
};

async function isAdmin(phone) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/admins_phones_numbers?select=phone`,
      { headers }
    );
    const data = await r.json().catch(() => []);
    if (!Array.isArray(data)) return false;

    return data.some((row) => {
      const stored =
        typeof row.phone === "string"
          ? row.phone.replace(/^"|"$/g, "").trim()
          : String(row.phone).trim();
      return normalizePhone(stored) === normalizePhone(phone);
    });
  } catch (e) {
    console.log("isAdmin error:", e);
    return false;
  }
}

// ─── Supabase запросы ─────────────────────────────────────────────────────────

async function getOrders(limit = 30) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?order=created_at.desc&limit=${limit}&select=*`,
    { headers }
  );
  return r.json().catch(() => []);
}

async function getOrderById(orderId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=*`,
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

async function setItemGiven(orderId, productId, newGiven) {
  await fetch(`${SUPABASE_URL}/rest/v1/order_items_status`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([
      { order_id: orderId, product_id: productId, given: newGiven },
    ]),
  });

  if (!newGiven) return;

  try {
    const order = await getOrderById(orderId);
    if (!order?.items) return;

    // items — массив объектов { id, title, quantity, price, total }
    const item = order.items.find((i) => String(i.id) === String(productId));
    if (!item) return;

    const qty = item.quantity || 1;

    // Уменьшаем item_left в products
    const rp = await fetch(
      `${SUPABASE_URL}/rest/v1/products?id=eq.${productId}&select=id,item_left`,
      { headers }
    );
    const products = await rp.json().catch(() => []);
    const product = products?.[0];
    if (!product) return;

    const newLeft = Math.max(0, (product.item_left || 0) - qty);
    await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ item_left: newLeft }),
    });
    console.log(`item_left: ${product.item_left} -> ${newLeft} for ${productId}`);
  } catch (e) {
    console.log("setItemGiven error:", e);
  }
}

// ─── Форматирование заказа ────────────────────────────────────────────────────

/**
 * Структура order из БД:
 * {
 *   id, created_at, customer_phone,
 *   total,
 *   basket: [
 *     { id, title, quantity, price, total },
 *     ...
 *   ]
 * }
 */

async function buildOrderText(order, statuses) {
  const basket = Array.isArray(order.items) ? order.items : [];

  const date = new Date(order.created_at).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const allGiven =
    basket.length > 0 &&
    basket.every((item) =>
      statuses.find((s) => String(s.product_id) === String(item.id))?.given
    );

  let msg = `${allGiven ? "✅ Выдан" : "🛒 Заказ"}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🆔 *#${order.id.slice(0, 8)}*\n`;
  msg += `📅 ${date}\n`;
  if (order.customer_phone) msg += `📱 ${order.customer_phone}\n`;
  msg += `💰 Итого: *${order.total} USD*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `*Товары:*\n`;

  basket.forEach((item) => {
    const st = statuses.find((s) => String(s.product_id) === String(item.id));
    const given = st?.given || false;
    const name = item.title || item.id;
    const qty = item.quantity || 1;
    const price = item.price ?? "?";
    const itemTotal = item.total ?? (qty * price);
    msg += `${given ? "✅" : "⬜"} *${name}*\n`;
    msg += `   ${qty} шт × ${price} USD = ${itemTotal} USD\n`;
  });

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `_Нажми товар чтобы отметить выданным_`;
  return msg;
}

function buildOrderKeyboard(order, statuses) {
  const basket = Array.isArray(order.items) ? order.items : [];
  const buttons = [];

  basket.forEach((item) => {
    const st = statuses.find((s) => String(s.product_id) === String(item.id));
    const given = st?.given || false;
    const name = String(item.title || item.id).slice(0, 28);
    buttons.push([
      Markup.button.callback(
        `${given ? "✅" : "⬜"} ${name}`,
        `tgl_${order.id}__${item.id}`
      ),
    ]);
  });

  buttons.push([
    Markup.button.callback("🔙 К заказам", "orders_list"),
    Markup.button.callback("🔄 Обновить", `order_${order.id}`),
  ]);

  return Markup.inlineKeyboard(buttons);
}

// ─── Reply keyboard ───────────────────────────────────────────────────────────

const adminMainMenu = Markup.keyboard([
  ["📦 Заказы", "📊 Статистика"],
  ["🔄 Обновить"],
]).resize();

// ─── Список заказов ───────────────────────────────────────────────────────────

async function showOrdersList(ctx, mode = "reply") {
  const orders = await getOrders(30);

  if (!Array.isArray(orders) || orders.length === 0) {
    const text = "📭 *Заказов пока нет*\n\nКак только придёт первый заказ — ты получишь уведомление.";
    if (mode === "edit")
      return ctx.editMessageText(text, { parse_mode: "Markdown" }).catch(() =>
        ctx.reply(text, { parse_mode: "Markdown" })
      );
    return ctx.reply(text, { parse_mode: "Markdown" });
  }

  const statusPromises = orders.map((o) => getOrderItemsStatus(o.id));
  const allStatuses = await Promise.all(statusPromises);

  const buttons = orders.map((o, i) => {
    const statuses = allStatuses[i];
    const basket = Array.isArray(o.items) ? o.items : [];
    const date = new Date(o.created_at).toLocaleDateString("ru-RU");
    const itemCount = basket.length;
    const givenCount = statuses.filter((s) => s.given).length;
    const allDone = itemCount > 0 && givenCount === itemCount;
    const icon = allDone ? "✅" : givenCount > 0 ? "🔄" : "🆕";
    const phone = o.customer_phone ? ` | ${o.customer_phone}` : "";

    return [
      Markup.button.callback(
        `${icon} #${o.id.slice(0, 6)} | ${o.total}$ | ${givenCount}/${itemCount}${phone} | ${date}`,
        `order_${o.id}`
      ),
    ];
  });

  buttons.push([Markup.button.callback("🔄 Обновить список", "orders_list")]);

  const text = `📦 *Заказы* (последние ${orders.length})\n🆕 новый  🔄 частично выдан  ✅ полностью выдан`;

  try {
    if (mode === "edit") {
      return ctx.editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons),
      });
    }
    return ctx.reply(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    console.log("showOrdersList error:", e.message);
  }
}

// ─── Статистика ───────────────────────────────────────────────────────────────

async function showStats(ctx, mode = "reply") {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?select=id,total,created_at,items,customer_phone`,
      { headers }
    );
    const orders = await r.json().catch(() => []);

    if (!Array.isArray(orders) || orders.length === 0) {
      const text = "📊 *Статистика*\n\nЗаказов ещё нет.";
      if (mode === "edit")
        return ctx.editMessageText(text, { parse_mode: "Markdown" }).catch(() =>
          ctx.reply(text, { parse_mode: "Markdown" })
        );
      return ctx.reply(text, { parse_mode: "Markdown" });
    }

    const total = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const today = new Date().toLocaleDateString("ru-RU");
    const todayOrders = orders.filter(
      (o) => new Date(o.created_at).toLocaleDateString("ru-RU") === today
    );
    const todayTotal = todayOrders.reduce((sum, o) => sum + (o.total || 0), 0);

    // Топ товары из basket
    const productCount = {};
    orders.forEach((o) => {
      const basket = Array.isArray(o.items) ? o.items : [];
      basket.forEach((item) => {
        const key = item.title || item.id;
        productCount[key] = (productCount[key] || 0) + (item.quantity || 1);
      });
    });

    const topProducts = Object.entries(productCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    let text = `📊 *Статистика*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📦 Всего заказов: *${orders.length}*\n`;
    text += `💰 Общая выручка: *${total} USD*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🗓 Сегодня заказов: *${todayOrders.length}*\n`;
    text += `💵 Сегодня выручка: *${todayTotal} USD*\n`;

    if (topProducts.length > 0) {
      text += `━━━━━━━━━━━━━━━━━━━━\n`;
      text += `🏆 *Топ товары:*\n`;
      topProducts.forEach(([name, count], i) => {
        text += `${i + 1}. ${name} — ${count} шт\n`;
      });
    }

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("📦 К заказам", "orders_list")],
    ]);

    if (mode === "edit")
      return ctx
        .editMessageText(text, { parse_mode: "Markdown", ...kb })
        .catch(() => ctx.reply(text, { parse_mode: "Markdown", ...kb }));
    return ctx.reply(text, { parse_mode: "Markdown", ...kb });
  } catch (e) {
    console.log("showStats error:", e);
  }
}

// ─── startBot ─────────────────────────────────────────────────────────────────

export async function startBot() {
  if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
  if (!process.env.SERVER_URL) throw new Error("SERVER_URL missing");
  if (!process.env.SITE_URL) throw new Error("SITE_URL missing");

  const bot = new Telegraf(process.env.BOT_TOKEN);

  await bot.telegram.setMyCommands([
    { command: "start", description: "🏠 Главное меню" },
    { command: "orders", description: "📦 Список заказов" },
    { command: "stats", description: "📊 Статистика" },
  ]);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const sessionId = ctx.startPayload;

    if (adminSessions.has(ctx.from.id) && !sessionId) {
      return ctx.reply("👑 *Панель администратора*\nВыбери действие:", {
        parse_mode: "Markdown",
        ...adminMainMenu,
      });
    }

    if (!sessionId) {
      return ctx.reply("Открой бота по ссылке с сайта для авторизации.");
    }

    sessions.set(ctx.from.id, sessionId);
    return ctx.reply(
      "👋 Привет!\nНажми кнопку чтобы поделиться номером телефона:",
      Markup.keyboard([Markup.button.contactRequest("📱 Поделиться номером")]).resize()
    );
  });

  // ── /orders ───────────────────────────────────────────────────────────────
  bot.command("orders", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return ctx.reply("❌ Нет доступа.");
    await showOrdersList(ctx, "reply");
  });

  // ── /stats ────────────────────────────────────────────────────────────────
  bot.command("stats", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return ctx.reply("❌ Нет доступа.");
    await showStats(ctx, "reply");
  });

  // ── Reply кнопки ──────────────────────────────────────────────────────────
  bot.hears("📦 Заказы", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return;
    await showOrdersList(ctx, "reply");
  });

  bot.hears("📊 Статистика", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return;
    await showStats(ctx, "reply");
  });

  bot.hears("🔄 Обновить", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return;
    return ctx.reply("✅ Бот работает!", adminMainMenu);
  });

  // ── Контакт — получаем телефон, ждём код ─────────────────────────────────
  bot.on("contact", async (ctx) => {
    const sessionId = sessions.get(ctx.from.id);
    if (!sessionId) return ctx.reply("Открой бота по ссылке с сайта заново.");

    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) {
      return ctx.reply("❌ Можно отправить только свой номер.");
    }

    const phone = normalizePhone(c.phone_number);
    pendingCode.set(ctx.from.id, { sessionId, phone });
    sessions.delete(ctx.from.id);

    return ctx.reply(
      "✅ Номер получен!\n\nТеперь введи *6-значный код* с сайта:",
      { parse_mode: "Markdown", ...Markup.removeKeyboard() }
    );
  });

  // ── Текст — ловим 6-значный код ───────────────────────────────────────────
  bot.on("text", async (ctx) => {
    const text = ctx.message.text?.trim();
    if (!text || text.startsWith("/")) return;
    if (["📦 Заказы", "📊 Статистика", "🔄 Обновить"].includes(text)) return;

    const pending = pendingCode.get(ctx.from.id);
    if (!pending) return;

    if (!/^\d{6}$/.test(text)) {
      return ctx.reply("Введи ровно 6 цифр. Попробуй ещё раз.");
    }

    const { sessionId, phone } = pending;

    try {
      const r = await fetch(`${process.env.SERVER_URL}/confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bot-secret": process.env.BOT_SECRET,
        },
        body: JSON.stringify({ sessionId, phone, code: text }),
      });
      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        if (data?.error === "Wrong code") {
          return ctx.reply("❌ Неверный код. Посмотри код на сайте и попробуй ещё раз.");
        }
        return ctx.reply(`❌ Ошибка: ${data?.error || "confirm failed"}`);
      }
    } catch {
      return ctx.reply("❌ Сервер недоступен. Попробуй позже.");
    }

    pendingCode.delete(ctx.from.id);

    const admin = await isAdmin(phone);
    const backUrl = `${process.env.SITE_URL}/verify?sessionId=${sessionId}`;

    if (admin) {
      adminSessions.add(ctx.from.id);
      return ctx.reply(
        "👑 *Добро пожаловать, Администратор!*\nВыбери действие:",
        { parse_mode: "Markdown", ...adminMainMenu }
      );
    }

    return ctx.reply(
      "✅ Номер подтверждён!\nМожешь вернуться на сайт:",
      Markup.inlineKeyboard([[Markup.button.url("🚀 На сайт", backUrl)]])
    );
  });

  // ── Inline: список заказов ────────────────────────────────────────────────
  bot.action("orders_list", async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminSessions.has(ctx.from.id)) return;
    await showOrdersList(ctx, "edit");
  });

  // ── Inline: открыть заказ ─────────────────────────────────────────────────
  bot.action(/^order_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminSessions.has(ctx.from.id)) return;

    const orderId = ctx.match[1];
    const order = await getOrderById(orderId);
    if (!order) return ctx.answerCbQuery("❌ Заказ не найден", { show_alert: true });

    const statuses = await getOrderItemsStatus(orderId);
    const msg = await buildOrderText(order, statuses);
    const kb = buildOrderKeyboard(order, statuses);

    try {
      await ctx.editMessageText(msg, { parse_mode: "Markdown", ...kb });
    } catch {
      await ctx.reply(msg, { parse_mode: "Markdown", ...kb });
    }
  });

  // ── Inline: галочка товара ────────────────────────────────────────────────
  bot.action(/^tgl_([0-9a-f-]+)__(.+)$/, async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) {
      return ctx.answerCbQuery("❌ Нет доступа", { show_alert: true });
    }

    const orderId = ctx.match[1];
    const productId = ctx.match[2];

    const statuses = await getOrderItemsStatus(orderId);
    const current = statuses.find((s) => String(s.product_id) === String(productId));
    const newGiven = !(current?.given || false);

    await setItemGiven(orderId, productId, newGiven);
    await ctx.answerCbQuery(newGiven ? "✅ Отмечен как выданный" : "↩️ Отметка снята");

    const order = await getOrderById(orderId);
    if (!order) return;

    const newStatuses = await getOrderItemsStatus(orderId);
    const msg = await buildOrderText(order, newStatuses);
    const kb = buildOrderKeyboard(order, newStatuses);

    try {
      await ctx.editMessageText(msg, { parse_mode: "Markdown", ...kb });
    } catch (e) {
      console.log("edit error:", e.message);
    }
  });

  // ── Уведомление о новом заказе ────────────────────────────────────────────
  bot.notifyAdmins = async (order) => {
    const adminTgIds = [...adminSessions];
    if (adminTgIds.length === 0) {
      console.log("No active admin sessions to notify");
      return;
    }

    const msg = await buildOrderText(order, []);

    for (const tgId of adminTgIds) {
      try {
        await bot.telegram.sendMessage(tgId, `🔔 *Новый заказ!*\n\n${msg}`, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("📋 Открыть заказ", `order_${order.id}`)],
          ]),
        });
      } catch (e) {
        console.log(`Failed to notify admin ${tgId}:`, e.message);
      }
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