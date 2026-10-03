import { describe, expect, it } from "vitest";
import { localizeNotFound } from "./pillUtils";

const hr = { notFound: "Nije pronađeno", yes: "Da", no: "Ne" };

describe("localizeNotFound", () => {
    it("translates the whole-value sentinel", () => {
        expect(localizeNotFound("Not Found", hr)).toBe("Nije pronađeno");
        expect(localizeNotFound(" not found. ", hr)).toBe("Nije pronađeno");
    });

    it("translates the sentinel the model wrote into its prose (prod 30. 9.)", () => {
        expect(localizeNotFound("Rok za izradu nije naveden (Not Found); ugovor je sklopljen 14. travnja 2024.", hr)).toBe(
            "Rok za izradu nije naveden (nije pronađeno); ugovor je sklopljen 14. travnja 2024.",
        );
        expect(localizeNotFound("Rok: Not Found. Cijena: 11.000,00 eura.", hr)).toBe(
            "Rok: Nije pronađeno. Cijena: 11.000,00 eura.",
        );
    });

    it("leaves text without the sentinel, and every value without labels, unchanged", () => {
        expect(localizeNotFound("Ugovorna kazna 1 ‰ dnevno.", hr)).toBe("Ugovorna kazna 1 ‰ dnevno.");
        expect(localizeNotFound("Not Found", undefined)).toBe("Not Found");
    });
});
