import { Link } from "wouter";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { JARVIS, SCARLETT, type Host } from "@/lib/hosts";
import { cn } from "@/lib/utils";

function Avatar({ host, size, overlap, testid }: { host: Host; size: number; overlap?: boolean; testid: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href="/about"
          data-testid={testid}
          aria-label={`${host.name} — Meet the Team`}
          className={cn(
            "block shrink-0 rounded-full ring-1 ring-gold/60 overflow-hidden bg-navy-section transition-transform hover:scale-105 hover:ring-gold-light focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-light",
            overlap && "-ml-2",
          )}
          style={{ width: size, height: size }}
        >
          <img
            src={host.img}
            alt={host.name}
            width={size}
            height={size}
            loading="eager"
            className="h-full w-full object-cover object-top"
          />
        </Link>
      </TooltipTrigger>
      <TooltipContent>{host.name}</TooltipContent>
    </Tooltip>
  );
}

// Paired circular host avatars for the top bar. Slight overlap so they read as a duo.
export function HostAvatars({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <div className={cn("flex items-center", className)} aria-label="Meet the hosts">
      <Avatar host={JARVIS} size={size} testid="avatar-jarvis-header" />
      <Avatar host={SCARLETT} size={size} overlap testid="avatar-scarlett-header" />
    </div>
  );
}
