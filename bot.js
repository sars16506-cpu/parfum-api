// bot.js
import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
dotenv.config();

const sessions = new Map();
const pendingCode = new Map();
const adminSessions = new Set();
const adminPanelMsg = new Map();
// Хранит все message_id для каждого admin tgId, чтобы потом удалять
const adminMessageHistory = new Map(); // tgId -> [{ chatId, messageId }]

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

const md = (s = "") => String(s).replace(/([_*`[\]])/g, "\\$1");

async function isAdmin(phone) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/admins_phones_numbers?select=phone`, { headers });
    const data = await r.json().catch(() => []);
    if (!Array.isArray(data)) return false;
    return data.some((row) => {
      const stored = typeof row.phone === "string" ? row.phone.replace(/^"|"$/g, "").trim() : String(row.phone).trim();
      return normalizePhone(stored) === normalizePhone(phone);
    });
  } catch (e) {
    console.log("isAdmin error:", e);
    return false;
  }
}

function formatDate(iso) {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDateShort(iso) {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getOrders(limit = 30) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?order=created_at.desc&limit=${limit}&select=*`, { headers });
    const data = await r.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.log("getOrders error:", e);
    return [];
  }
}

async function getOrderByShortId(shortId) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?order=created_at.desc&limit=100&select=*`, { headers });
    const data = await r.json().catch(() => []);
    if (!Array.isArray(data)) return null;
    const found = data.find((o) => String(o.id).toLowerCase().startsWith(shortId.toLowerCase()));
    console.log("getOrderByShortId", shortId, "->", found?.id || "NOT FOUND");
    return found || null;
  } catch (e) {
    console.log("getOrderByShortId error:", e);
    return null;
  }
}

async function getOrderById(orderId) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=*`, { headers });
    const data = await r.json().catch(() => []);
    return Array.isArray(data) ? data[0] || null : null;
  } catch (e) {
    console.log("getOrderById error:", e);
    return null;
  }
}

async function getOrderItemsStatus(orderId) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/order_items_status?order_id=eq.${orderId}`, { headers });
    const data = await r.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.log("getOrderItemsStatus error:", e);
    return [];
  }
}

async function setItemGiven(orderId, productId, newGiven) {
  await fetch(`${SUPABASE_URL}/rest/v1/order_items_status`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ order_id: orderId, product_id: productId, given: newGiven }]),
  }).catch(() => {});

  if (!newGiven) return;

  try {
    const order = await getOrderById(orderId);
    const items = Array.isArray(order?.items) ? order.items : [];
    const item = items.find((i) => String(i.product_id ?? i.id) === String(productId));
    if (!item) return;

    const qty = item.quantity || 1;
    const rp = await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${productId}&select=id,item_left`, { headers });
    const products = await rp.json().catch(() => []);
    const product = Array.isArray(products) ? products[0] : null;
    if (!product) return;

    const newLeft = Math.max(0, (product.item_left || 0) - qty);
    await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ item_left: newLeft }),
    }).catch(() => {});
  } catch (e) {
    console.log("setItemGiven error:", e);
  }
}

// ─── UI builders ──────────────────────────────────────────────────────────────

function buildMainMenuContent() {
  const now = new Date().toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const text = `👑 *Панель администратора*\n_Обновлено: ${now}_`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("📦 Заказы", "orders_list"), Markup.button.callback("📊 Статистика", "stats")],
    [Markup.button.callback("🔄 Обновить", "main_menu")],
  ]);
  return { text, kb };
}

async function buildOrdersListContent() {
  const orders = await getOrders(30);

  if (orders.length === 0) {
    const text = `📦 *Заказы*\n\n📭 Заказов пока нет.\n_Как только придёт первый — ты получишь уведомление._`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Обновить", "orders_list"), Markup.button.callback("🏠 Меню", "main_menu")],
    ]);
    return { text, kb };
  }

  const allStatuses = await Promise.all(orders.map((o) => getOrderItemsStatus(o.id)));

  const totalNew = allStatuses.filter((st, i) => {
    const items = Array.isArray(orders[i].items) ? orders[i].items : [];
    return items.length > 0 && st.filter((s) => s.given).length === 0;
  }).length;

  const totalDone = allStatuses.filter((st, i) => {
    const items = Array.isArray(orders[i].items) ? orders[i].items : [];
    return items.length > 0 && st.filter((s) => s.given).length === items.length;
  }).length;

  let text = `📦 *Заказы* — последние ${orders.length}\n`;
  text += `🆕 новых: *${totalNew}*  ✅ выдано: *${totalDone}*\n`;
  text += `─────────────────────\n`;
  text += `_Выбери заказ:_`;

  const buttons = orders.map((o, i) => {
    const statuses = allStatuses[i];
    const items = Array.isArray(o.items) ? o.items : [];
    const givenCount = statuses.filter((s) => s.given).length;
    const itemCount = items.length;
    const allDone = itemCount > 0 && givenCount === itemCount;
    const partial = givenCount > 0 && !allDone;
    const icon = allDone ? "✅" : partial ? "🔄" : "🆕";
    const cur = o.valute || "USD";
    const date = formatDateShort(o.created_at);
    const shortId = o.id.slice(0, 8);
    const label = `${icon} #${shortId} · ${o.total} ${cur} · ${givenCount}/${itemCount} · ${date}`;
    return [Markup.button.callback(label, `oid_${shortId}`)];
  });

  buttons.push([
    Markup.button.callback("🔄 Обновить", "orders_list"),
    Markup.button.callback("🏠 Меню", "main_menu"),
  ]);

  return { text, kb: Markup.inlineKeyboard(buttons) };
}

