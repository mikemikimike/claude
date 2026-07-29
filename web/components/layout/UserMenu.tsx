"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronDown, LogOut, Settings } from "lucide-react";
import { useAuthStore } from "@/lib/store/authStore";
import { useLogout } from "@/hooks/useLogout";
import { GroupId } from "@/permissions/groups";

// Only the dashboard shells have a settings route (see AGENT_NAV / ADMIN_NAV /
// TC_NAV in AppLayout). Buyers, sellers and lending partners have none, so for
// them the menu is identity + log out.
const SETTINGS_HREF: Partial<Record<GroupId, string>> = {
  agent: "/agent/settings",
  admin: "/admin/settings",
  tc: "/tc/settings",
};

type Props = {
  /** "dark" sits on the navy client header; "light" on the white dashboard bar. */
  variant?: "light" | "dark";
  /** Avatar ring class, matching each shell's accent colour. */
  avatarRingClass?: string;
  /** Hide the name on tight bars (e.g. the onboarding wizard). */
  showName?: boolean;
};

/**
 * Identity + log out, for every role. Before this there was no way to sign out
 * of RealTourFlow at all, and agents saw no indication of which account they
 * were in.
 *
 * Popover mechanics follow NotificationBell (the app has no design-system menu
 * primitive), with the keyboard/ARIA affordances it lacks added here.
 */
export default function UserMenu({
  variant = "light",
  avatarRingClass = "ring-gray-200",
  showName = true,
}: Props) {
  const activeUser = useAuthStore((s) => s.activeUser);
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  if (!activeUser) return null;

  const settingsHref = SETTINGS_HREF[activeUser.groupId as GroupId];
  const nameClass = variant === "dark" ? "text-white/70" : "text-gray-500";
  const chevronClass = variant === "dark" ? "text-white/50" : "text-gray-400";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg px-1 py-0.5 transition-opacity hover:opacity-80"
      >
        {showName && (
          <span className={`hidden sm:block text-sm ${nameClass}`}>{activeUser.name}</span>
        )}
        <Image
          src={activeUser.avatar}
          alt=""
          width={28}
          height={28}
          unoptimized
          className={`h-7 w-7 rounded-full ring-2 ${avatarRingClass}`}
        />
        <ChevronDown size={14} className={chevronClass} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-50 w-60 overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-xl"
        >
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="truncate text-sm font-bold text-brand-navy">{activeUser.name}</p>
            <p className="truncate text-xs text-gray-400">{activeUser.email}</p>
            <span className="mt-1.5 inline-block rounded-full bg-brand-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">
              {activeUser.role}
            </span>
          </div>

          {settingsHref && (
            <Link
              href={settingsHref}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-600 transition-colors hover:bg-brand-bg"
            >
              <Settings size={15} /> Settings
            </Link>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              logout();
            }}
            className="flex w-full items-center gap-2.5 border-t border-gray-100 px-4 py-2.5 text-left text-sm font-semibold text-red-600 transition-colors hover:bg-red-50"
          >
            <LogOut size={15} /> Log out
          </button>
        </div>
      )}
    </div>
  );
}
