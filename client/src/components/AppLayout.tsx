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
  FlaskConical,
  LineChart,
  Archive,
  Users,
  Film,
  Globe,
  Settings as SettingsIcon,
  Menu,
  ChevronDown,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
// Active card summary as returned by the /api/cards list endpoint.
interface CardListItem {
  id: number;
  track: string;
  date: string;
  status: string;
}

// Today's date as YYYY-MM-DD in America/Boise so the track switcher matches
// cards stored as MDT calendar dates.
function boiseToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Boise",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const NAV = [
  { href: "/", label: "Today's Card", icon: LayoutGrid, testid: "nav-card" },
  { href: "/results", label: "Results", icon: ClipboardCheck, testid: "nav-results" },
  { href: "/analytics", label: "Analytics", icon: TrendingUp, testid: "nav-analytics" },
  { href: "/postmortem", label: "Postmortem", icon: FlaskConical, testid: "nav-postmortem" },
  { href: "/backtest", label: "Backtest", icon: LineChart, testid: "nav-backtest" },
  { href: "/historical", label: "Historical", icon: Archive, testid: "nav-historical", match: "/historical" },
  { href: "/show", label: "Daily Show", icon: Film, testid: "link-daily-show" },
  { href: "/about", label: "Meet the Team", icon: Users, testid: "link-about" },
  { href: "/track-record", label: "Track Record", icon: Globe, testid: "link-track-record" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, testid: "nav-settings" },
];

// Race Detail nav item — on multi-track days renders a dropdown of each
// active card so you can jump directly to /race/:cardId/1 for the chosen track
// instead of going through the legacy /race/1 (which always resolves to the
// backend's "latest" card and hides the other tracks).
function RaceDetailNavItem({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const active = location.startsWith("/race");
  const { data: activeCards = [] } = useQuery<CardListItem[]>({
    queryKey: ["/api/cards"],
  });
  const today = boiseToday();
  const todaysCards = activeCards.filter(
    (c) => c.status === "active" && c.date === today,
  );

  const itemClass = cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors w-full text-left",
    active
      ? "bg-gold/12 text-gold-light border border-gold/25"
      : "text-slate-brand hover:text-silver hover:bg-white/[0.03] border border-transparent",
  );

  if (todaysCards.length <= 1) {
    const href = todaysCards.length === 1 ? `/race/${todaysCards[0].id}/1` : "/race/1";
    return (
      <Link
        href={href}
        data-testid="nav-race"
        onClick={onNavigate}
        className={itemClass}
      >
        <Crosshair className="h-4 w-4 shrink-0" />
        <span>Race Detail</span>
      </Link>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="nav-race-trigger"
          className={itemClass}
        >
          <Crosshair className="h-4 w-4 shrink-0" />
          <span>Race Detail</span>
          <ChevronDown className="h-3.5 w-3.5 ml-auto shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right">
        {todaysCards.map((c) => (
          <DropdownMenuItem key={c.id} asChild>
            <Link
              href={`/race/${c.id}/1`}
              onClick={onNavigate}
              data-testid={`nav-race-card-${c.id}`}
            >
              {c.track}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  return (
    <nav className="flex flex-col gap-1 px-3">
      {/* Today's Card — always first */}
      <Link
        href="/"
        data-testid="nav-card"
        onClick={onNavigate}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          location === "/"
            ? "bg-gold/12 text-gold-light border border-gold/25"
            : "text-slate-brand hover:text-silver hover:bg-white/[0.03] border border-transparent",
        )}
      >
        <LayoutGrid className="h-4 w-4 shrink-0" />
        <span>Today's Card</span>
      </Link>

      {/* Race Detail — dropdown on multi-track days */}
      <RaceDetailNavItem onNavigate={onNavigate} />

      {NAV.filter((i) => i.href !== "/").map((item) => {
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
  const [location] = useLocation();
  // On /race/:cardId/:n, scope the footer to the card actually being viewed
  // (so multi-track days don't always show the backend's "latest" card here).
  const raceMatch = location.match(/^\/race\/(\d+)\/\d+$/);
  const explicitCardId = raceMatch ? parseInt(raceMatch[1], 10) : null;
  const key = explicitCardId
    ? [`/api/cards/${explicitCardId}`]
    : ["/api/cards/latest"];
  const { data: card } = useQuery<CardWithRaces>({ queryKey: key });
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
