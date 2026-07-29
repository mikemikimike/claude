"use client";

import { ReactNode, useState, useRef, useEffect } from 'react';
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/lib/store/authStore";
import { useAgentSetupStore } from "@/lib/store/agentSetupStore";
import { GroupId } from "@/permissions/groups";
import {
  LayoutDashboard,
  GitBranch,
  FolderOpen,
  Calendar,
  MessageSquare,
  FileText,
  Settings,
  AlertCircle,
  CheckSquare,
  DollarSign,
  Zap,
  Activity,
  Tag,
  Sliders,
  ClipboardList,
  UserPlus,
  User,
  Users,
  LogOut,
  Bell,
  X,
  ScrollText,
  Menu,
  Landmark,
  type LucideIcon,
} from 'lucide-react';
import InviteModal from '../InviteModal';
import VerifyEmailBanner from '../VerifyEmailBanner';
import UserMenu from './UserMenu';
import { useNotifications } from "@/hooks/useNotifications";

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { notifications, markRead, markAllRead } = useNotifications();
  const ref = useRef<HTMLDivElement>(null);

  const unread = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white leading-none">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-80 rounded-2xl bg-white shadow-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <span className="text-sm font-bold text-brand-navy">Notifications</span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs font-medium text-gray-400 hover:text-brand-navy transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {notifications.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-400">All caught up!</p>
            ) : (
              notifications.map((n) => (
                <Link
                  key={n.id}
                  href={n.href ?? '#'}
                  onClick={() => { markRead(n.id); setOpen(false); }}
                  className={`block px-4 py-3 hover:bg-brand-bg transition-colors ${n.read ? '' : 'bg-blue-50/60'}`}
                >
                  <div className="flex items-start gap-2.5">
                    {!n.read && (
                      <span className="mt-1.5 flex-shrink-0 h-2 w-2 rounded-full bg-blue-500" />
                    )}
                    <div className={n.read ? 'ml-4' : ''}>
                      <p className={`text-xs font-semibold ${n.read ? 'text-gray-600' : 'text-brand-navy'}`}>{n.title}</p>
                      {n.body && <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{n.body}</p>}
                      <p className="text-[10px] text-gray-300 mt-1">{n.createdAt}</p>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Agent Sidebar Nav ────────────────────────────────────────────────────────

const AGENT_NAV = [
  { label: 'Dashboard', icon: LayoutDashboard, href: '/agent' },
  { label: 'Pipeline', icon: GitBranch, href: '/agent/pipeline' },
  { label: 'Deals', icon: FolderOpen, href: '/agent/deals' },
  { label: 'Calendar', icon: Calendar, href: '/agent/calendar' },
  { label: 'Messages', icon: MessageSquare, href: '/agent/messages' },
  { label: 'Documents', icon: FileText, href: '/agent/documents' },
  { label: 'Settings', icon: Settings, href: '/agent/settings' },
];

const ADMIN_NAV = [
  { label: 'Pipeline Overview', icon: GitBranch, href: '/admin' },
  { label: 'All Deals', icon: FolderOpen, href: '/admin/deals' },
  { label: 'Pending Disclosures', icon: AlertCircle, href: '/admin/disclosures' },
  { label: 'Pre-Approval Queue', icon: CheckSquare, href: '/admin/preapproval' },
  { label: 'Stuck Deals', icon: AlertCircle, href: '/admin/stuck' },
  { label: 'Fees Collected', icon: DollarSign, href: '/admin/fees' },
  { label: 'Outstanding', icon: ClipboardList, href: '/admin/outstanding' },
  { label: 'Active Fast Pass', icon: Zap, href: '/admin/fastpass' },
  { label: 'Smooth Exit', icon: LogOut, href: '/admin/smoothexit' },
  { label: 'ARIVE Status', icon: Activity, href: '/admin/arive' },
  { label: 'User Management', icon: Users, href: '/admin/users' },
  { label: 'Form Review', icon: ClipboardList, href: '/admin/forms' },
  { label: 'Companies', icon: UserPlus, href: '/admin/brokerages' },
  { label: 'Promotions', icon: Tag, href: '/admin/promotions' },
  { label: 'System Config', icon: Sliders, href: '/admin/config' },
  { label: 'Audit Log', icon: ScrollText, href: '/admin/audit' },
  { label: 'Settings', icon: Settings, href: '/admin/settings' },
];

export const TC_NAV = [
  { label: 'Overview',         icon: FolderOpen,    href: '/tc'              },
  { label: 'Documents',        icon: FileText,      href: '/tc/documents'    },
  { label: 'Loan Milestones',  icon: ClipboardList, href: '/tc/disclosures'  },
  { label: 'Checklists',       icon: CheckSquare,   href: '/tc/checklists'   },
  { label: 'Calendar',         icon: Calendar,      href: '/tc/calendar'     },
  { label: 'Contacts',         icon: User,          href: '/tc/messages'     },
  { label: 'Settings',         icon: Settings,      href: '/tc/settings'     },
];

// ─── Sub-layouts ──────────────────────────────────────────────────────────────

type SidebarNavItem = { label: string; icon: LucideIcon; href: string };

function SidebarBrand({
  title,
  labelColor,
  onClose,
}: {
  title: string;
  labelColor: string;
  onClose?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-white/10">
      <div className="flex items-center gap-2">
        <span className="text-lg font-bold tracking-tight">RealTour Flow</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${labelColor}`}>
          {title}
        </span>
      </div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close navigation"
          className="text-white/70 hover:text-white transition-colors md:hidden"
        >
          <X size={18} />
        </button>
      )}
    </div>
  );
}

function SidebarNavList({
  items,
  onNavigate,
}: {
  items: SidebarNavItem[];
  onNavigate?: () => void;
}) {
  const location = usePathname();

  return (
    <nav className="flex-1 overflow-y-auto px-3 py-4">
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive =
            item.href === '/agent' || item.href === '/admin'
              ? location === item.href
              : location.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                className={[
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-brand-gold text-brand-navy font-semibold'
                    : 'text-white/70 hover:bg-white/10 hover:text-white',
                ].join(' ')}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// Persistent sidebar on md+; a slide-in drawer (with backdrop) below md.
function Sidebar({
  items,
  title,
  labelColor,
  drawerOpen,
  onClose,
}: {
  items: SidebarNavItem[];
  title: string;
  labelColor: string;
  drawerOpen: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {/* Desktop — persistent sidebar */}
      <aside className="hidden md:flex h-full w-56 flex-shrink-0 flex-col bg-brand-navy text-white">
        <SidebarBrand title={title} labelColor={labelColor} />
        <SidebarNavList items={items} />
      </aside>

      {/* Mobile — tap-to-dismiss backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/50 md:hidden transition-opacity duration-200 ${
          drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Mobile — slide-in drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 max-w-[82%] flex-col bg-brand-navy text-white shadow-xl md:hidden transition-transform duration-200 ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <SidebarBrand title={title} labelColor={labelColor} onClose={onClose} />
        <SidebarNavList items={items} onNavigate={onClose} />
      </aside>
    </>
  );
}

function TopHeader({
  roleLabel,
  roleBgClass,
}: {
  roleLabel: string;
  roleBgClass: string;
}) {
  return (
    <header className="flex h-14 flex-shrink-0 items-center justify-between bg-brand-navy px-6 shadow-md">
      <div className="flex items-center gap-2">
        <span className="text-base font-bold text-white tracking-tight">RealTour Flow</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${roleBgClass}`}>
          {roleLabel}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <UserMenu variant="dark" avatarRingClass="ring-brand-gold/50" />
      </div>
    </header>
  );
}

// Agent Layout

function SetupBanner() {
  const { bannerDismissed, dismissBanner } = useAgentSetupStore();
  const onboardingComplete = useAuthStore((s) => s.activeUser?.onboardingComplete);
  if (onboardingComplete || bannerDismissed) return null;
  return (
    <div className="flex items-center justify-between gap-3 bg-amber-50 border-b border-amber-200 px-5 py-2.5">
      <div className="flex items-center gap-2 text-sm text-amber-800">
        <span className="font-semibold">Your account setup isn&apos;t complete yet.</span>
        <span className="text-amber-600 hidden sm:inline">Finish in about 3 minutes to unlock your full workspace.</span>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <Link
          href="/onboard/agent"
          className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-bold text-white hover:bg-amber-600 transition-colors"
        >
          Complete setup →
        </Link>
        <button onClick={dismissBanner} className="text-amber-400 hover:text-amber-600 transition-colors">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

// Shared dashboard shell for the agent/admin/TC roles. Persistent sidebar on
// md+; on mobile the sidebar becomes a drawer opened by the top-bar hamburger,
// and the content column goes full-width. `topBar` holds the role-specific
// right-side actions; `banner` is an optional banner under VerifyEmailBanner.
function DashboardFrame({
  items,
  title,
  labelColor,
  topBar,
  banner,
  children,
}: {
  items: SidebarNavItem[];
  title: string;
  labelColor: string;
  topBar: ReactNode;
  banner?: ReactNode;
  children: ReactNode;
}) {
  // The drawer closes itself on every dismissal path — a nav-link tap
  // (onNavigate), the backdrop, and the X all call onClose — so no
  // route-change effect is needed (and one would trip react-hooks/set-state-in-effect).
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-brand-bg">
      <Sidebar
        items={items}
        title={title}
        labelColor={labelColor}
        drawerOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <div className="flex h-12 flex-shrink-0 items-center gap-3 bg-white border-b border-gray-100 px-4 sm:px-5 shadow-sm">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="md:hidden -ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
          >
            <Menu size={18} />
          </button>
          {topBar}
        </div>
        <VerifyEmailBanner />
        {banner}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

function AgentLayout({ children }: { children: ReactNode }) {
  const activeUser = useAuthStore((s) => s.activeUser);
  const [showInvite, setShowInvite] = useState(false);

  const topBar = (
    <div className="ml-auto flex items-center gap-2 sm:gap-3">
      <NotificationBell />
      <button
        onClick={() => setShowInvite(true)}
        className="flex items-center gap-2 rounded-lg bg-brand-gold px-2.5 py-1.5 sm:px-3.5 text-sm font-semibold text-brand-navy hover:bg-brand-gold-dark transition-colors shadow-sm"
      >
        <UserPlus size={15} />
        <span className="hidden sm:inline">Invite Client</span>
      </button>
      <UserMenu avatarRingClass="ring-blue-200" />
    </div>
  );

  return (
    <>
      <DashboardFrame
        items={AGENT_NAV}
        title="Agent"
        labelColor="bg-blue-500/30 text-blue-300"
        topBar={topBar}
        banner={<SetupBanner />}
      >
        {children}
      </DashboardFrame>

      {showInvite && activeUser && (
        <InviteModal agentId={activeUser.id} onClose={() => setShowInvite(false)} />
      )}
    </>
  );
}

// Admin Layout

function AdminLayout({ children }: { children: ReactNode }) {
  const topBar = (
    <>
      <span className="text-xs font-semibold text-gray-400">Admin Console</span>
      <div className="ml-auto flex items-center gap-3">
        <NotificationBell />
        <UserMenu avatarRingClass="ring-red-200" />
      </div>
    </>
  );

  return (
    <DashboardFrame items={ADMIN_NAV} title="Admin" labelColor="bg-red-500/30 text-red-300" topBar={topBar}>
      {children}
    </DashboardFrame>
  );
}

// TC Layout

function TCLayout({ children }: { children: ReactNode }) {
  const topBar = (
    <>
      <span className="text-xs font-semibold text-gray-400">Transaction Coordinator</span>
      <div className="ml-auto flex items-center gap-3">
        <NotificationBell />
        <UserMenu avatarRingClass="ring-amber-200" />
      </div>
    </>
  );

  return (
    <DashboardFrame items={TC_NAV} title="TC" labelColor="bg-amber-500/30 text-amber-300" topBar={topBar}>
      {children}
    </DashboardFrame>
  );
}

// Client Layout (buyer/seller — mobile-first, no sidebar)

function ClientLayout({ children, roleLabel }: { children: ReactNode; roleLabel: string }) {
  return (
    <div className="flex min-h-screen flex-col bg-brand-bg">
      <TopHeader roleLabel={roleLabel} roleBgClass="bg-brand-gold/20 text-brand-gold" />
      <VerifyEmailBanner />
      <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}

// Lending Partner Layout (#307)
//
// `lending_partner` is a real, assignable role with no product surface yet.
// Rather than dropping it into the full AgentLayout shell (Pipeline/Deals/
// Vendors — none of which is theirs), we render a self-contained, honest
// "not available yet" placeholder. It reads only the auth store (no network),
// so it fires zero agent-scoped API calls, and it intentionally does NOT render
// the routed page's children — a lending_partner who lands on any agent route
// still sees only this placeholder, never an agent page mounting its data hooks.

function LendingPartnerLayout() {
  return (
    <div
      data-testid="lending-partner-layout"
      className="flex min-h-screen flex-col bg-brand-bg"
    >
      <TopHeader roleLabel="Lending Partner" roleBgClass="bg-brand-gold/20 text-brand-gold" />
      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm border border-gray-100">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-brand-gold/15 text-brand-gold">
            <Landmark size={26} />
          </div>
          <h1 className="text-lg font-bold text-brand-navy">
            Your lending partner workspace isn&apos;t available yet
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-gray-500">
            There&apos;s nothing for you to do here right now. Lending partner tools
            are coming soon — until then, the agent you&apos;re working with will keep
            you in the loop directly.
          </p>
          <p className="mt-4 text-xs text-gray-400">
            Reached this by mistake? Contact the agent who added you to the deal.
          </p>
        </div>
      </main>
    </div>
  );
}

// ─── Smart AppLayout ───────────────────────────────────────────────────────────

type AppLayoutProps = {
  children: ReactNode;
};

export function AppLayout({ children }: AppLayoutProps) {
  const activeUser = useAuthStore((s) => s.activeUser);
  const isLoaded = useAuthStore((s) => s.isLoaded);
  const groupId = activeUser?.groupId as GroupId | undefined;

  // Hold rendering of protected pages until /users/sync completes so child
  // components don't fire API calls before the auth token is wired up.
  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-brand-bg">
        <div className="text-sm text-gray-400">Loading…</div>
      </div>
    );
  }

  if (groupId === 'agent') {
    return <AgentLayout>{children}</AgentLayout>;
  }

  if (groupId === 'admin') {
    return <AdminLayout>{children}</AdminLayout>;
  }

  if (groupId === 'buyer') {
    return <ClientLayout roleLabel="Buyer">{children}</ClientLayout>;
  }

  if (groupId === 'seller') {
    return <ClientLayout roleLabel="Seller">{children}</ClientLayout>;
  }

  if (groupId === 'tc') {
    return <TCLayout>{children}</TCLayout>;
  }

  if (groupId === 'lending_partner') {
    // Self-contained placeholder — deliberately ignores `children` so no agent
    // page mounts under a lending_partner (see LendingPartnerLayout).
    return <LendingPartnerLayout />;
  }

  // Fallback
  return <AgentLayout>{children}</AgentLayout>;
}
