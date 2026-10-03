import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { burn, type Entry } from "@kenjiuno/msgreader/lib/Burner";
import { TypeEnum } from "@kenjiuno/msgreader/lib/Reader";
import {
    EMAIL_LIMITS,
    codepageLabel,
    emailDate,
    htmlToPlainText,
    looksLikeRfc822,
    parseEmail,
    renderEmailText,
    type EmailTextDeps,
    type ParsedEmail,
} from "./emailText.js";
import {
    _resetDocumentTextForTesting,
    _setDocumentTextDepsForTesting,
    emailAttachmentKind,
    emailTextCachePath,
    extractDocumentText,
    resolveDocumentKind,
    sniffDocument,
    splitTextIntoParts,
} from "./documentText.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRLF = "\r\n";

/** č ć đ š ž Č Ć Đ Š Ž — in Windows-1250; everything else must be ASCII. */
function cp1250(text: string): Buffer {
    const map: Record<string, number> = {
        č: 0xe8, ć: 0xe6, đ: 0xf0, š: 0x9a, ž: 0x9e,
        Č: 0xc8, Ć: 0xc6, Đ: 0xd0, Š: 0x8a, Ž: 0x8e, "—": 0x97,
    };
    return Buffer.from(
        [...text].map((ch) => {
            if (map[ch] !== undefined) return map[ch];
            const code = ch.charCodeAt(0);
            assert.ok(code < 0x80, `not ASCII: ${ch}`);
            return code;
        }),
    );
}

/** Quoted-printable for test bodies (every non-ASCII byte escaped). */
function qp(bytes: Buffer): string {
    return [...bytes]
        .map((b) =>
            b >= 0x20 && b < 0x7f && b !== 0x3d
                ? String.fromCharCode(b)
                : `=${b.toString(16).toUpperCase().padStart(2, "0")}`,
        )
        .join("");
}

function b64(bytes: Buffer): string {
    return bytes.toString("base64").replace(/.{76}/g, `$&${CRLF}`);
}

interface Part {
    headers: string[];
    body: string;
}

function attachmentPart(filename: string, type: string, bytes: Buffer, disposition = "attachment"): Part {
    return {
        headers: [
            `Content-Type: ${type}; name="${filename}"`,
            `Content-Disposition: ${disposition}; filename="${filename}"`,
            "Content-Transfer-Encoding: base64",
        ],
        body: b64(bytes),
    };
}

/** An RFC 822 message; every byte of `parts` must already be 7/8-bit. */
function eml(opts: {
    headers?: string[];
    parts: Part[];
    boundary?: string;
}): Buffer {
    const boundary = opts.boundary ?? "BOUNDARY";
    const headers = opts.headers ?? [
        "Received: from mx.example.hr by mail.example.hr; Tue, 29 Sep 2026 14:05:03 +0200",
        "From: =?UTF-8?Q?Ivana_Horvat?= <ivana@example.hr>",
        "To: =?UTF-8?Q?Marko_Kova=C4=8Di=C4=87?= <marko@example.hr>, ured@example.hr",
        "Cc: Petra <petra@example.hr>",
        "Subject: =?UTF-8?Q?Ugovor_o_zakupu_=E2=80=94_=C4=8Dlanak_5.?=",
        "Date: Tue, 29 Sep 2026 14:05:00 +0200",
        "Message-ID: <m1@example.hr>",
        "In-Reply-To: <m0@example.hr>",
        "MIME-Version: 1.0",
    ];
    if (opts.parts.length === 1) {
        const [p] = opts.parts;
        return Buffer.from([...headers, ...p.headers, "", p.body, ""].join(CRLF), "latin1");
    }
    const lines = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, ""];
    for (const p of opts.parts) lines.push(`--${boundary}`, ...p.headers, "", p.body);
    lines.push(`--${boundary}--`, "");
    return Buffer.from(lines.join(CRLF), "latin1");
}

const UTF8_QP_BODY: Part = {
    headers: ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable"],
    body: qp(Buffer.from("Poštovani, šaljem ugovor. Rok je 8 dana od primitka — čćđšž ČĆĐŠŽ.", "utf8")),
};

