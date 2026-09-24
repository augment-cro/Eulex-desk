import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    SUPPORTED_UPLOAD_TYPES,
    UnsupportedFileTypeError,
    assertSupportedUploadType,
    contentTypeForUpload,
    fileExtension,
    isSupportedUploadType,
} from "./fileTypes.js";

describe("fileTypes", () => {
    it("reads the lower-cased extension", () => {
        assert.equal(fileExtension("Ugovor.DOCX"), "docx");
        assert.equal(fileExtension("a.b.pdf"), "pdf");
        assert.equal(fileExtension("README"), "");
    });

    it("supports exactly pdf, docx, doc and txt", () => {
        assert.deepEqual([...SUPPORTED_UPLOAD_TYPES], ["pdf", "docx", "doc", "txt"]);
        assert.ok(isSupportedUploadType("txt"));
        assert.ok(!isSupportedUploadType("xlsx"));
        assert.ok(!isSupportedUploadType("eml"));
    });

    it("stores .doc as application/msword, not as DOCX", () => {
        assert.equal(contentTypeForUpload("doc"), "application/msword");
        assert.equal(contentTypeForUpload("txt"), "text/plain; charset=utf-8");
    });

    it("accepts a supported upload and returns its type", () => {
        assert.equal(assertSupportedUploadType("Tužba.pdf", "test"), "pdf");
    });

    it("rejects an unsupported upload with a structured, bounded error", () => {
        assert.throws(
            () => assertSupportedUploadType("Registar ugovora.xlsx", "test"),
            (err: unknown) => {
                assert.ok(err instanceof UnsupportedFileTypeError);
                assert.equal(err.fileType, "xlsx");
                assert.match(err.message, /^Unsupported file type: xlsx\. Allowed: pdf, docx, doc, txt$/);
                assert.deepEqual(err.toResponseBody(), {
                    detail: err.message,
                    code: "unsupported_file_type",
                    file_type: "xlsx",
                    allowed: ["pdf", "docx", "doc", "txt"],
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
