/**
 * E-mail messages (.eml, .msg) → document text. Phase 2 of #46 (GH #168),
 * spec `_ai/docs/superpowers/specs/2026-09-24-excel-email-formats-design.md`.
 *
 * `.eml` (RFC 822 / MIME) is parsed with mailparser, which decodes charsets
 * through iconv-lite (windows-1250, ISO-8859-2, quoted-printable, base64,
 * RFC 2047 encoded words). Outlook `.msg` is parsed with msgreader. Both map
 * onto one `ParsedEmail`, so the text has the same shape whichever client
 * produced the file:
 *
 *   [Page 1]
 *   From: Ivana Horvat <ivana@example.hr>
 *   To: Marko Kovač <marko@example.hr>
 *   Date: Tue, 29 Sep 2026 14:05:00 +0200 (2026-09-29T14:05:00+02:00)
 *   Received: Tue, 29 Sep 2026 14:05:03 +0200 (2026-09-29T14:05:03+02:00)
 *   Subject: Ugovor o zakupu
 *   Message-ID: <…>
 *   In-Reply-To: <…>
 *   Attachments:
 *   1. ugovor.pdf (application/pdf, 120 KB) — pages 2–3
 *   2. logo.png (image/png, 7 KB) — not extracted: unsupported type
 *
 *   <body: text/plain preferred, otherwise the HTML body as text>
 *
 *   [Page 2] Attachment 1: ugovor.pdf, page 1
 *   …
 *
 * Attachments, v1 (owner decision 2026-10-01): each supported attachment's
 * text is appended as further pages, read by the same extractor as an
 * uploaded document (`lib/documentText.ts` passes it in, so this module
 * never imports it). A PDF attachment keeps its pages, renumbered into the
 * e-mail's page sequence; any other attachment is one page. An attached
 * e-mail shows its headers and body; its own attachments are only listed
 * (depth 1). Child documents per attachment are v2.
 *
 * Nothing is executed or fetched: HTML is converted to text (scripts,
 * styles and images dropped), so no remote resource is ever requested.
 * Header labels are the RFC header names; the text is model-facing and
 * cached per version, so it never depends on the UI locale.
 */

import {
    simpleParser,
    type AddressObject,
    type EmailAddress,
    type HeaderLines,
} from "mailparser";
import MsgReader, { type FieldsData } from "@kenjiuno/msgreader";
import { convert as convertHtml } from "html-to-text";
import { mapWithConcurrency } from "./concurrency";

export type EmailKind = "eml" | "msg";

export function isEmailKind(kind: string | null | undefined): kind is EmailKind {
    return kind === "eml" || kind === "msg";
}

/** A header date: the value as written, and ISO 8601 with its UTC offset. */
export interface EmailDate {
    raw: string;
    iso: string | null;
}

export interface EmailAttachment {
    filename: string;
    contentType: string | null;
    size: number;
    /** The file's bytes; null when the attachment carries none we can read. */
    content: Buffer | null;
    /** An image shown inside the body (signature logo, pasted screenshot). */
    inlineImage: boolean;
    /** An embedded Outlook message, already mapped (msg only). */
    nested: ParsedEmail | null;
}

export interface ParsedEmail {
    from: string;
    to: string;
    cc: string;
    bcc: string;
    /** Sent date (the Date header / client submit time). */
    date: EmailDate | null;
    /** Receipt: the newest Received header, or Outlook's delivery time. */
    received: EmailDate | null;
    subject: string;
    messageId: string;
    inReplyTo: string;
    body: string;
    /** Said in place of the body when it could not be extracted. */
    bodyNote: string | null;
    attachments: EmailAttachment[];
}

/** Bounds on what one e-mail's text may pull in from its attachments. */
export const EMAIL_LIMITS = {
    /** An attachment above this is listed, not read. */
    maxAttachmentBytes: 25 * 1024 * 1024,
    /** Attachments read per e-mail; later ones are listed only. */
    maxAttachmentsRead: 50,
    /** Characters of attachment text per e-mail; the rest is cut. */
    maxAttachmentChars: 2_000_000,
    /** Attachments read at the same time (PDF OCR is a remote call). */
    readConcurrency: 3,
} as const;

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

