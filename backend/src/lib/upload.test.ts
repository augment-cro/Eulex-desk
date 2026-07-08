import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { singleFileUpload, MAX_UPLOAD_SIZE_BYTES } from "./upload.js";

// Build a minimal test app that mounts singleFileUpload and echoes file info.
function buildApp() {
  const app = express();
  app.post(
    "/upload",
    singleFileUpload("file"),
    (req: express.Request, res: express.Response) => {
      res.json({
        name: req.file?.originalname ?? null,
        size: req.file?.size ?? null,
      });
    },
  );
  return app;
}

const app = buildApp();

describe("singleFileUpload middleware (multer 2.x)", () => {
  it("happy path — small file accepted with populated req.file", async () => {
    const buf = Buffer.alloc(1024, "x");
    const res = await request(app)
      .post("/upload")
      .attach("file", buf, "a.txt");

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.equal(res.body.name, "a.txt", "Expected originalname 'a.txt'");
    assert.equal(res.body.size, 1024, "Expected size 1024");
  });

  it("oversize — buffer > MAX_UPLOAD_SIZE_BYTES returns 413", async () => {
    // Allocate just over 100 MB (content irrelevant; allocUnsafe skips the fill)
    const buf = Buffer.allocUnsafe(MAX_UPLOAD_SIZE_BYTES + 1);
    const res = await request(app)
      .post("/upload")
      .attach("file", buf, "big.bin");

    assert.equal(res.status, 413, `Expected 413, got ${res.status}`);
    assert.ok(
      typeof res.body.detail === "string" &&
        res.body.detail.includes("File too large"),
      `Expected 'File too large' in detail, got: ${res.body.detail}`,
    );
  });

  it("wrong field name — returns 400 with Upload failed detail", async () => {
    const buf = Buffer.alloc(1024, "x");
    const res = await request(app)
      .post("/upload")
      .attach("wrongfield", buf, "a.txt");

    assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    assert.ok(
      typeof res.body.detail === "string" &&
        res.body.detail.startsWith("Upload failed:"),
      `Expected detail starting with 'Upload failed:', got: ${res.body.detail}`,
    );
  });
});