/** A PDF whose page text layers say "Hello PDF" (as in documentText.test). */
function minimalPdf(pages = 1): Buffer {
    const stream = "BT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET";
    const pageIds = Array.from({ length: pages }, (_, i) => 10 + i);
    return Buffer.from(
        [
            "%PDF-1.4",
            "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
            `2 0 obj << /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >> endobj`,
            ...pageIds.map(
                (id) =>
                    `${id} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj`,
            ),
            `4 0 obj << /Length ${stream.length} >> stream`,
            stream,
            "endstream endobj",
            "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
            "trailer << /Root 1 0 R >>",
            "%%EOF",
        ].join("\n"),
        "latin1",
    );
}

async function minimalDocx(text: string): Promise<Buffer> {
    const { Document, Packer, Paragraph } = await import("docx");
    return Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text })] }] }));
}

// --- Outlook .msg, burned with msgreader's own CFB writer --------------------

interface CfbNode {
    name: string;
    data?: Buffer;
    children?: CfbNode[];
}

function cfb(children: CfbNode[]): Buffer {
    const entries: Entry[] = [{ name: "Root Entry", type: TypeEnum.ROOT, children: [], length: 0 }];
    const add = (parent: number, node: CfbNode) => {
        const index = entries.length;
        entries[parent].children!.push(index);
        if (node.children) {
            entries.push({ name: node.name, type: TypeEnum.DIRECTORY, children: [], length: 0 });
            for (const child of node.children) add(index, child);
        } else {
            const data = node.data ?? Buffer.alloc(0);
            // The burner copies from `.buffer` at offset 0, so hand it an
            // unpooled copy.
            entries.push({ name: node.name, type: TypeEnum.DOCUMENT, binaryProvider: () => new Uint8Array(data), length: data.length });
        }
    };
    for (const child of children) add(0, child);
    return Buffer.from(burn(entries));
}

const unicode = (s: string) => Buffer.from(s, "utf16le");

/** [MS-OXMSG] property stream: a header, then 16-byte fixed-size entries. */
function propertyStream(headerBytes: number, props: { tag: number; value: Buffer }[]): Buffer {
    const out = Buffer.alloc(headerBytes + props.length * 16);
    props.forEach((p, i) => {
        const at = headerBytes + i * 16;
        out.writeUInt32LE(p.tag >>> 0, at);
        out.writeUInt32LE(0x6, at + 4);
        p.value.copy(out, at + 8);
    });
    return out;
}

function u32(n: number): Buffer {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(n, 0);
    return b;
}