const KNOWN_HEADERS = new Set([
    "from",
    "to",
    "cc",
    "subject",
    "date",
    "message-id",
    "received",
    "return-path",
    "mime-version",
    "delivered-to",
    "reply-to",
    "in-reply-to",
]);

/**
 * Whether bytes look like an RFC 822 message: a block of header fields
 * (optionally after one mbox `From ` line) carrying at least two of the
 * usual mail headers. Only binary containers are sniffed before this, so
 * a PDF or Office file never reaches it.
 */
export function looksLikeRfc822(buf: Buffer): boolean {
    const head = buf.subarray(0, 64 * 1024).toString("latin1");
    const lines = head.split(/\r?\n/);
    let i = 0;
    if (lines[0]?.startsWith("From ")) i = 1;
    if (!/^[!-9;-~]+:/.test(lines[i] ?? "")) return false;
    const seen = new Set<string>();
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line === "") break;
        if (/^[ \t]/.test(line)) continue; // folded continuation
        const m = line.match(/^([!-9;-~]+):/);
        if (!m) return false;
        const name = m[1].toLowerCase();
        if (KNOWN_HEADERS.has(name)) seen.add(name);
    }
    return seen.size >= 2;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ZONE_OFFSETS: Readonly<Record<string, number>> = {
    UT: 0,
    UTC: 0,
    GMT: 0,
    Z: 0,
    EST: -300,
    EDT: -240,
    CST: -360,
    CDT: -300,
    MST: -420,
    MDT: -360,
    PST: -480,
    PDT: -420,
};

