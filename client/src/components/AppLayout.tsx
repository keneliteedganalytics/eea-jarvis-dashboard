import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { CardWithRaces } from "@shared/schema";
import { ScopeLogo } from "@/components/brand/ScopeLogo";
import { Wordmark } from "@/components/brand/Wordmark";
import { HostAvatars } from "@/components/brand/HostAvatars";
import { cn } from "@/lib/utils";
import {
  LayoutGrid,
  Crosshair,
  ClipboardCheck,
  TrendingUp,
  Archive,
  Users,
  Film,
  Settings as SettingsIcon,
  Menu,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const NAV = [
  { href: "/", label: "Today's Card", icon: LayoutGrid, testid: "nav-card" },
  { href: "/race/1", label: "Race Detail", icon: Crosshair, testid: "nav-race", match: "/race" },
  { href: "/results", label: "Results", icon: ClipboardCheck, testid: "nav-results" },
  { href: "/analytics", label: "Analytics", icon: TrendingUp, testid: "nav-analytics" },
  { href: "/historical", label: "Historical", icon: Archive, testid: "nav-historical", match: "/historical" },
  { href: "/show", label: "Daily Show", icon: Film, testid: "link-daily-show" },
  { href: "/about", label: "Meet the Team", icon: Users, testid: "link-about" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, testid: "nav-settings" },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  return (
    <nav className="flex flex-col gap-1 px-3">
      {NAV.map((item) => {
        const active =
          item.match != null ? location.startsWith(item.match) : location === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            data-testid={item.testid}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-gold/12 text-gold-light border border-gold/25"
                : "text-slate-brand hover:text-silver hover:bg-white/[0.03] border border-transparent",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarFooter() {
  const { data: card } = useQuery<CardWithRaces>({ queryKey: ["/api/cards/latest"] });
  if (!card) return null;
  return (
    <div className="mt-auto px-5 py-4 border-t border-gold/10">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold">
        Active Card
      </div>
      <div className="mt-1 text-sm text-silver" data-testid="text-footer-card">
        {card.track} · {card.date}
      </div>
      <div className="mt-1 text-[11px] text-muted-brand">
        Conviction:{" "}
        <span className="text-gold tabular-nums">{card.cardConviction}</span>
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 py-5 border-b border-gold/10">
        <ScopeLogo size={40} />
        <Wordmark />
        <HostAvatars size={40} className="ml-auto" />
      </div>
      <div className="py-4 flex-1 flex flex-col">
        <NavItems onNavigate={() => setMobileOpen(false)} />
        <SidebarFooter />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 shrink-0 border-r border-gold/10 bg-navy-card flex-col fixed inset-y-0 left-0 z-30">
        {sidebar}
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-3 px-4 h-14 border-b border-gold/10 bg-navy-card">
        <Button
          size="icon"
          variant="ghost"
          className="text-gold"
          onClick={() => setMobileOpen((o) => !o)}
          data-testid="button-mobile-menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <ScopeLogo size={28} />
        <Wordmark showSubtitle={false} />
        <HostAvatars size={32} className="ml-auto" />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-navy-card border-r border-gold/10">
            {sidebar}
          </aside>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 md:ml-64 pt-14 md:pt-0 min-w-0">{children}</main>
    </div>
  );
}
