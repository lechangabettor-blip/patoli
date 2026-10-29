import "server-only";

/**
 * Operator alerts to LeChanga's Telegram. Console-only until two env vars exist on Vercel:
 * ALERT_TELEGRAM_BOT_TOKEN (a bot from @BotFather) and ALERT_TELEGRAM_CHAT_ID (his chat with that
 * bot). Throttled per key so a failing cron does not page every minute.
 */
const lastSent = new Map<string, number>();

export async function alertOps(key: string, text: string, minGapMs = 30 * 60_000): Promise<void> {
  const now = Date.now();
  if ((lastSent.get(key) ?? 0) > now - minGapMs) return;
  lastSent.set(key, now);
  console.error(`[patoli:alert] ${key}: ${text}`);
  const token = process.env.ALERT_TELEGRAM_BOT_TOKEN;
  const chat = process.env.ALERT_TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `Patoli · ${key}\n${text}`.slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* alerts never break the job */
  }
}