/** `2026-09-29T14:05:00+02:00` — the instant in its own UTC offset. */
export function isoWithOffset(epochMs: number, offsetMinutes: number): string {
    const local = new Date(epochMs + offsetMinutes * 60_000)
        .toISOString()
        .slice(0, 19);
    const sign = offsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(offsetMinutes);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${local}${sign}${hh}:${mm}`;
}

/**
 * A header date as written plus its normalised form. The offset is the one
 * the date was written with: deadlines run from receipt, so the local time
 * of the sending or receiving server is kept rather than converted to UTC.
 * `fallback` (a date the parser already resolved) is used when the raw
 * text cannot be parsed here.
 */
export function emailDate(
    raw: string | null | undefined,
    fallback?: Date | null,
): EmailDate | null {
    const written = oneLine(raw ?? "");
    if (!written) return null;
    const bare = written.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    let offset = 0;
    const numeric = bare.match(/(?:^|\s)([+-])(\d{2})(\d{2})$/);
    if (numeric) {
        offset =
            (numeric[1] === "-" ? -1 : 1) *
            (Number(numeric[2]) * 60 + Number(numeric[3]));
    } else {
        const zone = bare.match(/\s([A-Za-z]{1,3})$/);
        offset = zone ? (ZONE_OFFSETS[zone[1].toUpperCase()] ?? 0) : 0;
    }
    let epoch = Date.parse(bare);
    if (Number.isNaN(epoch) && fallback && !Number.isNaN(fallback.getTime()))
        epoch = fallback.getTime();
    return {
        raw: written,
        iso: Number.isNaN(epoch) ? null : isoWithOffset(epoch, offset),
    };
}

/** The date part of a Received trace header (after its last `;`). */
function receivedDate(value: string | null | undefined): EmailDate | null {
    if (!value) return null;
    const semi = value.lastIndexOf(";");
    return semi >= 0 ? emailDate(value.slice(semi + 1)) : null;
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/** Header values and file names on one line, without control characters. */
function oneLine(value: string, max = 2000): string {
    return value
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
}

/** A body as text with `\n` line ends (Outlook stores PR_BODY with CRLF). */
function normalizeBody(text: string): string {
    return text.replace(/\r\n?/g, "\n").trim();
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * HTML body → plain text. html-to-text (also what mailparser uses) parses
 * the markup without running it; scripts, styles and `<head>` are dropped,
 * images are skipped (so no remote image is ever referenced), links keep
 * their target unless it repeats the link text, and tables stay readable
 * as columns. No hard wrapping, so quotes match the source sentences.
 */
export function htmlToPlainText(html: string): string {
    const noCaps = { uppercase: false };
    return convertHtml(html, {
        wordwrap: false,
        selectors: [
            { selector: "img", format: "skip" },
            { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
            { selector: "h1", options: noCaps },
            { selector: "h2", options: noCaps },
            { selector: "h3", options: noCaps },
            { selector: "h4", options: noCaps },
            { selector: "h5", options: noCaps },
            { selector: "h6", options: noCaps },
            {
                selector: "table",
                format: "dataTable",
                options: { uppercaseHeaderCells: false },
            },
        ],
    }).trim();
}

/** WHATWG encoding label for a Windows code page (PidTagInternetCodepage). */
export function codepageLabel(codepage: number | null | undefined): string | null {
    if (!codepage) return null;
    if (codepage === 65001) return "utf-8";
    if (codepage === 1200) return "utf-16le";
    if (codepage === 20127) return "us-ascii";
    if (codepage >= 1250 && codepage <= 1258) return `windows-${codepage}`;
    if (codepage >= 28591 && codepage <= 28606)
        return `iso-8859-${codepage - 28590}`;
    const named: Record<number, string> = {
        874: "windows-874",
        932: "shift_jis",
        936: "gbk",
        949: "euc-kr",
        950: "big5",
        20866: "koi8-r",
        21866: "koi8-u",
        50220: "iso-2022-jp",
        51932: "euc-jp",
    };
    return named[codepage] ?? null;
}

/** Bytes in a declared code page; unknown → UTF-8, then Windows-1250. */
function decodeBytes(bytes: Uint8Array, label: string | null): string {
    if (label) {
        try {
            return new TextDecoder(label).decode(bytes);
        } catch {
            // Unknown label — fall through to the default guess.
        }
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder("windows-1250").decode(bytes);
    }
}

/** Values of one header in a raw header block, folded lines joined. */
function headerValues(block: string, name: string): string[] {
    const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
    const out: string[] = [];
    const prefix = `${name.toLowerCase()}:`;
    for (const line of unfolded.split(/\r?\n/)) {
        if (line.toLowerCase().startsWith(prefix))
            out.push(line.slice(prefix.length).trim());
    }
    return out;
}

function headerLineValues(lines: HeaderLines, key: string): string[] {
    return lines
        .filter((h) => h.key === key)
        .map((h) => {
            const unfolded = h.line.replace(/\r?\n[ \t]+/g, " ");
            const colon = unfolded.indexOf(":");
            return colon >= 0 ? unfolded.slice(colon + 1).trim() : "";
        });
}

// ---------------------------------------------------------------------------
// .eml (mailparser)
// ---------------------------------------------------------------------------

function formatAddress(a: EmailAddress): string {
    if (a.group)
        return `${oneLine(a.name)}: ${a.group.map(formatAddress).join(", ")};`;
    const name = oneLine(a.name ?? "");
    const address = oneLine(a.address ?? "");
    if (name && address && name !== address) return `${name} <${address}>`;
    return address || name;
}

function formatAddresses(
    value: AddressObject | AddressObject[] | undefined,
): string {
    if (!value) return "";
    return (Array.isArray(value) ? value : [value])
        .flatMap((o) => o.value)
        .map(formatAddress)
        .filter(Boolean)
        .join(", ");
}

async function parseEml(buf: Buffer): Promise<ParsedEmail> {
    const mail = await simpleParser(buf, {
        // Our own HTML conversion (no hard wraps), text/plain preferred.
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipTextLinks: true,
        // Keep cid: links as they are instead of inlining every image as a
        // data: URI into the HTML we are about to throw away.
        skipImageLinks: true,
    });
    // mailparser reports a header-less input as one header line with no key.
    if (
        !mail.headerLines.some((h) => h.key) &&
        !mail.text?.trim() &&
        !mail.html &&
        mail.attachments.length === 0
    )
        throw new Error("Unreadable e-mail: no headers and no content");

    let body = normalizeBody(mail.text ?? "");
    if (!body && mail.html) body = normalizeBody(htmlToPlainText(mail.html));

    return {
        from: formatAddresses(mail.from),
        to: formatAddresses(mail.to),
        cc: formatAddresses(mail.cc),
        bcc: formatAddresses(mail.bcc),
        date: emailDate(headerLineValues(mail.headerLines, "date")[0], mail.date),
        received: receivedDate(headerLineValues(mail.headerLines, "received")[0]),
        subject: oneLine(mail.subject ?? ""),
        messageId: oneLine(mail.messageId ?? ""),
        inReplyTo: oneLine(mail.inReplyTo ?? ""),
        body,
        bodyNote: null,
        attachments: mail.attachments.map((a) => {
            const contentType = (a.contentType || "").toLowerCase() || null;
            const shownInline =
                a.related === true || a.contentDisposition === "inline";
            return {
                filename: oneLine(a.filename ?? "", 255),
                contentType,
                size: a.size ?? a.content?.length ?? 0,
                content: Buffer.isBuffer(a.content) ? a.content : null,
                inlineImage: shownInline && !!contentType?.startsWith("image/"),
                nested: null,
            };
        }),
    };
}

// ---------------------------------------------------------------------------
// .msg (msgreader)
// ---------------------------------------------------------------------------

const PT_STRING8 = 0x001e;
const PID_TAG_IN_REPLY_TO_ID = 0x1042;

interface MsgExtras {
    /** Raw In-Reply-To (PidTagInReplyToId), which msgreader does not map. */
    inReplyTo: Map<FieldsData, Uint8Array>;
    /** Whether any non-Unicode (code-page) string property was seen. */
    sawAnsi: boolean;
}

function readMsg(
    bytes: Buffer,
    ansiEncoding: string | null,
): { fields: FieldsData; reader: MsgReader; extras: MsgExtras } {
    const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const reader = new MsgReader(ab);
    const extras: MsgExtras = { inReplyTo: new Map(), sawAnsi: false };
    reader.parserConfig = {
        ...(ansiEncoding ? { ansiEncoding } : {}),
        propertyObserver: (fields, tag, raw) => {
            if ((tag & 0xffff) === PT_STRING8) extras.sawAnsi = true;
            // The property stream reports the same tag with an 8-byte size
            // record; the value is the (longer) `__substg1.0_` stream.
            if (tag >>> 16 === PID_TAG_IN_REPLY_TO_ID && raw) {
                const seen = extras.inReplyTo.get(fields);
                if (!seen || raw.length > seen.length)
                    extras.inReplyTo.set(fields, raw);
            }
        },
    };
    const fields = reader.getFileData();
    if (!fields || fields.dataType !== "msg" || fields.error)
        throw new Error(
            `Unreadable Outlook message: ${fields?.error ?? "not a .msg file"}`,
        );
    return { fields, reader, extras };
}

function msgRecipient(r: FieldsData): string {
    const smtp = r.smtpAddress || (r.email?.includes("@") ? r.email : "");
    return formatAddress({ name: r.name ?? "", address: smtp ?? "" });
}

function msgSender(f: FieldsData): string {
    const smtp =
        f.senderSmtpAddress ||
        (f.senderEmail?.includes("@") ? f.senderEmail : "") ||
        "";
    return formatAddress({ name: f.senderName ?? "", address: smtp });
}

function decodeInReplyTo(raw: Uint8Array | undefined, ansi: string | null): string {
    if (!raw) return "";
    // 0x1042001F is UTF-16LE; 0x1042001E is a code-page string.
    const looksUtf16 = raw.length > 1 && raw[1] === 0;
    const text = looksUtf16
        ? new TextDecoder("utf-16le").decode(raw)
        : decodeBytes(raw, ansi);
    return oneLine(text.replace(/\u0000+$/, ""));
}

/**
 * `depth` 0 is the file itself; an embedded message (depth 1) is mapped
 * for its headers and body, and anything embedded deeper is not mapped.
 */
function mapMsg(
    f: FieldsData,
    reader: MsgReader | null,
    extras: MsgExtras,
    ansi: string | null,
    depth = 0,
): ParsedEmail {
    const transport = f.headers ?? "";
    const recipients = f.recipients ?? [];
    const byType = (t: "to" | "cc" | "bcc") =>
        recipients
            .filter((r) => (r.recipType ?? "to") === t)
            .map(msgRecipient)
            .filter(Boolean)
            .join(", ");

    let body = normalizeBody(f.body ?? "");
    let bodyNote: string | null = null;
    if (!body) {
        const html =
            f.bodyHtml ||
            (f.html
                ? decodeBytes(f.html, codepageLabel(f.internetCodepage))
                : "");
        if (html) body = normalizeBody(htmlToPlainText(html));
        else if (f.compressedRtf)
            bodyNote =
                "(The message body is stored only as RTF and was not extracted.)";
    }

    const attachments: EmailAttachment[] = (f.attachments ?? []).map((a) => {
        const contentType = (a.attachMimeTag ?? "").toLowerCase() || null;
        if (a.innerMsgContent && a.innerMsgContentFields) {
            const inner = a.innerMsgContentFields;
            const nested =
                depth === 0 ? mapMsg(inner, null, extras, ansi, depth + 1) : null;
            const base = oneLine(a.name || inner.subject || "message", 200);
            return {
                filename: /\.msg$/i.test(base) ? base : `${base}.msg`,
                contentType: "application/vnd.ms-outlook",
                size: a.contentLength ?? 0,
                content: null,
                inlineImage: false,
                nested,
            };
        }
        let content: Buffer | null = null;
        if (reader && typeof a.dataId === "number") {
            try {
                content = Buffer.from(reader.getAttachment(a).content);
            } catch {
                content = null;
            }
        }
        const filename = oneLine(a.fileName || a.fileNameShort || a.name || "", 255);
        const isImage =
            !!contentType?.startsWith("image/") ||
            /\.(png|jpe?g|gif|bmp|tiff?|emf|wmf)$/i.test(filename);
        return {
            filename,
            contentType,
            size: a.contentLength ?? content?.length ?? 0,
            content,
            inlineImage:
                isImage && (a.attachmentHidden === true || !!a.pidContentId),
            nested: null,
        };
    });

    return {
        from: msgSender(f),
        to: byType("to"),
        cc: byType("cc"),
        bcc: byType("bcc"),
        date:
            emailDate(headerValues(transport, "date")[0]) ??
            emailDate(f.clientSubmitTime),
        received:
            receivedDate(headerValues(transport, "received")[0]) ??
            emailDate(f.messageDeliveryTime),
        subject: oneLine(f.subject ?? ""),
        messageId: oneLine(
            f.messageId || headerValues(transport, "message-id")[0] || "",
        ),
        inReplyTo:
            decodeInReplyTo(extras.inReplyTo.get(f), ansi) ||
            oneLine(headerValues(transport, "in-reply-to")[0] ?? ""),
        body,
        bodyNote,
        attachments,
    };
}

function parseMsg(buf: Buffer): ParsedEmail {
    let read = readMsg(buf, null);
    let ansi: string | null = null;
    // Strings saved in a code page (non-Unicode .msg) decode as Latin-1
    // unless msgreader is told the page; re-read with the message's own
    // code page, defaulting to Windows-1250 (Croatian) like decodeText.
    if (read.extras.sawAnsi) {
        ansi =
            codepageLabel(
                read.fields.messageCodepage ?? read.fields.internetCodepage,
            ) ?? "windows-1250";
        try {
            read = readMsg(buf, ansi);
        } catch {
            ansi = null; // iconv-lite does not know the page — keep pass one
        }
    }
    return mapMsg(read.fields, read.reader, read.extras, ansi);
}

/** Parse an e-mail file into the shared shape. Throws when unreadable. */
export async function parseEmail(
    kind: EmailKind,
    bytes: Buffer,
): Promise<ParsedEmail> {
    return kind === "msg" ? parseMsg(bytes) : parseEml(bytes);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** How `renderEmailText` reads an attachment — supplied by documentText. */
export interface EmailTextDeps {
    /** The content kind to read an attachment as; null when unsupported. */
    kindOf: (att: EmailAttachment & { content: Buffer }) => string | null;
    /**
     * Text of a non-e-mail attachment. `complete: false` marks a result that
     * must not be cached (OCR fell back to the text layer, a worker limit).
     */
    extract: (
        kind: string,
        bytes: Buffer,
    ) => Promise<{ text: string; complete: boolean }>;
}

type AttachmentResult =
    | { ok: true; segments: { label: string; text: string }[]; complete: boolean }
    | { ok: false; reason: string; complete: boolean };

/** A paged text (PDF) → its pages, keyed by the page number it had. */
function splitPages(text: string): { page: number | null; text: string }[] {
    return text.split(/\n(?=[ \t]*\[Page \d+\])/).map((part) => {
        const m = part.match(/^[ \t]*\[Page (\d+)\][ \t]*\n?/);
        return m
            ? { page: Number(m[1]), text: part.slice(m[0].length) }
            : { page: null, text: part };
    });
}

/** An attachment's name, safe to put on a page-marker line. */
function displayName(att: EmailAttachment): string {
    return oneLine(att.filename, 255) || "(unnamed)";
}

function describe(att: EmailAttachment): string {
    const name = displayName(att);
    const meta = [
        att.contentType ? oneLine(att.contentType, 100) : null,
        att.size ? formatBytes(att.size) : null,
    ]
        .filter(Boolean)
        .join(", ");
    return meta ? `${name} (${meta})` : name;
}

function headerBlock(email: ParsedEmail): string[] {
    const lines: string[] = [];
    const add = (label: string, value: string | null | undefined) => {
        if (value) lines.push(`${label}: ${value}`);
    };
    const date = (d: EmailDate | null) =>
        d ? (d.iso ? `${d.raw} (${d.iso})` : d.raw) : null;
    add("From", email.from);
    add("To", email.to);
    add("Cc", email.cc);
    add("Bcc", email.bcc);
    add("Date", date(email.date));
    add("Received", date(email.received));
    add("Subject", email.subject);
    add("Message-ID", email.messageId);
    add("In-Reply-To", email.inReplyTo);
    return lines;
}

function bodyText(email: ParsedEmail): string {
    return email.body || email.bodyNote || "(no body text)";
}

/**
 * Header block, the attachment list and the body of an e-mail whose
 * attachments are not read (an attached e-mail, depth 1).
 */
function nestedEmailText(email: ParsedEmail): string {
    const lines = headerBlock(email);
    const listed = email.attachments.filter((a) => !a.inlineImage);
    const inline = email.attachments.length - listed.length;
    if (listed.length) {
        lines.push("Attachments:");
        listed.forEach((a, i) =>
            lines.push(
                `${i + 1}. ${describe(a)} — not extracted: attachment of an attached e-mail`,
            ),
        );
    }
    if (inline) lines.push(`Inline images: ${inline} (not extracted)`);
    return `${lines.join("\n")}\n\n${bodyText(email)}`;
}

async function readAttachment(
    att: EmailAttachment,
    deps: EmailTextDeps,
): Promise<AttachmentResult> {
    const name = displayName(att);
    if (att.nested)
        return {
            ok: true,
            segments: [{ label: name, text: nestedEmailText(att.nested) }],
            complete: true,
        };
    if (!att.content || att.content.length === 0)
        return { ok: false, reason: "no file content", complete: true };
    if (att.content.length > EMAIL_LIMITS.maxAttachmentBytes)
        return {
            ok: false,
            reason: `larger than ${formatBytes(EMAIL_LIMITS.maxAttachmentBytes)}`,
            complete: true,
        };
    const content = att.content;
    const kind = deps.kindOf({ ...att, content });
    if (!kind) return { ok: false, reason: "unsupported type", complete: true };
    try {
        if (isEmailKind(kind)) {
            const nested = await parseEmail(kind, content);
            return {
                ok: true,
                segments: [{ label: name, text: nestedEmailText(nested) }],
                complete: true,
            };
        }
        const { text, complete } = await deps.extract(kind, content);
        if (!text.trim())
            return {
                ok: false,
                reason: complete ? "no text found" : "could not be read",
                complete,
            };
        const segments =
            kind === "pdf"
                ? splitPages(text)
                      .filter((p) => p.text.trim())
                      .map((p) => ({
                          label: p.page === null ? name : `${name}, page ${p.page}`,
                          text: p.text.trim(),
                      }))
                : [{ label: name, text: text.trim() }];
        return { ok: true, segments, complete };
    } catch (err) {
        console.warn(
            `[emailText] attachment kind=${kind} not read: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, reason: "could not be read", complete: true };
    }
}

