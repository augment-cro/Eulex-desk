import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    SUPPORTED_UPLOAD_TYPES,
    UnsupportedFileTypeError,
    assertSupportedUploadType,
    canonicalUploadType,
    contentTypeForUpload,
    fileExtension,
    isEmailType,
    isSpreadsheetType,
    isSupportedUploadType,
} from "./fileTypes.js";

describe("fileTypes", () => {
    it("reads the lower-cased extension", () => {
        assert.equal(fileExtension("Ugovor.DOCX"), "docx");
        assert.equal(fileExtension("a.b.pdf"), "pdf");
        assert.equal(fileExtension("README"), "");
    });

    it("supports pdf, docx, doc, txt, the spreadsheets xlsx, xlsm, xls, csv and the e-mails eml, msg", () => {
        assert.deepEqual([...SUPPORTED_UPLOAD_TYPES], [
            "pdf", "docx", "doc", "txt", "xlsx", "xlsm", "xls", "csv", "eml", "msg",
        ]);
        assert.ok(isSupportedUploadType("txt"));
        assert.ok(isSupportedUploadType("xlsx"));
        assert.ok(isSupportedUploadType("eml"));
        assert.ok(isSupportedUploadType("msg"));
        assert.ok(!isSupportedUploadType("pptx"));
    });

    it("knows which types are e-mails", () => {
        for (const t of ["eml", "msg"]) assert.ok(isEmailType(t), t);
        for (const t of ["pdf", "txt", "csv", "", null, undefined]) assert.ok(!isEmailType(t));
    });

    it("knows which types are spreadsheets", () => {
        for (const t of ["xlsx", "xlsm", "xls", "csv"]) assert.ok(isSpreadsheetType(t), t);
        for (const t of ["pdf", "docx", "txt", "", null, undefined]) assert.ok(!isSpreadsheetType(t));
    });

    it("stores each type under its own content type", () => {
        assert.equal(contentTypeForUpload("doc"), "application/msword");
        assert.equal(contentTypeForUpload("txt"), "text/plain; charset=utf-8");
        assert.equal(
            contentTypeForUpload("xlsx"),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        assert.equal(contentTypeForUpload("xlsm"), "application/vnd.ms-excel.sheet.macroEnabled.12");
        assert.equal(contentTypeForUpload("xls"), "application/vnd.ms-excel");
        assert.equal(contentTypeForUpload("csv"), "text/csv; charset=utf-8");
        assert.equal(contentTypeForUpload("eml"), "message/rfc822");
        assert.equal(contentTypeForUpload("msg"), "application/vnd.ms-outlook");
    });

    it("accepts a supported upload and returns its type", () => {
        assert.equal(assertSupportedUploadType("Tužba.pdf", "test"), "pdf");
    });

    it("accepts an Outlook message and an .eml (#46 phase 2)", () => {
        assert.equal(assertSupportedUploadType("RE_ Ugovor (3).msg", "project"), "msg");
        assert.equal(assertSupportedUploadType("Ponuda.EML", "standalone"), "eml");
    });

    it("accepts a spreadsheet (Google Sheets connector exports land here, #47)", () => {
        assert.equal(assertSupportedUploadType("Registar ugovora.xlsx", "connector:google_drive"), "xlsx");
    });

    it("rejects an unsupported upload with a structured, bounded error", () => {
        assert.throws(
            () => assertSupportedUploadType("Prezentacija.pptx", "test"),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedFileTypeError);
                assert.equal(err.fileType, "pptx");
                assert.match(
                    err.message,
                    /^Unsupported file type: pptx\. Allowed: pdf, docx, doc, txt, xlsx, xlsm, xls, csv, eml, msg$/,
                );
                assert.deepEqual(err.toResponseBody(), {
                    detail: err.message,
                    code: "unsupported_file_type",
                    file_type: "pptx",
                    allowed: ["pdf", "docx", "doc", "txt", "xlsx", "xlsm", "xls", "csv", "eml", "msg", "md", "markdown"],
                });
                return true;
            },
        );
    });

    it("never echoes a hostile extension verbatim", () => {
        assert.throws(
            () => assertSupportedUploadType('x.ev"il\nlog', "test"),
            (err: unknown) =>
                err instanceof UnsupportedFileTypeError &&
                err.fileType === "evillog",
        );
        assert.throws(
            () => assertSupportedUploadType("no-extension", "test"),
            (err: unknown) =>
                err instanceof UnsupportedFileTypeError &&
                /Unsupported file type: \(none\)/.test(err.message),
        );
    });
});

describe("upload types — Markdown (BugFix 2026-09-28)", () => {
    it("accepts .md / .markdown and stores them as txt", () => {
        assert.equal(assertSupportedUploadType("Upute.md", "test"), "txt");
        assert.equal(assertSupportedUploadType("README.MARKDOWN", "test"), "txt");
        assert.equal(canonicalUploadType("md"), "txt");
        assert.equal(canonicalUploadType("pdf"), "pdf");
    });

    it("still rejects unknown types and lists md among the allowed ones", () => {
        assert.throws(
            () => assertSupportedUploadType("slika.png", "test"),
            (err: unknown) =>
                err instanceof UnsupportedFileTypeError &&
                err.toResponseBody().allowed.includes("md"),
        );
    });
});