function filetime(iso: string): Buffer {
    const ticks = (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n;
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(ticks);
    return b;
}

function substg(tag: string, data: Buffer): CfbNode {
    return { name: `__substg1.0_${tag}`, data };
}

function msgFixture(opts: { ansi?: boolean } = {}): Buffer {
    const str = (tagPrefix: string, s: string) =>
        opts.ansi ? substg(`${tagPrefix}001E`, cp1250(s)) : substg(`${tagPrefix}001F`, unicode(s));
    const transportHeaders = [
        "Received: from mx.example.hr by mail.example.hr; Wed, 30 Sep 2026 09:15:42 +0200",
        "Date: Wed, 30 Sep 2026 09:15:00 +0200",
        "Message-ID: <outlook-1@example.hr>",
        "",
    ].join(CRLF);
    const recipient = (i: number, name: string, smtp: string, type: number): CfbNode => ({
        name: `__recip_version1.0_#0000000${i}`,
        children: [
            str("3001", name),
            substg("39FE001F", unicode(smtp)),
            { name: "__properties_version1.0", data: propertyStream(8, [{ tag: 0x0c150003, value: u32(type) }]) },
        ],
    });
    const innerMessage: CfbNode = {
        name: "__substg1.0_3701000D",
        children: [
            substg("0037001F", unicode("Prosljeđena poruka")),
            substg("0C1A001F", unicode("Ana Anić")),
            substg("5D01001F", unicode("ana@example.hr")),
            substg("1000001F", unicode("Unutarnji tekst: žaba.")),
            { name: "__properties_version1.0", data: Buffer.alloc(24) },
        ],
    };
    return cfb([
        str("0037", "Ponuda — čćđšž"),
        str("0C1A", "Željko Šimić"),
        substg("5D01001F", unicode("zeljko@example.hr")),
        str("1000", "Poštovani,\r\n\r\nu privitku je ponuda. Đurđevac, čćđšž.\r\n"),
        substg("1035001F", unicode("<outlook-1@example.hr>")),
        substg("1042001F", unicode("<outlook-0@example.hr>")),
        substg("007D001F", unicode(transportHeaders)),
        {
            name: "__properties_version1.0",
            data: propertyStream(32, [
                { tag: 0x00390040, value: filetime("2026-09-30T07:15:00Z") },
                { tag: 0x0e060040, value: filetime("2026-09-30T07:15:42Z") },
                ...(opts.ansi ? [{ tag: 0x3ffd0003, value: u32(1250) }] : []),
            ]),
        },
        recipient(0, "Marko Kovačić", "marko@example.hr", 1),
        recipient(1, "Petra Perić", "petra@example.hr", 2),
        {
            name: "__attach_version1.0_#00000000",
            children: [
                substg("3707001F", unicode("napomena.txt")),
                substg("370E001F", unicode("text/plain")),
                substg("37010102", Buffer.from("Napomena: rok je 15 dana. Đurđa", "utf8")),
                { name: "__properties_version1.0", data: propertyStream(8, []) },
            ],
        },
        {
            name: "__attach_version1.0_#00000001",
            children: [
                substg("3001001F", unicode("Prosljeđena poruka")),
                innerMessage,
                { name: "__properties_version1.0", data: propertyStream(8, []) },
            ],
        },
    ]);
}

afterEach(() => _resetDocumentTextForTesting());

/** No OCR and no cache unless a test asks for them. */
function stubDeps(opts: { ocr?: string; cached?: string | null } = {}) {
    const calls = { ocr: 0, reads: [] as string[], writes: [] as [string, string][] };
    _setDocumentTextDepsForTesting({
        ocrPdf: async () => {
            calls.ocr++;
            return opts.ocr ?? "";
        },
        readCache: async (key) => {
            calls.reads.push(key);
            return opts.cached ?? null;
        },
        writeCache: async (key, text) => {
            calls.writes.push([key, text]);
        },
    });
    return calls;
}

// ---------------------------------------------------------------------------
// .eml
// ---------------------------------------------------------------------------

describe("e-mail text — .eml", () => {
    it("writes the header block, normalised dates and a UTF-8 quoted-printable body with diacritics", async () => {
        stubDeps();
        const text = await extractDocumentText({ fileType: "eml", bytes: eml({ parts: [UTF8_QP_BODY] }), flavor: "plain" });
        assert.equal(
            text,
            [
                "[Page 1]",
                "From: Ivana Horvat <ivana@example.hr>",
                "To: Marko Kovačić <marko@example.hr>, ured@example.hr",
                "Cc: Petra <petra@example.hr>",
                "Date: Tue, 29 Sep 2026 14:05:00 +0200 (2026-09-29T14:05:00+02:00)",
                "Received: Tue, 29 Sep 2026 14:05:03 +0200 (2026-09-29T14:05:03+02:00)",
                "Subject: Ugovor o zakupu — članak 5.",
                "Message-ID: <m1@example.hr>",
                "In-Reply-To: <m0@example.hr>",
                "",
                "Poštovani, šaljem ugovor. Rok je 8 dana od primitka — čćđšž ČĆĐŠŽ.",
            ].join("\n"),
        );
    });

    it("decodes a Windows-1250 body and subject (quoted-printable and 8-bit)", async () => {
        stubDeps();
        const body = cp1250("Članak 5. — rok od 8 dana; Đurđa Šimić, Žminj, čćđšž");
        for (const encoded of [
            { cte: "quoted-printable", body: qp(body) },
            { cte: "8bit", body: body.toString("latin1") },
        ]) {
            const bytes = eml({
                headers: [
                    "From: ured@example.hr",
                    "To: klijent@example.hr",
                    `Subject: =?windows-1250?Q?${qp(cp1250("Očitovanje na tužbu")).replace(/ /g, "_")}?=`,
                    "Date: Thu, 1 Oct 2026 08:00:00 +0200",
                    "MIME-Version: 1.0",
                ],
                parts: [{ headers: ["Content-Type: text/plain; charset=windows-1250", `Content-Transfer-Encoding: ${encoded.cte}`], body: encoded.body }],
            });
            const text = await extractDocumentText({ fileType: "eml", bytes, flavor: "plain" });
            assert.match(text, /^Subject: Očitovanje na tužbu$/m, encoded.cte);
            assert.match(text, /Članak 5\. — rok od 8 dana; Đurđa Šimić, Žminj, čćđšž/, encoded.cte);
        }
    });

    it("converts an HTML-only body to text without scripts, styles or image URLs", async () => {
        stubDeps();
        const html =
            '<html><head><style>p{color:red}</style><script>alert("x")</script></head><body>' +
            "<p>Poštovani,</p><p>vidi <a href=\"https://example.hr/ugovor\">ugovor</a> i čl. 5.</p>" +
            '<img src="https://tracker.example/pixel.gif"><img src="cid:logo1">' +
            "<table><tr><th>Stavka</th><th>Iznos</th></tr><tr><td>Najam</td><td>1.250,00 EUR</td></tr></table></body></html>";
        const text = await extractDocumentText({
            fileType: "eml",
            bytes: eml({ parts: [{ headers: ["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64"], body: b64(Buffer.from(html, "utf8")) }] }),
            flavor: "plain",
        });
        const body = text.split("\n\n").slice(1).join("\n\n");
        assert.match(body, /^Poštovani,/);
        assert.match(body, /vidi ugovor \[https:\/\/example\.hr\/ugovor\] i čl\. 5\./);
        assert.match(body, /Najam\s+1\.250,00 EUR/);
        assert.doesNotMatch(body, /alert|color:red|tracker|pixel|cid:/);
    });

    it("prefers text/plain over HTML in multipart/alternative", async () => {
        stubDeps();
        const bytes = eml({
            parts: [
                {
                    headers: ['Content-Type: multipart/alternative; boundary="ALT"'],
                    body: [
                        "--ALT",
                        "Content-Type: text/plain; charset=utf-8",
                        "Content-Transfer-Encoding: quoted-printable",
                        "",
                        qp(Buffer.from("Obična verzija.", "utf8")),
                        "--ALT",
                        "Content-Type: text/html; charset=utf-8",
                        "",
                        "<p>HTML verzija.</p>",
                        "--ALT--",
                    ].join(CRLF),
                },
                attachmentPart("prazno.txt", "text/plain", Buffer.from(" ")),
            ],
        });
        const text = await extractDocumentText({ fileType: "eml", bytes, flavor: "plain" });
        assert.match(text, /Obična verzija\./);
        assert.doesNotMatch(text, /HTML verzija/);
    });

    it("appends supported attachments as further pages and lists the rest", async () => {
        stubDeps({ ocr: "[Page 1]\nČlanak 1. Predmet ugovora\n\n[Page 2]\nČlanak 2. Zakupnina" });
        const bytes = eml({
            parts: [
                UTF8_QP_BODY,
                attachmentPart("ugovor.pdf", "application/pdf", minimalPdf(2)),
                attachmentPart("napomena.txt", "text/plain", Buffer.from("Napomena: rok je 15 dana. Đurđa", "utf8")),
                attachmentPart("aneks.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await minimalDocx("Aneks ugovora — članak 3.")),
                attachmentPart("slika.png", "image/png", Buffer.from("\x89PNG\r\n", "latin1")),
                attachmentPart("logo.png", "image/png", Buffer.from("\x89PNG\r\n", "latin1"), "inline"),
                attachmentPart("winmail.dat", "application/ms-tnef", Buffer.from("x\x9f>\x12", "latin1")),
            ],
        });
        const text = await extractDocumentText({ fileType: "eml", bytes, flavor: "plain" });
        const header = text.split("\n\n")[0];
        assert.match(header, /^Attachments:$/m);
        assert.match(header, /^1\. ugovor\.pdf \(application\/pdf, [\d.]+ K?B\) — pages 2–3$/m);
        assert.match(header, /^2\. napomena\.txt \(text\/plain, 33 B\) — page 4$/m);
        assert.match(header, /^3\. aneks\.docx \(.*\) — page 5$/m);
        assert.match(header, /^4\. slika\.png \(image\/png, 6 B\) — not extracted: unsupported type$/m);
        assert.match(header, /^5\. winmail\.dat \(application\/ms-tnef, 4 B\) — not extracted: unsupported type$/m);
        assert.match(header, /^Inline images: 1 \(not extracted\)$/m);
        assert.doesNotMatch(header, /logo\.png/);
        assert.match(text, /\n\n\[Page 2\] Attachment 1: ugovor\.pdf, page 1\nČlanak 1\. Predmet ugovora\n\n\[Page 3\] Attachment 1: ugovor\.pdf, page 2\nČlanak 2\. Zakupnina/);
        assert.match(text, /\n\n\[Page 4\] Attachment 2: napomena\.txt\nNapomena: rok je 15 dana\. Đurđa/);
        assert.match(text, /\n\n\[Page 5\] Attachment 3: aneks\.docx\nAneks ugovora — članak 3\.$/);
    });

    it("shows an attached e-mail with its headers and body, and only lists its attachments (depth 1)", async () => {
        stubDeps();
        const inner = eml({
            headers: [
                "From: Ana <ana@example.hr>",
                "To: Ivana <ivana@example.hr>",
                "Subject: =?UTF-8?Q?Proslje=C4=91ena_ponuda?=",
                "Date: Mon, 28 Sep 2026 09:00:00 +0200",
                "Message-ID: <inner@example.hr>",
                "MIME-Version: 1.0",
            ],
            parts: [
                { headers: ["Content-Type: text/plain; charset=utf-8"], body: "Unutarnji tekst" },
                attachmentPart("unutarnji.txt", "text/plain", Buffer.from("ne smije se čitati")),
            ],
            boundary: "INNER",
        });
        const bytes = eml({
            parts: [
                UTF8_QP_BODY,
                { headers: ['Content-Type: message/rfc822; name="FW_ponuda.eml"', 'Content-Disposition: attachment; filename="FW_ponuda.eml"'], body: inner.toString("latin1") },
            ],
        });
        const text = await extractDocumentText({ fileType: "eml", bytes, flavor: "plain" });
        assert.match(text, /^1\. FW_ponuda\.eml \(message\/rfc822, .*\) — page 2$/m);
        assert.match(text, /\[Page 2\] Attachment 1: FW_ponuda\.eml\nFrom: Ana <ana@example\.hr>\n/);
        assert.match(text, /^Date: Mon, 28 Sep 2026 09:00:00 \+0200 \(2026-09-28T09:00:00\+02:00\)$/m);
        assert.match(text, /^Subject: Prosljeđena ponuda$/m);
        assert.match(text, /^1\. unutarnji\.txt \(text\/plain, .*\) — not extracted: attachment of an attached e-mail$/m);
        assert.match(text, /Unutarnji tekst/);
        assert.doesNotMatch(text, /ne smije se čitati/);
    });

    it("gives the tabular (markdown) flavour ## Page headings", async () => {
        stubDeps();
        const bytes = eml({ parts: [UTF8_QP_BODY, attachmentPart("n.txt", "text/plain", Buffer.from("Prilog"))] });
        const md = await extractDocumentText({ fileType: "eml", bytes, flavor: "markdown" });
        assert.match(md, /^## Page 1\nFrom: /);
        assert.match(md, /\n\n## Page 2 Attachment 1: n\.txt\nPrilog$/);
    });

    it("splits long e-mail text into parts at attachment pages", async () => {
        stubDeps();
        const bytes = eml({
            parts: [
                UTF8_QP_BODY,
                attachmentPart("a.txt", "text/plain", Buffer.from("A".repeat(2000))),
                attachmentPart("b.txt", "text/plain", Buffer.from("B".repeat(2000))),
            ],
        });
        const text = await extractDocumentText({ fileType: "eml", bytes, flavor: "plain" });
        const parts = splitTextIntoParts(text, 2100);
        assert.equal(parts.length, 3);
        assert.match(parts[0], /^\[Page 1\]/);
        assert.match(parts[1], /^\[Page 2\] Attachment 1: a\.txt/);
        assert.match(parts[2], /^\[Page 3\] Attachment 2: b\.txt/);
    });

    it("throws for bytes with neither headers nor content", async () => {
        stubDeps();
        await assert.rejects(
            extractDocumentText({ fileType: "eml", bytes: Buffer.alloc(0), flavor: "plain" }),
            /Unreadable e-mail/,
        );
    });
});

// ---------------------------------------------------------------------------
// .msg
// ---------------------------------------------------------------------------

describe("e-mail text — Outlook .msg", () => {
    it("is sniffed from its OLE streams, also under a wrong extension", () => {
        const msg = msgFixture();
        assert.equal(sniffDocument(msg), "msg");
        assert.equal(resolveDocumentKind("msg", msg), "msg");
        assert.equal(resolveDocumentKind("eml", msg), "msg");
        assert.equal(resolveDocumentKind("doc", msg), "msg");
        assert.equal(resolveDocumentKind(null, msg), "msg");
        assert.equal(resolveDocumentKind("msg", eml({ parts: [UTF8_QP_BODY] })), "eml");
    });

    it("maps sender, recipients, dates, ids, body and attachments", async () => {
        stubDeps();
        const text = await extractDocumentText({ fileType: "msg", bytes: msgFixture(), flavor: "plain" });
        assert.equal(
            text.split("\n\n")[0],
            [
                "[Page 1]",
                "From: Željko Šimić <zeljko@example.hr>",
                "To: Marko Kovačić <marko@example.hr>",
                "Cc: Petra Perić <petra@example.hr>",
                "Date: Wed, 30 Sep 2026 09:15:00 +0200 (2026-09-30T09:15:00+02:00)",
                "Received: Wed, 30 Sep 2026 09:15:42 +0200 (2026-09-30T09:15:42+02:00)",
                "Subject: Ponuda — čćđšž",
                "Message-ID: <outlook-1@example.hr>",
                "In-Reply-To: <outlook-0@example.hr>",
                "Attachments:",
                "1. napomena.txt (text/plain, 33 B) — page 2",
                "2. Prosljeđena poruka.msg (application/vnd.ms-outlook) — page 3",
            ].join("\n"),
        );
        // Outlook's CRLF body ends up with \n line ends.
        assert.match(text, /\n\nPoštovani,\n\nu privitku je ponuda\. Đurđevac, čćđšž\.\n\n\[Page 2\]/);
        assert.doesNotMatch(text, /\r/);
        assert.match(text, /\[Page 2\] Attachment 1: napomena\.txt\nNapomena: rok je 15 dana\. Đurđa/);
        assert.match(text, /\[Page 3\] Attachment 2: Prosljeđena poruka\.msg\nFrom: Ana Anić <ana@example\.hr>\nSubject: Prosljeđena poruka\n\nUnutarnji tekst: žaba\.$/);
    });

    it("decodes a non-Unicode .msg in its code page (Windows-1250)", async () => {
        stubDeps();
        const text = await extractDocumentText({ fileType: "msg", bytes: msgFixture({ ansi: true }), flavor: "plain" });
        assert.match(text, /^From: Željko Šimić <zeljko@example\.hr>$/m);
        assert.match(text, /^To: Marko Kovačić <marko@example\.hr>$/m);
        assert.match(text, /^Subject: Ponuda — čćđšž$/m);
        assert.match(text, /Poštovani,\n\nu privitku je ponuda\. Đurđevac, čćđšž\./);
    });

    it("uses the client submit time when there are no transport headers", async () => {
        stubDeps();
        const email = await parseEmail("msg", cfb([
            substg("0037001F", unicode("Nacrt")),
            {
                name: "__properties_version1.0",
                data: propertyStream(32, [{ tag: 0x00390040, value: filetime("2026-09-30T07:15:00Z") }]),
            },
        ]));
        assert.deepEqual(email.date, { raw: "Wed, 30 Sep 2026 07:15:00 GMT", iso: "2026-09-30T07:15:00+00:00" });
        assert.equal(email.received, null);
        assert.equal(email.body, "");
    });

    it("throws for an OLE file that is not a message", async () => {
        stubDeps();
        await assert.rejects(
            extractDocumentText({ fileType: "msg", bytes: Buffer.from("plain text, not OLE"), flavor: "plain" }),
            /Unreadable Outlook message/,
        );
    });
});

// ---------------------------------------------------------------------------
// Cache, limits, helpers
// ---------------------------------------------------------------------------

describe("e-mail text — cache and limits", () => {
    const storagePath = "documents/u1/d1/poruka.eml";

    it("persists the text next to the version and serves it without parsing again", async () => {
        const calls = stubDeps({ ocr: "[Page 1]\nOCR tekst" });
        const bytes = eml({ parts: [UTF8_QP_BODY, attachmentPart("u.pdf", "application/pdf", minimalPdf())] });
        const text = await extractDocumentText({ fileType: "eml", bytes, flavor: "plain", storagePath });
        assert.equal(calls.ocr, 1);
        assert.deepEqual(calls.writes, [[`${storagePath}.email-v1.txt`, text]]);
        assert.equal(emailTextCachePath(storagePath), `${storagePath}.email-v1.txt`);

        const cached = stubDeps({ cached: "[Page 1]\nIz cachea\n\n[Page 2] Attachment 1: u.pdf, page 1\nOCR" });
        const md = await extractDocumentText({ fileType: "eml", bytes: Buffer.from("ignored"), flavor: "markdown", storagePath });
        assert.equal(md, "## Page 1\nIz cachea\n\n## Page 2 Attachment 1: u.pdf, page 1\nOCR");
        assert.equal(cached.ocr, 0);
        assert.equal(cached.writes.length, 0);
    });

    it("does not cache a text whose PDF attachment fell back to the text layer", async () => {
        const calls = stubDeps({ ocr: "" });
        const bytes = eml({ parts: [UTF8_QP_BODY, attachmentPart("u.pdf", "application/pdf", minimalPdf())] });
        const text = await extractDocumentText({ fileType: "eml", bytes, flavor: "plain", storagePath });
        assert.match(text, /\[Page 2\] Attachment 1: u\.pdf, page 1\n.*Hello PDF/);
        assert.equal(calls.writes.length, 0);
    });

    const plainEmail = (attachments: ParsedEmail["attachments"]): ParsedEmail => ({
        from: "a@example.hr", to: "", cc: "", bcc: "", date: null, received: null,
        subject: "Test", messageId: "", inReplyTo: "", body: "Tijelo", bodyNote: null, attachments,
    });
    const att = (filename: string, content: Buffer | null) => ({
        filename, contentType: "text/plain", size: content?.length ?? 0, content, inlineImage: false, nested: null,
    });
    const echoDeps: EmailTextDeps = {
        kindOf: () => "txt",
        extract: async (_kind, bytes) => ({ text: bytes.toString("utf8"), complete: true }),
    };

    it("lists an attachment above the size limit without reading it", async () => {
        let reads = 0;
        const { text } = await renderEmailText(
            plainEmail([att("veliki.txt", Buffer.alloc(EMAIL_LIMITS.maxAttachmentBytes + 1, 0x41))]),
            { ...echoDeps, extract: async () => { reads++; return { text: "x", complete: true }; } },
        );
        assert.equal(reads, 0);
        assert.match(text, /^1\. veliki\.txt \(text\/plain, 25\.0 MB\) — not extracted: larger than 25\.0 MB$/m);
    });

    it("cuts attachment text at the e-mail's text limit and lists the rest", async () => {
        const big = "Ž".repeat(EMAIL_LIMITS.maxAttachmentChars - 10);
        const { text } = await renderEmailText(
            plainEmail([att("a.txt", Buffer.from(big)), att("b.txt", Buffer.from("0123456789ABCDEFGHIJ")), att("c.txt", Buffer.from("c"))]),
            echoDeps,
        );
        assert.match(text, /^1\. a\.txt .* — page 2$/m);
        assert.match(text, /^2\. b\.txt .* — page 3 \(cut at the text limit\)$/m);
        assert.match(text, /^3\. c\.txt .* — not extracted: the e-mail's text limit was reached$/m);
        assert.match(text, /\[Page 3\] Attachment 2: b\.txt\n0123456789\n\[… text cut: the e-mail's text limit was reached\]$/);
    });

    it("never lets a file name break the page structure", async () => {
        const { text } = await renderEmailText(plainEmail([att("x\n[Page 9]\r\nevil.txt", Buffer.from("ok"))]), echoDeps);
        assert.match(text, /\[Page 2\] Attachment 1: x \[Page 9\] evil\.txt\nok$/);
        assert.equal(text.match(/^\[Page \d+\]/gm)?.length, 2);
    });
});

describe("e-mail helpers", () => {
    it("normalises header dates to ISO 8601 with the offset they were written in", () => {
        assert.deepEqual(emailDate("Tue, 29 Sep 2026 14:05:00 +0200"), {
            raw: "Tue, 29 Sep 2026 14:05:00 +0200",
            iso: "2026-09-29T14:05:00+02:00",
        });
        assert.equal(emailDate("Tue, 29 Sep 2026 14:05:00 +0200 (CEST)")?.iso, "2026-09-29T14:05:00+02:00");
        assert.equal(emailDate("29 Sep 2026 23:30 -0530")?.iso, "2026-09-29T23:30:00-05:30");
        assert.equal(emailDate("Tue, 29 Sep 2026 12:05:00 GMT")?.iso, "2026-09-29T12:05:00+00:00");
        assert.equal(emailDate("Tue, 29 Sep 2026 08:05:00 EDT")?.iso, "2026-09-29T08:05:00-04:00");
        assert.deepEqual(emailDate("sutra ujutro"), { raw: "sutra ujutro", iso: null });
        assert.equal(emailDate("sutra ujutro", new Date("2026-09-29T12:00:00Z"))?.iso, "2026-09-29T12:00:00+00:00");
        assert.equal(emailDate(""), null);
    });

    it("recognises RFC 822 headers and nothing else", () => {
        assert.ok(looksLikeRfc822(Buffer.from("From: a@b.hr\r\nSubject: x\r\n\r\nTijelo")));
        assert.ok(looksLikeRfc822(Buffer.from("From MAILER-DAEMON Tue Sep 29 2026\nReceived: from x\n\tby y\nDate: Tue, 29 Sep 2026 14:05:00 +0200\n\nb")));
        assert.ok(!looksLikeRfc822(Buffer.from("Ugovor o zakupu\nČlanak 1.")));
        assert.ok(!looksLikeRfc822(Buffer.from("Subject: samo jedno zaglavlje\n\ntekst")));
        assert.ok(!looksLikeRfc822(Buffer.from("ime;prezime\nAna;Anić")));
        assert.ok(!looksLikeRfc822(Buffer.from("From: a@b.hr\nnije zaglavlje\nSubject: x\n")));
        assert.equal(sniffDocument(Buffer.from("From: a@b.hr\r\nTo: c@d.hr\r\n\r\nx")), "eml");
        // A .txt stays a .txt whatever it holds.
        assert.equal(resolveDocumentKind("txt", Buffer.from("From: a@b.hr\r\nTo: c@d.hr\r\n\r\nx")), "txt");
    });

    it("classifies attachments by extension, then MIME type, then content", async () => {
        const kind = (filename: string, contentType: string | null, content: Buffer) =>
            emailAttachmentKind({ filename, contentType, content });
        assert.equal(kind("Ugovor.PDF", null, minimalPdf()), "pdf");
        assert.equal(kind("biljeske.md", "text/markdown", Buffer.from("# x")), "txt");
        assert.equal(kind("", "application/pdf", minimalPdf()), "pdf");
        assert.equal(kind("", "message/rfc822", Buffer.from("From: a@b.hr\r\nTo: c@d.hr\r\n\r\nx")), "eml");
        assert.equal(kind("prilog.bin", "application/octet-stream", minimalPdf()), "pdf");
        assert.equal(kind("preimenovan.doc", null, await minimalDocx("x")), "docx");
        assert.equal(kind("slika.png", "image/png", Buffer.from("\x89PNG", "latin1")), null);
        assert.equal(kind("arhiva.zip", "application/zip", Buffer.from("PK\x03\x04", "latin1")), null);
    });

    it("maps Windows code pages to decoder labels", () => {
        assert.equal(codepageLabel(1250), "windows-1250");
        assert.equal(codepageLabel(65001), "utf-8");
        assert.equal(codepageLabel(28592), "iso-8859-2");
        assert.equal(codepageLabel(undefined), null);
        assert.equal(codepageLabel(12345), null);
    });

    it("keeps link targets and drops the markup", () => {
        assert.equal(
            htmlToPlainText('<p>Vidi <a href="https://a.hr/x">ovdje</a> i <a href="https://a.hr">https://a.hr</a>.</p>'),
            "Vidi ovdje [https://a.hr/x] i https://a.hr.",
        );
    });
});
