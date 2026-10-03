/**
 * Croatian dates at the start of a line or list item ("1. 1. 2015.",
 * "17. svibnja 2021.") parse as an ordered-list marker in CommonMark: the day
 * becomes item "1." of a nested list and the rest of the date renders offset
 * from the bullet. Escaping the day's dot keeps the date plain text.
 *
 * Only a day followed by a month (number or name) and a four-digit year
 * matches, so genuine list items ("1. Pravna osnova") are left alone.
 */
const HR_MONTHS =
    "siječnja|veljače|ožujka|travnja|svibnja|lipnja|srpnja|kolovoza|rujna|listopada|studenoga|studenog|prosinca";

const LINE_START_DATE_RE = new RegExp(
    String.raw`^(\s*(?:(?:[-*+]|\d{1,3}\.)\s+)*)(\d{1,2})\.(?=\s*(?:\d{1,2}\.\s*\d{4}(?!\d)|(?:${HR_MONTHS})\s+\d{4}(?!\d)))`,
    "gimu",
);

export function escapeLineStartDates(markdown: string): string {
    return markdown.replace(LINE_START_DATE_RE, "$1$2\\.");
}
