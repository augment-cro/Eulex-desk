import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeReadUrl, userProvidedUrls } from "./index";

describe("read_url with web access off — user-provided links only", () => {
    it("normalizes scheme, fragment, trailing slash and sentence punctuation away", () => {
        const key = "narodne-novine.nn.hr/clanci/sluzbeni/2025_12_136_2018.html";
        assert.equal(normalizeReadUrl("https://narodne-novine.nn.hr/clanci/sluzbeni/2025_12_136_2018.html"), key);
        assert.equal(normalizeReadUrl("http://narodne-novine.nn.hr/clanci/sluzbeni/2025_12_136_2018.html#top"), key);
        assert.equal(normalizeReadUrl("https://narodne-novine.nn.hr/clanci/sluzbeni/2025_12_136_2018.html."), key);
        assert.equal(normalizeReadUrl("https://example.com/a/?q=1"), "example.com/a?q=1");
        assert.equal(normalizeReadUrl("not a url"), null);
        assert.equal(normalizeReadUrl("ftp://example.com/x"), null);
    });

    it("collects links from user messages only (string and part content)", () => {
        const urls = userProvidedUrls([
            { role: "system", content: "Pravila: https://internal.example/rules" },
            { role: "user", content: "Pročitaj https://narodne-novine.nn.hr/clanci/sluzbeni/2026_09_101_1212.html." },
            { role: "assistant", content: "Vidi https://narodne-novine.nn.hr/eli/sluzbeni/2011/125/2498" },
            { role: "user", content: [{ type: "text", text: "i (https://www.zakon.hr/z/98/Kazneni-zakon)" }] },
        ]);
        assert.deepEqual(
            [...urls].sort(),
            ["narodne-novine.nn.hr/clanci/sluzbeni/2026_09_101_1212.html", "www.zakon.hr/z/98/Kazneni-zakon"],
        );
    });

    it("no link in the user's messages → empty (read_url is then not offered)", () => {
        assert.equal(userProvidedUrls([{ role: "user", content: "koja je kazna za silovanje?" }]).size, 0);
    });
});