async function buildOrderContent(orderId) {
  const order = await getOrderById(orderId);
  if (!order) return null;

  const statuses = await getOrderItemsStatus(orderId);
  const items = Array.isArray(order.items) ? order.items : [];
  const givenCount = statuses.filter((s) => s.given).length;
  const allGiven = items.length > 0 && givenCount === items.length;
  const cur = order.valute || "USD";
  const shortId = order.id.slice(0, 8);
  const statusIcon = allGiven ? "✅" : givenCount > 0 ? "🔄" : "🆕";
  const statusText = allGiven ? "Выдан полностью" : givenCount > 0 ? "Частично выдан" : "Новый заказ";

  let text = `${statusIcon} *${statusText}*\n`;
  text += `──────────────────────\n`;
  text += `🆔 \`${shortId.toUpperCase()}\`\n`;
  text += `📅 ${formatDate(order.created_at)}\n`;
  if (order.customer_phone) text += `📱 \`${order.customer_phone}\`\n`;
  text += `📊 Выдано: *${givenCount}/${items.length}*\n`;
  text += `──────────────────────\n`;

  for (const item of items) {
    const pid = item.product_id ?? item.id;
    const st = statuses.find((s) => String(s.product_id) === String(pid));
    const given = st?.given || false;
    const title = md(item.title ?? pid);
    const ml = item.ml_sizes ?? "";
    const qty = item.quantity || 1;
    const price = item.price ?? 0;
    const total = item.total ?? qty * price;
    text += `${given ? "✅" : "⬜️"} *${title}*${ml ? ` · ${ml}ml` : ""}\n`;
    text += `    ${qty} шт · ${price} ${cur} · итого *${total} ${cur}*\n`;
  }

  text += `──────────────────────\n`;
  text += `💰 *Итого: ${order.total} ${cur}*`;
  if (!allGiven) text += `\n\n_Нажми на товар чтобы отметить выданным_`;

  const buttons = items.map((item, idx) => {
    const pid = item.product_id ?? item.id;
    const st = statuses.find((s) => String(s.product_id) === String(pid));
    const given = st?.given || false;
    const name = String(item.title ?? pid).slice(0, 20);
    const ml = item.ml_sizes ?? "";
    return [
      Markup.button.callback(
        `${given ? "✅" : "⬜️"} ${name}${ml ? ` · ${ml}ml` : ""}`,
        `tgl_${shortId}_${idx}`
      ),
    ];
  });

  buttons.push([
    Markup.button.callback("◀️ К заказам", "orders_list"),
    Markup.button.callback("🔄", `oid_${shortId}`),
  ]);

  return { text, kb: Markup.inlineKeyboard(buttons) };
}

