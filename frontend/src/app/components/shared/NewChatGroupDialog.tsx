"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface Props {
    open: boolean;
    onClose: () => void;
    /** Called with the trimmed, non-empty group name. Return false to
     *  keep the dialog open (creation failed — lets the user retry). */
    onCreate: (name: string) => Promise<boolean> | boolean;
}

/**
 * Small name prompt for creating a sidebar conversation group, opened from
 * the chat item's "Move to group → New group…" menu entry (tracker #13).
 */
export function NewChatGroupDialog({ open, onClose, onCreate }: Props) {
    const t = useTranslations("chatItem");
    const tc = useTranslations("common");
    const [name, setName] = useState("");
    const [saving, setSaving] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) {
            setName("");
            setSaving(false);
            // Radix mounts the content async; focus after paint.
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    }, [open]);

    const handleCreate = async () => {
        const trimmed = name.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        try {
            const ok = await onCreate(trimmed);
            if (ok !== false) onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("newGroupTitle")}</DialogTitle>
                </DialogHeader>
                <Input
                    ref={inputRef}
                    value={name}
                    maxLength={100}
                    placeholder={t("groupNamePlaceholder")}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") void handleCreate();
                    }}
                />
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        {tc("cancel")}
                    </Button>
                    <Button
                        onClick={() => void handleCreate()}
                        disabled={!name.trim() || saving}
                    >
                        {tc("createAction")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
