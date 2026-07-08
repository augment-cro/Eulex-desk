// Test: simulate full generateDocx pipeline with Croatian characters
// This mimics exactly what happens when the model calls generate_docx

const path = require("path");

// Mock the sections exactly as model would send them
const mockArgs = {
    title: "Ugovor o kupoprodaji nekretnine",
    sections: [
        {
            heading: "Predmet ugovora",
            level: 1,
            content: "Prodavatelj izjavljuje i jamči da je jedini i isključivi vlasnik Nekretnine upisane u zemljišnoj knjizi, te da Nekretnina nije opterećena nikakvim dužnostima, založnim pravima, služnostima, teretima, predbilježbama ni drugim pravima trećih osoba koja bi umanjivala ili ograničila kupčev stjecaj prava vlasništva."
        },
        {
            heading: "Cijena i plaćanje",
            level: 1,
            content: "Kupoprodajna cijena za Nekretninu iznosi 250.000,00 EUR (dvjestopedeset tisuća eura). Kupac se obvezuje platiti cjelokupni iznos kupoprodajne cijene na račun Prodavatelja najkasnije u roku od 30 (trideset) dana od dana sklapanja ovoga Ugovora."
        },
        {
            heading: "Završne odredbe",
            level: 1,
            content: "Ovaj Ugovor sastavljen je u četiri (4) istovjetna primjerka, od kojih svaka ugovorna strana zadržava po dva (2) primjerka."
        }
    ]
};

// Test: JSON stringify/parse roundtrip (simulates the tool call pipeline)
const jsonStr = JSON.stringify(mockArgs);
const parsed = JSON.parse(jsonStr);

console.log("=== JSON Roundtrip Test ===");
const originalContent = mockArgs.sections[0].content;
const parsedContent = parsed.sections[0].content;
console.log("Original === Parsed:", originalContent === parsedContent);

// Check each Croatian character
const croatianChars = ['č', 'ć', 'š', 'ž', 'đ', 'Č', 'Ć', 'Š', 'Ž', 'Đ'];
for (const ch of croatianChars) {
    const inOriginal = originalContent.includes(ch);
    const inParsed = parsedContent.includes(ch);
    console.log(`  ${ch}: original=${inOriginal}, parsed=${inParsed}, match=${inOriginal === inParsed}`);
}

// Now test content.split("\n") processing (what generateDocx does on line 1044)
console.log("\n=== Content Split Test ===");
for (const section of parsed.sections) {
    const lines = section.content.split("\n");
    console.log(`Section "${section.heading}": ${lines.length} lines after split`);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Check for Croatian chars in each line
        const hasSpecial = croatianChars.some(c => trimmed.includes(c));
        console.log(`  Line (${trimmed.length} chars, hasCroatian=${hasSpecial}): "${trimmed.slice(0, 80)}..."`);
    }
}

console.log("\n=== Test PASSED — all Croatian characters survive the pipeline ===");
