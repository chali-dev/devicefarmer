import { openSecret, sealSecret } from './secret-box.js';

/**
 * Typed config objects with write-only secret fields, stored as jsonb (device sources, alert channels).
 * A driver lists its secret field names; each is stored sealed as `<field>Enc` and returned only as `<field>Set`.
 */
export interface WithSecrets { secrets?: readonly string[] }
type Raw = Record<string, unknown>;

/** Stored config → driver config: `<field>Enc` of each secret field opened back into `<field>`. */
export function openConfig(driver: WithSecrets, stored: unknown): Raw {
  const out: Raw = { ...(stored as Raw) };
  for (const f of driver.secrets ?? []) {
    const enc = out[`${f}Enc`];
    delete out[`${f}Enc`];
    if (typeof enc === 'string') out[f] = openSecret(enc);
  }
  return out;
}

/**
 * Config entered in the UI → what the driver gets for its test, with secret fields merged: absent
 * keeps the stored value, null or '' clears it.
 */
export function mergeSecrets(driver: WithSecrets, input: Raw, stored: unknown): Raw {
  const cur = openConfig(driver, stored ?? {});
  const out: Raw = { ...input };
  for (const f of driver.secrets ?? []) {
    if (!(f in input)) { if (cur[f] !== undefined) out[f] = cur[f]; }
    else if (input[f] === null || input[f] === '') delete out[f];
  }
  return out;
}

/** Validated driver config → stored form (secret fields sealed as `<field>Enc`). */
export function sealConfig(driver: WithSecrets, cfg: Raw): Raw {
  const out: Raw = { ...cfg };
  for (const f of driver.secrets ?? []) {
    if (typeof out[f] === 'string') out[`${f}Enc`] = sealSecret(out[f] as string);
    delete out[f];
  }
  return out;
}

/** Stored config → what the API returns: secrets only as `<field>Set`. */
export function publicConfig(driver: WithSecrets, stored: unknown): Raw {
  const out: Raw = { ...(stored as Raw) };
  for (const f of driver.secrets ?? []) { out[`${f}Set`] = typeof out[`${f}Enc`] === 'string'; delete out[`${f}Enc`]; }
  return out;
}
