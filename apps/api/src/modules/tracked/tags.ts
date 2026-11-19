/** Tag rules of tracked accounts (追踪账号). */

/** Max length of one tag (checked on the trimmed value). */
export const TAG_MAX = 32;
/** Max tags per account in a request body. */
export const TAG_LIMIT = 20;

/** Lowercase, trimmed, deduplicated. */
export const normTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
