"use client";

import { create } from 'zustand';
import { GroupId } from "@/permissions/groups";

/** The signed-in identity, populated from Auth0 via POST /api/users/sync. */
export type AppUser = {
  id: string;
  name: string;
  email: string;
  avatar: string;
  groupId: GroupId;
  role: string;
  onboardingComplete: boolean;
};

const ROLE_TO_GROUP: Record<string, GroupId> = {
  agent: 'agent',
  buyer: 'buyer',
  seller: 'seller',
  admin: 'admin',
  tc: 'tc',
  lending_partner: 'lending_partner',
};

const ROLE_DISPLAY: Record<string, string> = {
  agent: 'Agent',
  buyer: 'Buyer',
  seller: 'Seller',
  admin: 'Admin',
  tc: 'Transaction Coordinator',
  lending_partner: 'Lending Partner',
};

type AuthStore = {
  activeUser: AppUser | undefined;
  isLoaded: boolean;
  /**
   * Why POST /users/sync failed, as classified by
   * `AuthSetup#classifySyncError`. Two values are load-bearing markers that
   * `RootRedirect` renders a dedicated, actionable screen for:
   *
   *   "no-access"      — 403, no role assigned yet.
   *   "email-conflict" — 409, this email already belongs to another identity.
   *
   * Any other string is a transient failure (network / 5xx) kept for
   * diagnostics; it renders the generic "please refresh" screen. Don't hand a
   * free-form message either marker's exact text.
   */
  syncError: string | null;
  setFromAuth0: (id: string, name: string, email: string, role: string, onboardingComplete: boolean, avatar?: string) => void;
  setSyncError: (err: string) => void;
  markOnboardingComplete: () => void;
  /** Back to the signed-out state. Called on logout (hooks/useLogout.ts). */
  reset: () => void;
};

export const useAuthStore = create<AuthStore>((set) => ({
  activeUser: undefined,
  isLoaded: false,
  syncError: null,
  setFromAuth0: (id, name, email, role, onboardingComplete, avatar) => {
    const groupId = ROLE_TO_GROUP[role] ?? 'agent';
    set({
      isLoaded: true,
      activeUser: {
        id,
        name,
        email,
        avatar: avatar || `https://i.pravatar.cc/100?u=${encodeURIComponent(id)}`,
        groupId,
        role: ROLE_DISPLAY[role] ?? role,
        onboardingComplete,
      },
    });
  },
  setSyncError: (err: string) => set({ syncError: err, isLoaded: true }),
  markOnboardingComplete: () =>
    set((s) => s.activeUser ? { activeUser: { ...s.activeUser, onboardingComplete: true } } : {}),
  reset: () => set({ activeUser: undefined, isLoaded: false, syncError: null }),
}));
