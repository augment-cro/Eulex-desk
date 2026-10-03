// Ported from open-legal-products/mike 9014da5355de40b92eeedaa6e8c0b384d89243e0 frontend/src/app/types/luckyexcel.d.ts
// luckyexcel 1.0.1 ships no type declarations.

declare module "luckyexcel" {
  export interface LuckyExcelSheet {
    name: string;
    celldata?: unknown[];
    index?: string;
    order?: number;
    [key: string]: unknown;
  }

  export interface LuckyExcelJson {
    sheets: LuckyExcelSheet[];
    info?: { name?: string; creator?: string };
  }

  type TransformCallback = (
    exportJson: LuckyExcelJson,
    luckysheetfile: string,
  ) => void;

  const LuckyExcel: {
    transformExcelToLucky(file: File | Blob, callback: TransformCallback): void;
    transformExcelToLuckyByUrl(
      url: string,
      name: string,
      callback: TransformCallback,
    ): void;
  };

  export default LuckyExcel;
}
