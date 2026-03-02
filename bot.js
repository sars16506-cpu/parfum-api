import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
dotenv.config();

const sessions = new Map();
const pendingCode = new Map();
const adminSessions = new Set();
const adminPanelMsg = new Map();

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

async function isAdmin(phone) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/admins_phones_numbers?select=phone`, { headers });
    const data = await r.json().catch(() => []);
    if (!Array.isArray(data)) return false;
    return data.some((row) => {
      const stored = typeof row.phone === "string"
        ? row.phone.replace(/^"|"$/g, "").trim()
        : String(row.phone).trim();
      return normalizePhone(stored) === normalizePhone(phone);
    });
  } catch (e) {
    console.error("isAdmin error:", e);
    return false;
  }
}

function formatDate(iso) {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatDateShort(iso) {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit", month: "2-digit",
  });
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getOrders(limit = 30) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?order=created_at.desc&limit=${limit}&select=*`,
      { headers }
    );
    const data = await r.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("getOrders error:", e);
    return [];
  }
}

async function getOrderById(orderId) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=*`, { headers });
    const data = await r.json().catch(() => []);
    return Array.isArray(data) ? data[0] || null : null;
  } catch (e) {
    console.error("getOrderById error:", e);
    return null;
  }
}

async function getOrderItemsStatus(orderId) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/order_items_status?order_id=eq.${orderId}`,
      { headers }
    );
    const data = await r.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("getOrderItemsStatus error:", e);
    return [];
  }
}

