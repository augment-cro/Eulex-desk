import type { LucideIcon } from "lucide-react";
import { AlignLeft, List, Hash, DollarSign, ToggleLeft, Calendar, Tag, Percent, Banknote } from "lucide-react";
import type { ColumnFormat } from "../shared/types";

export const FORMAT_OPTIONS: Array<{
    value: ColumnFormat;
    /** i18n key under `columnFormats` */
    labelKey: string;
    icon: LucideIcon;
}> = [
    { value: "text", labelKey: "freeText", icon: AlignLeft },
    { value: "bulleted_list", labelKey: "bulletedList", icon: List },
    { value: "number", labelKey: "number", icon: Hash },
    { value: "percentage", labelKey: "percentage", icon: Percent },
    { value: "monetary_amount", labelKey: "monetaryAmount", icon: Banknote },
    { value: "currency", labelKey: "currency", icon: DollarSign },
    { value: "yes_no", labelKey: "yesNo", icon: ToggleLeft },
    { value: "date", labelKey: "date", icon: Calendar },
    { value: "tag", labelKey: "tags", icon: Tag },
];

export function formatLabelT(
    format: ColumnFormat,
    t: (key: string) => string,
): string {
    const key = FORMAT_OPTIONS.find((o) => o.value === format)?.labelKey;
    return key ? t(key) : t("freeText");
}

export function formatIcon(format: ColumnFormat): LucideIcon {
    return FORMAT_OPTIONS.find((o) => o.value === format)?.icon ?? AlignLeft;
}