/**
 * The e-mail as paged document text (`[Page N]` markers, the plain
 * flavour). `complete` is false when an attachment's text is a fallback
 * that a later read could improve, so the caller must not cache it.
 */
export async function renderEmailText(
    email: ParsedEmail,
    deps: EmailTextDeps,
): Promise<{ text: string; complete: boolean }> {
    const listed = email.attachments.filter((a) => !a.inlineImage);
    const inline = email.attachments.length - listed.length;
    const toRead = listed.slice(0, EMAIL_LIMITS.maxAttachmentsRead);

    const results: AttachmentResult[] = new Array(toRead.length);
    await mapWithConcurrency(
        toRead.map((att, i) => ({ att, i })),
        EMAIL_LIMITS.readConcurrency,
        async ({ att, i }) => {
            results[i] = await readAttachment(att, deps);
        },
    );

    let complete = true;
    let budget: number = EMAIL_LIMITS.maxAttachmentChars;
    let page = 1;
    const listLines: string[] = [];
    const pages: string[] = [];
    listed.forEach((att, i) => {
        const head = `${i + 1}. ${describe(att)}`;
        const r = results[i];
        if (!r) {
            listLines.push(
                `${head} — not extracted: more than ${EMAIL_LIMITS.maxAttachmentsRead} attachments`,
            );
            return;
        }
        complete &&= r.complete;
        if (!r.ok) {
            listLines.push(`${head} — not extracted: ${r.reason}`);
            return;
        }
        if (budget <= 0) {
            listLines.push(`${head} — not extracted: the e-mail's text limit was reached`);
            return;
        }
        const first = page + 1;
        let cut = false;
        for (const seg of r.segments) {
            if (budget <= 0) {
                cut = true;
                break;
            }
            let text = seg.text;
            if (text.length > budget) {
                text = `${text.slice(0, budget)}\n[… text cut: the e-mail's text limit was reached]`;
                cut = true;
            }
            budget -= seg.text.length;
            page += 1;
            pages.push(`[Page ${page}] Attachment ${i + 1}: ${seg.label}\n${text}`);
        }
        const where = page === first ? `page ${first}` : `pages ${first}–${page}`;
        listLines.push(`${head} — ${where}${cut ? " (cut at the text limit)" : ""}`);
    });

    const lines = headerBlock(email);
    if (listLines.length) lines.push("Attachments:", ...listLines);
    if (inline) lines.push(`Inline images: ${inline} (not extracted)`);
    const first = `[Page 1]\n${lines.join("\n")}\n\n${bodyText(email)}`;
    return { text: [first, ...pages].join("\n\n"), complete };
}
