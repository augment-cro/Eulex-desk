"use client";

/**
 * TEST/PREVIEW — shadcn `InputGroup` verzija asistent chat-boxa.
 * Otvori na /preview/chatbox da usporediš s trenutnim (legacy) ChatInputom.
 * Hardkodirani stringovi su OK ovdje jer je ovo throwaway preview, ne ship.
 */

import { useState } from "react";
import { ArrowRight, FolderOpen, Globe, Library, Plus, Plug } from "lucide-react";

import {
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupTextarea,
} from "@/components/ui/input-group";

export default function ChatboxPreviewPage() {
    const [value, setValue] = useState("");

    return (
        <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-10 px-4">
            <div className="flex items-center gap-3">
                <span className="text-3xl" aria-hidden>
                    ✳︎
                </span>
                <h1 className="text-4xl font-serif font-light text-foreground">
                    Pozdrav, Ana
                </h1>
            </div>

            <div className="w-full max-w-3xl">
                <InputGroup className="rounded-2xl">
                    <InputGroupTextarea
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder="Postavite pitanje..."
                        className="min-h-[64px] text-base"
                    />

                    <InputGroupAddon align="block-end">
                        <InputGroupButton variant="ghost" size="sm">
                            <Plus />
                            Dokumenti
                        </InputGroupButton>
                        <InputGroupButton variant="ghost" size="sm">
                            <FolderOpen />
                            Predmeti
                        </InputGroupButton>
                        <InputGroupButton variant="ghost" size="sm">
                            <Library />
                            Radni tijekovi
                        </InputGroupButton>
                        <InputGroupButton
                            variant="ghost"
                            size="sm"
                            className="text-foreground hover:text-foreground hover:bg-accent"
                        >
                            <Plug />2
                        </InputGroupButton>
                        <InputGroupButton
                            variant="ghost"
                            size="sm"
                            className="text-foreground hover:text-foreground hover:bg-accent"
                        >
                            <Globe />
                            Web
                        </InputGroupButton>

                        <InputGroupButton
                            variant="default"
                            size="icon-sm"
                            className="ml-auto rounded-lg"
                            aria-label="Pošalji"
                        >
                            <ArrowRight />
                        </InputGroupButton>
                    </InputGroupAddon>
                </InputGroup>

                <p className="mt-2 text-center text-sm text-muted-foreground">
                    AI može pogriješiti. Odgovori ne predstavljaju pravni savjet.
                </p>
            </div>
        </div>
    );
}