async function buildStatsContent() {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?select=id,total,valute,created_at,items,customer_phone&order=created_at.desc`,
      { headers }
    );
    const orders = await r.json().catch(() => []);

    if (!Array.isArray(orders) || orders.length === 0) {
      return {
        text: `📊 *Статистика*\n\nЗаказов ещё нет.`,
        kb: Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню", "main_menu")]]),
      };
    }

    const now = new Date();
    const todayStr = now.toLocaleDateString("ru-RU");
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString("ru-RU");
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const todayOrders = orders.filter((o) => new Date(o.created_at).toLocaleDateString("ru-RU") === todayStr);
    const yesterdayOrders = orders.filter((o) => new Date(o.created_at).toLocaleDateString("ru-RU") === yesterdayStr);
    const weekOrders = orders.filter((o) => new Date(o.created_at) >= weekAgo);

    const sum = (arr) => arr.reduce((s, o) => s + (o.total || 0), 0);
    const avg = Math.round(sum(orders) / orders.length);

    const productCount = {};
    orders.forEach((o) => {
      (Array.isArray(o.items) ? o.items : []).forEach((item) => {
        const key = item.title || item.product_id || item.id;
        productCount[key] = (productCount[key] || 0) + (item.quantity || 1);
      });
    });

    const topProducts = Object.entries(productCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

    let text = `📊 *Статистика*\n`;
    text += `──────────────────────\n`;
    text += `📦 Всего заказов: *${orders.length}*\n`;
    text += `💰 Общая выручка: *${sum(orders)} USD*\n`;
    text += `📈 Средний чек: *${avg} USD*\n`;
    text += `──────────────────────\n`;
    text += `☀️ Сегодня: *${todayOrders.length}* · *${sum(todayOrders)} USD*\n`;
    text += `🌙 Вчера: *${yesterdayOrders.length}* · *${sum(yesterdayOrders)} USD*\n`;
    text += `📅 7 дней: *${weekOrders.length}* · *${sum(weekOrders)} USD*\n`;

    if (topProducts.length > 0) {
      text += `──────────────────────\n`;
      text += `🏆 *Топ товары:*\n`;
      const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
      topProducts.forEach(([name, count], i) => {
        text += `${medals[i]} ${md(name)} — *${count} шт*\n`;
      });
    }

    return {
      text,
      kb: Markup.inlineKeyboard([
        [Markup.button.callback("📦 Заказы", "orders_list"), Markup.button.callback("🔄 Обновить", "stats")],
        [Markup.button.callback("🏠 Меню", "main_menu")],
      ]),
    };
  } catch (e) {
    console.log("buildStatsContent error:", e);
    return {
      text: `📊 *Статистика*\n\n❌ Ошибка загрузки.`,
      kb: Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню", "main_menu")]]),
    };
  }
}

// ─── startBot ────────────────────────────────────────────────────────────────

export async function startBot() {
  if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
  if (!process.env.SERVER_URL) throw new Error("SERVER_URL missing");
  if (!process.env.SITE_URL) throw new Error("SITE_URL missing");

  const bot = new Telegraf(process.env.BOT_TOKEN);

  await bot.telegram.setMyCommands([
    { command: "start", description: "🏠 Главное меню" },
    { command: "orders", description: "📦 Заказы" },
    { command: "stats", description: "📊 Статистика" },
  ]);

  // ── Helpers для работы с историей сообщений ────────────────────────────────

  /**
   * Добавить message_id в историю для данного tgId
   */
  function trackMessage(tgId, chatId, messageId) {
    if (!adminMessageHistory.has(tgId)) adminMessageHistory.set(tgId, []);
    adminMessageHistory.get(tgId).push({ chatId, messageId });
  }

  /**
   * Удалить все отслеживаемые сообщения для данного tgId
   */
  async function clearHistory(tgId) {
    const msgs = adminMessageHistory.get(tgId);
    if (!msgs || msgs.length === 0) return;
    adminMessageHistory.set(tgId, []); // сначала очищаем, потом удаляем
    for (const { chatId, messageId } of msgs) {
      await bot.telegram.deleteMessage(chatId, messageId).catch(() => {});
    }
  }

  /**
   * Удалить всю историю и отправить свежее панельное сообщение.
   * Используется для команд (/start, /orders, /stats, текстовых кнопок).
   */
  async function sendPanel(ctx, content) {
    const { text, kb } = content;
    const tgId = ctx.from.id;

    // Удаляем входящее сообщение пользователя (команда / текст)
    if (ctx.message?.message_id) {
      await bot.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
    }

    // Удаляем всю предыдущую историю панели
    await clearHistory(tgId);
    adminPanelMsg.delete(tgId);

    const sent = await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb.reply_markup });
    trackMessage(tgId, sent.chat.id, sent.message_id);
    adminPanelMsg.set(tgId, { chatId: sent.chat.id, messageId: sent.message_id });
  }

  /**
   * Обновить панель через editMessageText (для inline-кнопок).
   * Если editMessageText не работает — удалить историю и отправить заново.
   */
  async function updatePanel(ctx, buildFn, ...args) {
    await ctx.answerCbQuery().catch(() => {});
    if (!adminSessions.has(ctx.from.id)) return;

    const content = await buildFn(...args);
    if (!content) return;

    const { text, kb } = content;
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb.reply_markup });
      // Сообщение уже отслеживается, editMessageText не меняет message_id — всё ок
    } catch (e) {
      if (!String(e?.message || "").includes("message is not modified")) {
        // Не удалось отредактировать — удаляем всё и шлём новое
        const tgId = ctx.from.id;
        await clearHistory(tgId);
        adminPanelMsg.delete(tgId);

        const sent = await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb.reply_markup });
        trackMessage(tgId, sent.chat.id, sent.message_id);
        adminPanelMsg.set(tgId, { chatId: sent.chat.id, messageId: sent.message_id });
      }
    }
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  bot.start(async (ctx) => {
    const sessionId = ctx.startPayload;
    if (adminSessions.has(ctx.from.id) && !sessionId) {
      await sendPanel(ctx, buildMainMenuContent());
      return;
    }
    if (!sessionId) return ctx.reply("🔐 Открой бота по ссылке с сайта для авторизации.");
    sessions.set(ctx.from.id, sessionId);
    return ctx.reply("👋 *Привет!*\nНажми кнопку ниже чтобы поделиться номером телефона:", {
      parse_mode: "Markdown",
      ...Markup.keyboard([Markup.button.contactRequest("📱 Поделиться номером")]).resize(),
    });
  });

  bot.command("orders", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return ctx.reply("❌ Нет доступа.");
    await sendPanel(ctx, await buildOrdersListContent());
  });

  bot.command("stats", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return ctx.reply("❌ Нет доступа.");
    await sendPanel(ctx, await buildStatsContent());
  });

  bot.hears("📦 Заказы", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return;
    await sendPanel(ctx, await buildOrdersListContent());
  });

  bot.hears("📊 Статистика", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return;
    await sendPanel(ctx, await buildStatsContent());
  });

  bot.hears("🏠 Меню", async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return;
    await sendPanel(ctx, buildMainMenuContent());
  });

  bot.on("contact", async (ctx) => {
    const sessionId = sessions.get(ctx.from.id);
    if (!sessionId) return ctx.reply("Открой бота по ссылке с сайта заново.");
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) return ctx.reply("❌ Можно отправить только свой номер.");
    const phone = normalizePhone(c.phone_number);
    pendingCode.set(ctx.from.id, { sessionId, phone });
    sessions.delete(ctx.from.id);
    return ctx.reply("✅ *Номер получен!*\n\nТеперь введи *6-значный код* с сайта:", {
      parse_mode: "Markdown",
      ...Markup.removeKeyboard(),
    });
  });

  bot.on("text", async (ctx) => {
    const text = ctx.message.text?.trim();
    if (!text || text.startsWith("/")) return;
    if (["📦 Заказы", "📊 Статистика", "🏠 Меню"].includes(text)) return;

    const pending = pendingCode.get(ctx.from.id);
    if (!pending) return;

    if (!/^\d{6}$/.test(text)) return ctx.reply("Введи ровно 6 цифр. Попробуй ещё раз.");

    const { sessionId, phone } = pending;

    try {
      const r = await fetch(`${process.env.SERVER_URL}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bot-secret": process.env.BOT_SECRET },
        body: JSON.stringify({ sessionId, phone, code: text }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (data?.error === "Wrong code") return ctx.reply("❌ Неверный код. Посмотри на сайте и попробуй ещё раз.");
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
      await sendPanel(ctx, buildMainMenuContent());
      return;
    }

    return ctx.reply("✅ *Номер подтверждён!*\nМожешь вернуться на сайт:", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.url("🚀 На сайт", backUrl)]]),
    });
  });

  // ── Inline actions ─────────────────────────────────────────────────────────

  bot.action("main_menu", (ctx) => updatePanel(ctx, buildMainMenuContent));
  bot.action("orders_list", (ctx) => updatePanel(ctx, buildOrdersListContent));
  bot.action("stats", (ctx) => updatePanel(ctx, buildStatsContent));

  bot.action(/^oid_([0-9a-f]{8})$/i, async (ctx) => {
    const shortId = ctx.match[1];
    const order = await getOrderByShortId(shortId);
    if (!order) return ctx.answerCbQuery("❌ Заказ не найден", { show_alert: true });
    return updatePanel(ctx, buildOrderContent, order.id);
  });

  bot.action(/^tgl_([0-9a-f]{8})_(\d+)$/i, async (ctx) => {
    if (!adminSessions.has(ctx.from.id)) return ctx.answerCbQuery("❌ Нет доступа", { show_alert: true });

    const shortId = ctx.match[1];
    const itemIndex = parseInt(ctx.match[2], 10);

    const order = await getOrderByShortId(shortId);
    if (!order) return ctx.answerCbQuery("❌ Заказ не найден", { show_alert: true });

    const items = Array.isArray(order.items) ? order.items : [];
    const item = items[itemIndex];
    if (!item) return ctx.answerCbQuery("❌ Товар не найден", { show_alert: true });

    const productId = item.product_id ?? item.id;
    const statuses = await getOrderItemsStatus(order.id);
    const current = statuses.find((s) => String(s.product_id) === String(productId));
    const newGiven = !(current?.given || false);

    await setItemGiven(order.id, productId, newGiven);
    await ctx.answerCbQuery(newGiven ? "✅ Выдан" : "↩️ Отмена").catch(() => {});
    await updatePanel(ctx, buildOrderContent, order.id);
  });

  // ── Уведомление о новом заказе ─────────────────────────────────────────────

  bot.notifyAdmins = async (order) => {
    const adminTgIds = [...adminSessions];
    if (adminTgIds.length === 0) return;

    const items = Array.isArray(order.items) ? order.items : [];
    const cur = order.valute || "USD";
    const shortId = order.id.slice(0, 8);

    const itemList = items
      .map((i) => {
        const title = md(i.title ?? "");
        const ml = i.ml_sizes ?? "";
        const q = i.quantity || 1;
        const p = i.price || 0;
        return `• ${title}${ml ? ` ${ml}ml` : ""} × ${q} = ${q * p} ${cur}`;
      })
      .join("\n");

    const msg =
      `🔔 *Новый заказ!*\n` +
      `──────────────────────\n` +
      `🆔 \`${shortId.toUpperCase()}\`\n` +
      `📅 ${formatDate(order.created_at)}\n` +
      (order.customer_phone ? `📱 \`${order.customer_phone}\`\n` : "") +
      `──────────────────────\n` +
      (itemList ? `${itemList}\n──────────────────────\n` : "") +
      `💰 *Итого: ${order.total} ${cur}*`;

    const kb = Markup.inlineKeyboard([[Markup.button.callback("📋 Открыть заказ", `oid_${shortId}`)]]);

    for (const tgId of adminTgIds) {
      const sent = await bot.telegram
        .sendMessage(tgId, msg, { parse_mode: "Markdown", reply_markup: kb.reply_markup })
        .catch(() => null);
      // Уведомление о заказе тоже отслеживаем, чтобы оно удалялось при следующем sendPanel
      if (sent) trackMessage(tgId, sent.chat.id, sent.message_id);
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