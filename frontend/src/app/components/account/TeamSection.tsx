"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Crown, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    addTeamMember,
    getMyTeam,
    removeTeamMember,
    type Team,
} from "@/app/lib/mikeApi";

/**
 * Team roster for the account page. Self-hides unless the caller belongs to
 * a team (Team-tier). Owners/admins can add colleagues by email and remove
 * members; everyone sees the roster + seat usage. Adding a member to a
 * specific predmet happens on the project itself (projects.shared_with).
 */
export function TeamSection() {
    const t = useTranslations("account.team");
    const { profile } = useUserProfile();

    const [team, setTeam] = useState<Team | null>(null);
    const [loading, setLoading] = useState(true);
    const [email, setEmail] = useState("");
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [removingId, setRemovingId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await getMyTeam();
                if (!cancelled) setTeam(res.team);
            } catch {
                /* no team / unauth — section stays hidden */
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Hidden entirely for users without a team.
    if (loading || !team) return null;

    const canManage = team.role === "owner" || team.role === "admin";
    const seatsFull = team.seatsUsed >= team.seats;

    async function refresh() {
        try {
            const res = await getMyTeam();
            setTeam(res.team);
        } catch {
            /* keep current view */
        }
    }

    async function onAdd() {
        const e = email.trim();
        if (!e || !team) return;
        setAdding(true);
        setError(null);
        try {
            await addTeamMember(team.id, e);
            setEmail("");
            await refresh();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(
                /no_seats/i.test(msg)
                    ? t("errSeats")
                    : /invalid_email/i.test(msg)
                      ? t("errEmail")
                      : t("errGeneric"),
            );
        } finally {
            setAdding(false);
        }
    }

    async function onRemove(memberId: string) {
        if (!team) return;
        setRemovingId(memberId);
        setError(null);
        try {
            await removeTeamMember(team.id, memberId);
            setConfirmId(null);
            await refresh();
        } catch {
            setError(t("errGeneric"));
        } finally {
            setRemovingId(null);
        }
    }

    return (
        <div className="py-6">
            <div className="mb-4 flex items-center justify-between gap-4">
                <h2 className="font-serif text-2xl font-medium">{t("title")}</h2>
                <span className="text-sm text-muted-foreground">
                    {t("seats", { used: team.seatsUsed, total: team.seats })}
                </span>
            </div>

            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {team.members.map((m) => {
                    const isYou = !!profile?.id && m.userId === profile.id;
                    return (
                        <li
                            key={m.id}
                            className="flex items-center gap-3 px-4 py-3"
                        >
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium">
                                        {m.displayName || m.email}
                                    </span>
                                    {isYou && (
                                        <Badge variant="secondary">
                                            {t("you")}
                                        </Badge>
                                    )}
                                </div>
                                {m.displayName && (
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {m.email}
                                    </span>
                                )}
                            </div>

                            {m.role === "owner" ? (
                                <Badge variant="secondary">
                                    <Crown className="h-3 w-3" />
                                    {t("roleOwner")}
                                </Badge>
                            ) : m.role === "admin" ? (
                                <Badge variant="secondary">
                                    <ShieldCheck className="h-3 w-3" />
                                    {t("roleAdmin")}
                                </Badge>
                            ) : (
                                <Badge variant="outline">{t("roleMember")}</Badge>
                            )}

                            {m.status === "invited" && (
                                <Badge
                                    variant="outline"
                                    className="text-muted-foreground"
                                >
                                    {t("pending")}
                                </Badge>
                            )}

                            {canManage &&
                                m.role !== "owner" &&
                                (confirmId === m.id ? (
                                    <span className="flex items-center gap-1">
                                        <Button
                                            size="sm"
                                            variant="destructive"
                                            disabled={removingId === m.id}
                                            onClick={() => onRemove(m.id)}
                                        >
                                            {removingId === m.id
                                                ? t("removing")
                                                : t("confirmRemove")}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => setConfirmId(null)}
                                        >
                                            {t("cancel")}
                                        </Button>
                                    </span>
                                ) : (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t("remove")}
                                        onClick={() => setConfirmId(m.id)}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                ))}
                        </li>
                    );
                })}
            </ul>

            {canManage && (
                <div className="mt-3">
                    <div className="flex items-center gap-2">
                        <Input
                            type="email"
                            placeholder={t("addPlaceholder")}
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            disabled={adding || seatsFull}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") onAdd();
                            }}
                            className="max-w-xs"
                        />
                        <Button
                            onClick={onAdd}
                            disabled={adding || seatsFull || !email.trim()}
                        >
                            <UserPlus className="h-3.5 w-3.5" />
                            {adding ? t("adding") : t("add")}
                        </Button>
                    </div>
                    {seatsFull && (
                        <p className="mt-1 text-xs text-muted-foreground">
                            {t("seatsFull")}
                        </p>
                    )}
                    {error && (
                        <p className="mt-1 text-xs text-destructive">{error}</p>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                        {t("hint")}
                    </p>
                </div>
            )}
        </div>
    );
}
