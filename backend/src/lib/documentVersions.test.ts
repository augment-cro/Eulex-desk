import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentSha256 } from "./documentVersions";

// Known SHA-256 vector for "abc" (FIPS 180-4). Call sites hand this helper a
// mix of Buffers, raw ArrayBuffers, and views into larger backing buffers
// (multer's file.buffer is one), so each of those must produce the same
// digest.
const ABC_SHA256 =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY_SHA256 =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("contentSha256", () => {
    it("matches the FIPS 180-4 digest for a Buffer", () => {
        assert.equal(contentSha256(Buffer.from("abc", "utf8")), ABC_SHA256);
    });

    it("matches the known digest for a raw ArrayBuffer", () => {
        const buf = Buffer.from("abc", "utf8");
        const ab = buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer;
        assert.equal(contentSha256(ab), ABC_SHA256);
    });

    it("respects a view's offset and length rather than its backing buffer", () => {
        const backing = Buffer.from("xxabcxx", "utf8");
        const view = new Uint8Array(
            backing.buffer,
            backing.byteOffset + 2,
            3,
        );
        assert.equal(contentSha256(view), ABC_SHA256);
    });

    it("respects a Buffer subarray (shared backing store)", () => {
        const backing = Buffer.from("xxabcxx", "utf8");
        assert.equal(contentSha256(backing.subarray(2, 5)), ABC_SHA256);
    });

    it("hashes empty content without throwing", () => {
        assert.equal(contentSha256(Buffer.alloc(0)), EMPTY_SHA256);
        assert.equal(contentSha256(new ArrayBuffer(0)), EMPTY_SHA256);
    });

    it("produces different digests for a one-byte difference", () => {
        assert.notEqual(
            contentSha256(Buffer.from("abc")),
            contentSha256(Buffer.from("abd")),
        );
    });
});
