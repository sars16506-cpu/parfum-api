// ============================================================
// Пример отправки заказа с сайта (React / Vite)
// Вызови эту функцию после успешной оплаты / подтверждения
// ============================================================

const SERVER_URL = import.meta.env.SERVER_URL; // https://твой-сервер.onrender.com
const BOT_SECRET = import.meta.env.VITE_BOT_SECRET; // тот же что в .env сервера

/**
 * Создать заказ
 * @param {string} customerPhone - телефон покупателя (из сессии верификации)
 * @param {number} total - общая сумма в USD
 * @param {Array} cartItems - [{id, title, price, quantity}]
 */
export async function createOrder(customerPhone, total, cartItems) {
  try {
    const res = await fetch(`${SERVER_URL}/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-secret": BOT_SECRET,
      },
      body: JSON.stringify({
        customer_phone: customerPhone,
        total,
        items: cartItems.map((item) => ({
          id: item.id,
          title: item.title,
          price: item.price,
          quantity: item.quantity || 1,
        })),
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || "Order failed");
    }

    return { ok: true, orderId: data.orderId };
  } catch (e) {
    console.error("createOrder error:", e);
    return { ok: false, error: e.message };
  }
}

// ── Пример использования в компоненте ────────────────────────────────────────

/*
import { createOrder } from "./api/orders";

async function handleCheckout() {
  const result = await createOrder(
    userPhone,      // '+79991234567' — из localStorage или контекста
    cartTotal,      // 250
    cart            // [{id: 'uuid', title: 'Stronger', price: 100, quantity: 2}, ...]
  );

  if (result.ok) {
    // очистить корзину, показать "спасибо"
    clearCart();
    navigate("/success");
  } else {
    alert("Ошибка оформления заказа: " + result.error);
  }
}
*/