async function setItemGiven(orderId, productId, newGiven) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/order_items_status`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([{ order_id: orderId, product_id: productId, given: newGiven }]),
    });
  } catch (e) {
    console.error("setItemGiven upsert error:", e);
  }

  if (!newGiven) return;

  try {
    const order = await getOrderById(orderId);
    if (!order?.items) return;
    const item = order.items.find((i) => String(i.product_id) === String(productId));
    if (!item) return;
    const qty = item.quantity || 1;
    const rp = await fetch(
      `${SUPABASE_URL}/rest/v1/products?id=eq.${productId}&select=id,item_left`,
      { headers }
    );
    const products = await rp.json().catch(() => []);
    const product = Array.isArray(products) ? products[0] : null;
    if (!product) return;
    const newLeft = Math.max(0, (product.item_left || 0) - qty);
    await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ item_left: newLeft }),
    });
  } catch (e) {
    console.error("setItemGiven stock error:", e);
  }
}

// ─── Билдеры ──────────────────────────────────────────────────────────────────

function buildMainMenuContent() {
  const now = new Date().toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  return {
    text: `👑 *Панель администратора*\n_Обновлено: ${now}_`,
    kb: Markup.inlineKeyboard([
      [Markup.button.callback("📦 Заказы", "orders_list"), Markup.button.callback("📊 Статистика", "stats")],
      [Markup.button.callback("🔄 Обновить", "main_menu")],
    ]),
  };
}

async function buildOrdersListContent() {
  const orders = await getOrders(30);

  if (orders.length === 0) {
    return {
      text: `📦 *Заказы*\n\n📭 Заказов пока нет.\n_Как только придёт первый — ты получишь уведомление._`,
      kb: Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Обновить", "orders_list"), Markup.button.callback("🏠 Меню", "main_menu")],
      ]),
    };
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
  text += `─────────────────────\n_Выбери заказ:_`;

  const buttons = orders.map((o, i) => {
    const statuses = allStatuses[i];
    const items = Array.isArray(o.items) ? o.items : [];
    const givenCount = statuses.filter((s) => s.given).length;
    const allDone = items.length > 0 && givenCount === items.length;
    const partial = givenCount > 0 && !allDone;
    const icon = allDone ? "✅" : partial ? "🔄" : "🆕";
    const cur = o.valute || "USD";
    const label = `${icon} #${o.id.slice(0, 6)} · ${o.total} ${cur} · ${givenCount}/${items.length} · ${formatDateShort(o.created_at)}`;
    return [Markup.button.callback(label, `o_${o.id}`)];
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

  const statusIcon = allGiven ? "✅" : givenCount > 0 ? "🔄" : "🆕";
  const statusText = allGiven ? "Выдан полностью" : givenCount > 0 ? "Частично выдан" : "Новый заказ";

  let text = `${statusIcon} *${statusText}*\n`;
  text += `──────────────────────\n`;
  text += `🆔 \`${order.id.slice(0, 8).toUpperCase()}\`\n`;
  text += `📅 ${formatDate(order.created_at)}\n`;
  if (order.customer_phone) text += `📱 \`${order.customer_phone}\`\n`;
  text += `📊 Выдано: *${givenCount}/${items.length}*\n`;
  text += `──────────────────────\n`;

  items.forEach((item) => {
    const st = statuses.find((s) => String(s.product_id) === String(item.product_id));
    const given = st?.given || false;
    const qty = item.quantity || 1;
    const price = item.price ?? 0;
    text += `${given ? "✅" : "⬜️"} *${item.title}* · ${item.ml_sizes}ml\n`;
    text += `    ${qty} шт · ${price} ${cur} · итого *${qty * price} ${cur}*\n`;
  });

  text += `──────────────────────\n`;
  text += `💰 *Итого: ${order.total} ${cur}*`;
  if (!allGiven) text += `\n\n_Нажми на товар чтобы отметить выданным_`;

  const buttons = items.map((item) => {
    const st = statuses.find((s) => String(s.product_id) === String(item.product_id));
    const given = st?.given || false;
    const name = String(item.title).slice(0, 22);
    return [
      Markup.button.callback(
        `${given ? "✅" : "⬜️"} ${name} · ${item.ml_sizes}ml`,
        `tgl_${order.id}__${item.product_id}`
      ),
    ];
  });

  buttons.push([
    Markup.button.callback("◀️ К заказам", "orders_list"),
    Markup.button.callback("🔄", `o_${order.id}`),
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

    const todayOrders     = orders.filter((o) => new Date(o.created_at).toLocaleDateString("ru-RU") === todayStr);
    const yesterdayOrders = orders.filter((o) => new Date(o.created_at).toLocaleDateString("ru-RU") === yesterdayStr);
    const weekOrders      = orders.filter((o) => new Date(o.created_at) >= weekAgo);
    const sum = (arr) => arr.reduce((s, o) => s + (o.total || 0), 0);
    const avg = Math.round(sum(orders) / orders.length);

    const productCount = {};
    orders.forEach((o) => {
      (Array.isArray(o.items) ? o.items : []).forEach((item) => {
        const key = item.title || item.product_id;
        productCount[key] = (productCount[key] || 0) + (item.quantity || 1);
      });
    });
    const topProducts = Object.entries(productCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

    let text = `📊 *Статистика*\n──────────────────────\n`;
    text += `📦 Всего заказов: *${orders.length}*\n`;
    text += `💰 Общая выручка: *${sum(orders)} USD*\n`;
    text += `📈 Средний чек: *${avg} USD*\n`;
    text += `──────────────────────\n`;
    text += `☀️ Сегодня: *${todayOrders.length}* · *${sum(todayOrders)} USD*\n`;
    text += `🌙 Вчера: *${yesterdayOrders.length}* · *${sum(yesterdayOrders)} USD*\n`;
    text += `📅 7 дней: *${weekOrders.length}* · *${sum(weekOrders)} USD*\n`;

    if (topProducts.length > 0) {
      text += `──────────────────────\n🏆 *Топ товары:*\n`;
      ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"].forEach((m, i) => {
        if (topProducts[i]) text += `${m} ${topProducts[i][0]} — *${topProducts[i][1]} шт*\n`;
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
    console.error("buildStatsContent error:", e);
    return {
      text: `📊 *Статистика*\n\n❌ Ошибка загрузки.`,
      kb: Markup.inlineKeyboard([[Markup.button.callback("🏠 Меню", "main_menu")]]),
    };
  }
}

const adminReplyMenu = Markup.keyboard([
  ["📦 Заказы", "📊 Статистика"],
  ["🏠 Меню"],
]).resize();

// ─── startBot ─────────────────────────────────────────────────────────────────

export async function startBot() {
  if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
  if (!process.env.SERVER_URL) throw new Error("SERVER_URL missing");
  if (!process.env.SITE_URL) throw new Error("SITE_URL missing");

  const bot = new Telegraf(process.env.BOT_TOKEN);

  bot.catch((err, ctx) => {
    console.error("BOT ERROR:", err?.message || err);
    ctx?.answerCbQuery?.("❌ Ошибка, попробуй ещё раз").catch(() => {});
  });

  await bot.telegram.setMyCommands([
    { command: "start", description: "🏠 Главное меню" },
    { command: "orders", description: "📦 Заказы" },
    { command: "stats", description: "📊 Статистика" },
  ]);

  async function updatePanel(ctx, buildFn, ...args) {
    await ctx.answerCbQuery().catch(() => {});
    if (!adminSessions.has(ctx.from.id)) return;
    let content;
    try {
      content = await buildFn(...args);
    } catch (e) {
      console.error("updatePanel error:", e);
      return ctx.answerCbQuery("❌ Ошибка загрузки", { show_alert: true }).catch(() => {});
    }
    if (!content) return ctx.answerCbQuery("❌ Не найдено", { show_alert: true }).catch(() => {});
    const { text, kb } = content;
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
    } catch (e) {
      if (!e.message?.includes("message is not modified")) {
        const sent = await ctx.reply(text, { parse_mode: "Markdown", ...kb });
        adminPanelMsg.set(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id });
      }
    }
  }

  async function sendPanel(ctx, content) {
    const { text, kb } = content;
    const stored = adminPanelMsg.get(ctx.from.id);
    if (stored) {
      try {
        await bot.telegram.editMessageText(stored.chatId, stored.messageId, null, text, {
          parse_mode: "Markdown", ...kb,
        });
        return;
      } catch (e) {
        if (!e.message?.includes("message is not modified")) adminPanelMsg.delete(ctx.from.id);
        else return;
      }
    }
    const sent = await ctx.reply(text, { parse_mode: "Markdown", ...kb });
    adminPanelMsg.set(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id });
  }

  bot.start(async (ctx) => {
    const sessionId = ctx.startPayload;
    if (adminSessions.has(ctx.from.id) && !sessionId) {
      const content = buildMainMenuContent();
      const sent = await ctx.reply(content.text, { parse_mode: "Markdown", ...content.kb, ...adminReplyMenu });
      adminPanelMsg.set(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id });
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
      parse_mode: "Markdown", ...Markup.removeKeyboard(),
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
      const content = buildMainMenuContent();
      const sent = await ctx.reply(
        `👑 *Добро пожаловать, Администратор!*\n\n${content.text}`,
        { parse_mode: "Markdown", ...content.kb, ...adminReplyMenu }
      );
      adminPanelMsg.set(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id });
      return;
    }
    return ctx.reply("✅ *Номер подтверждён!*\nМожешь вернуться на сайт:", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.url("🚀 На сайт", backUrl)]]),
    });
  });

  bot.action("main_menu", (ctx) => updatePanel(ctx, buildMainMenuContent));
  bot.action("orders_list", (ctx) => updatePanel(ctx, buildOrdersListContent));
  bot.action("stats", (ctx) => updatePanel(ctx, buildStatsContent));
  bot.action(/^o_([0-9a-f-]+)$/, (ctx) => updatePanel(ctx, buildOrderContent, ctx.match[1]));

  bot.action(/^tgl_([0-9a-f-]+)__(.+)$/, async (ctx) => {
    if (!adminSessions.has(ctx.from.id))
      return ctx.answerCbQuery("❌ Нет доступа", { show_alert: true });
    const orderId = ctx.match[1];
    const productId = ctx.match[2];
    try {
      const statuses = await getOrderItemsStatus(orderId);
      const current = statuses.find((s) => String(s.product_id) === String(productId));
      const newGiven = !(current?.given || false);
      await setItemGiven(orderId, productId, newGiven);
      await ctx.answerCbQuery(newGiven ? "✅ Выдан" : "↩️ Отменено").catch(() => {});
      await updatePanel(ctx, buildOrderContent, orderId);
    } catch (e) {
      console.error("tgl action error:", e);
      await ctx.answerCbQuery("❌ Ошибка", { show_alert: true }).catch(() => {});
    }
  });

  bot.notifyAdmins = async (order) => {
    const adminTgIds = [...adminSessions];
    if (adminTgIds.length === 0) return;
    const items = Array.isArray(order.items) ? order.items : [];
    const cur = order.valute || "USD";
    const itemList = items.map((i) =>
      `• ${i.title} ${i.ml_sizes}ml × ${i.quantity} = ${i.quantity * i.price} ${cur}`
    ).join("\n");

    const msg =
      `🔔 *Новый заказ!*\n──────────────────────\n` +
      `🆔 \`${order.id.slice(0, 8).toUpperCase()}\`\n` +
      `📅 ${formatDate(order.created_at)}\n` +
      (order.customer_phone ? `📱 \`${order.customer_phone}\`\n` : "") +
      `──────────────────────\n` +
      (itemList ? `${itemList}\n──────────────────────\n` : "") +
      `💰 *Итого: ${order.total} ${cur}*`;

    const kb = Markup.inlineKeyboard([[Markup.button.callback("📋 Открыть заказ", `o_${order.id}`)]]);
    for (const tgId of adminTgIds) {
      try {
        await bot.telegram.sendMessage(tgId, msg, { parse_mode: "Markdown", ...kb });
      } catch (e) {
        console.error(`Failed to notify admin ${tgId}:`, e.message);
      }
    }
  };

  try {
    await bot.launch();
    console.log("✅ Bot running...");
  } catch (e) {
    const msg = e?.response?.description || e?.message || String(e);
    console.error("❌ BOT LAUNCH ERROR:", msg);
    if (String(msg).includes("409")) return bot;
    throw e;
  }

  return bot;
}