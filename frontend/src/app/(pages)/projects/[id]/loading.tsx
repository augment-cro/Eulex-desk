"use client";

import { useTranslations } from "next-intl";
import { FullscreenLoader } from "@/app/components/shared/FullscreenLoader";

export default function ProjectLoading() {
    const t = useTranslations("projectPage");
    return <FullscreenLoader label={t("loadingProject")} />;
}
