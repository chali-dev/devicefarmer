import type { Sql } from 'postgres';
import { ALERT_KINDS, CHANNEL_KIND_IDS } from '../modules/notify/rules.js';

/**
 * One-off data migration: the single Telegram config (`settings` key `alerts.telegram`: tokenEnc, chatId,
 * enabled, language) → one row in `alert_channels` (type telegram, name "Telegram"), then the key is deleted.
 * The sealed token is copied as is (same secret-box key). The old per-kind "Telegram on/off" flags in
 * `alerts.rules` become the channel's `kinds` (missing flags take the kind's default). If no kind had
 * Telegram on, the channel is created disabled with the default kinds (empty would mean "all").
 * An old config without token or chat id was never sendable: the key is deleted without a channel.
 * Idempotent: keyed on the settings row, inside one transaction (runs from src/db/migrate.ts after the schema).
 */
const KEY = 'alerts.telegram';

export async function migrateTelegramSettings(sql: Sql, log: (msg: string) => void = console.log): Promise<number> {
  return sql.begin(async (tx) => {
    const [old] = await tx<{ value: { enabled?: boolean; chatId?: string | null; tokenEnc?: string | null; language?: string } }[]>`
      select value from settings where key = ${KEY} for update`;
    if (!old) return 0;
    const v = old.value ?? {};
    let created = 0;
    if (v.tokenEnc && v.chatId) {
      const [rules] = await tx<{ value: { kinds?: Record<string, { telegram?: boolean }> } }[]>`select value from settings where key = 'alerts.rules'`;
      const on = CHANNEL_KIND_IDS.filter((k) => rules?.value?.kinds?.[k]?.telegram ?? ALERT_KINDS[k].defaultOn);
      const kinds = on.length ? on : CHANNEL_KIND_IDS.filter((k) => ALERT_KINDS[k].defaultOn);
      const [taken] = await tx`select 1 from alert_channels where name = 'Telegram'`;
      const config = { chatId: v.chatId, threadId: null, language: v.language === 'en' ? 'en' : 'zh-CN', botTokenEnc: v.tokenEnc };
      await tx`insert into alert_channels (name, type, enabled, config, kinds)
        values (${taken ? 'Telegram (migrated)' : 'Telegram'}, 'telegram', ${Boolean(v.enabled) && on.length > 0}, ${JSON.stringify(config)}::jsonb, string_to_array(${kinds.join(',')}, ','))`;
      created = 1;
      log(`alert channels: migrated the Telegram settings into channel "Telegram" (kinds: ${kinds.join(', ')})`);
    } else {
      log('alert channels: old Telegram settings had no token or chat id; removed without creating a channel');
    }
    await tx`delete from settings where key = ${KEY}`;
    return created;
  });
}
