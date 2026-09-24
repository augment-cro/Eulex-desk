import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
    SIGNING_CONTEXT,
    canonicalize,
    digestManifestBody,
    manifestPublicKey,
    sealManifest,
} from "./manifestSigning";

const KEY = "11".repeat(32);

afterEach(() => {
    delete process.env.MANIFEST_SIGNING_KEY;
});

const BODY = {
    manifest_version: 1,
    exported_at: "2026-08-18T10:00:00.000Z",
    project: { id: "p1", name: "Alpha" },
    documents: [
        { id: "d1", versions: [{ id: "v1", content_sha256: "a".repeat(64) }] },
    ],
};

/**
 * Rebuilds the signed payload and the public key independently of the module
 * under test, so these tests pin the wire format rather than agreeing with
 * the implementation. A recipient checking a manifest does exactly this.
 */
function payloadFor(digestHex: string, context = SIGNING_CONTEXT): Buffer {
    return Buffer.concat([
        Buffer.from(`${context}\0`, "utf8"),
        Buffer.from(digestHex, "hex"),
    ]);
}

function publicKeyOf(publicKeyHex: string): crypto.KeyObject {
    return crypto.createPublicKey({
        key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(publicKeyHex, "hex"),
        ]),
        format: "der",
        type: "spki",
    });
}

describe("canonicalize", () => {
    it("sorts object keys so parse order cannot change the digest", () => {
        assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
        assert.equal(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}');
    });

    it("sorts nested keys but preserves array order", () => {
        assert.equal(
            canonicalize({ x: [{ b: 1, a: 2 }, 3] }),
            '{"x":[{"a":2,"b":1},3]}',
        );
        assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
    });

    it("emits no whitespace, keeps nulls, drops undefined members", () => {
        assert.doesNotMatch(canonicalize(BODY), /\s/);
        assert.equal(
            canonicalize({ a: null, b: undefined, c: 1 }),
            '{"a":null,"c":1}',
        );
    });

    it("refuses non-finite numbers rather than collapsing them onto null", () => {
        assert.throws(() => canonicalize({ n: Number.NaN }), /finite/);
        assert.throws(() => canonicalize({ n: Infinity }), /finite/);
        assert.throws(() => canonicalize({ n: -Infinity }), /finite/);
    });

    it("refuses non-plain objects rather than serialising them wrongly", () => {
        // Each of these would otherwise pass silently and produce a digest
        // over something other than what the value represents.
        assert.throws(() => canonicalize({ d: new Date() }), /plain objects/);
        assert.throws(
            () => canonicalize({ b: Buffer.from("x") }),
            /plain objects/,
        );
        assert.throws(() => canonicalize({ m: new Map() }), /plain objects/);
        // Plain objects, including null-prototype ones, still pass.
        assert.equal(canonicalize({ a: 1 }), '{"a":1}');
        assert.equal(
            canonicalize(Object.assign(Object.create(null), { a: 1 })),
            '{"a":1}',
        );
    });

    it("gives a round-tripped manifest the same digest", () => {
        assert.equal(
            digestManifestBody(JSON.parse(JSON.stringify(BODY))).value,
            digestManifestBody(BODY).value,
        );
    });
});

describe("sealManifest", () => {
    it("attaches a digest and a null signature when no key is set", () => {
        assert.equal(manifestPublicKey(), null);
        const sealed = sealManifest(BODY);
        assert.equal(sealed.signature, null);
        assert.equal(sealed.digest.algorithm, "sha256");
        assert.match(sealed.digest.value, /^[0-9a-f]{64}$/);
    });

    it("publishes the same key it signs with, and never the seed", () => {
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const sealed = sealManifest(BODY);
        const published = manifestPublicKey()!;
        assert.equal(sealed.signature!.public_key, published.public_key);
        assert.equal(sealed.signature!.key_id, published.key_id);
        assert.notEqual(published.public_key, KEY);
        // key_id is the first 16 hex chars of SHA-256 over the raw key.
        assert.equal(
            published.key_id,
            crypto
                .createHash("sha256")
                .update(Buffer.from(published.public_key, "hex"))
                .digest("hex")
                .slice(0, 16),
        );
    });

    it("produces a signature any Ed25519 implementation can check", () => {
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const sealed = sealManifest(BODY);
        assert.equal(
            crypto.verify(
                null,
                payloadFor(sealed.digest.value),
                publicKeyOf(sealed.signature!.public_key),
                Buffer.from(sealed.signature!.value, "hex"),
            ),
            true,
        );
    });

    it("does not verify once the body has been edited", () => {
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const sealed = sealManifest(BODY);
        const edited = { ...sealed, project: { id: "p1", name: "Beta" } };
        const { digest: _d, signature: _s, ...body } = edited;
        assert.notEqual(digestManifestBody(body).value, sealed.digest.value);
        assert.equal(
            crypto.verify(
                null,
                payloadFor(digestManifestBody(body).value),
                publicKeyOf(sealed.signature!.public_key),
                Buffer.from(sealed.signature!.value, "hex"),
            ),
            false,
        );
    });

    it("rejects a signature made over a different domain context", () => {
        // Domain separation: the same key signing the same digest under
        // another label must not pass as a manifest signature, so one signing
        // key can serve other object types later without signatures crossing
        // between them.
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const sealed = sealManifest(BODY);
        const privateKey = crypto.createPrivateKey({
            key: Buffer.concat([
                Buffer.from("302e020100300506032b657004220420", "hex"),
                Buffer.from(KEY, "hex"),
            ]),
            format: "der",
            type: "pkcs8",
        });
        const publicKey = publicKeyOf(sealed.signature!.public_key);

        for (const payload of [
            payloadFor(sealed.digest.value, "eulex-project-manifest-v2"),
            payloadFor(sealed.digest.value, ""),
            Buffer.from(sealed.digest.value, "hex"), // bare digest, no context
        ]) {
            const foreign = crypto.sign(null, payload, privateKey);
            assert.equal(
                crypto.verify(
                    null,
                    payloadFor(sealed.digest.value),
                    publicKey,
                    foreign,
                ),
                false,
            );
        }
    });

    it("is deterministic for the same body and key", () => {
        process.env.MANIFEST_SIGNING_KEY = KEY;
        const a = sealManifest({ ...BODY });
        const b = sealManifest({ ...BODY });
        assert.equal(a.digest.value, b.digest.value);
        assert.equal(a.signature!.value, b.signature!.value);
    });

    it("throws on a malformed key rather than exporting unsigned", () => {
        process.env.MANIFEST_SIGNING_KEY = "not-hex";
        assert.throws(() => sealManifest(BODY), /MANIFEST_SIGNING_KEY/);
        assert.throws(() => manifestPublicKey(), /MANIFEST_SIGNING_KEY/);

        process.env.MANIFEST_SIGNING_KEY = "ab".repeat(16); // 16 bytes, not 32
        assert.throws(() => sealManifest(BODY), /32-byte hex/);
    });
});
