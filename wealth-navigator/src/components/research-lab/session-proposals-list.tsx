"use client";

import { MinusCircle, PlusCircle, X } from "lucide-react";
import { GlassBadge } from "@/components/oems/primitives/glass";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/oems/primitives/pill";
import type { SessionProposal } from "@/lib/research-lab/types";

interface SessionProposalsListProps {
  proposals: SessionProposal[];
  onRemove: (id: string) => void;
  compact?: boolean;
}

export function SessionProposalsList({ proposals, onRemove, compact }: SessionProposalsListProps) {
  if (proposals.length === 0) return null;

  return (
    <ul className={compact ? "space-y-2" : "glass-inset divide-y divide-[hsl(var(--glass-border))] overflow-hidden"}>
      {proposals.map((p) => (
        <li
          key={p.id}
          className={
            compact
              ? "glass-inset flex flex-wrap items-start justify-between gap-2 p-3"
              : "flex flex-wrap items-start justify-between gap-3 px-4 py-3"
          }
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {p.action === "add" ? (
                <PlusCircle className="h-3.5 w-3.5 text-primary" />
              ) : (
                <MinusCircle className="h-3.5 w-3.5 text-down" />
              )}
              <span className="font-mono text-sm font-semibold text-primary">{p.ticker}</span>
              <Pill tone={p.action === "add" ? "success" : "destructive"} size="xs">
                {p.action === "add" ? "ADD" : "REMOVE"}
              </Pill>
              <Pill tone={p.status === "submitted" ? "warning" : "neutral"} size="xs">
                {p.status}
              </Pill>
            </div>
            <p className="text-caption">
              {p.shares} shares · {p.name}
            </p>
            {!compact && (
              <>
                <p className="text-sm leading-relaxed text-foreground/90">{p.thesis}</p>
                {p.saleTrigger && (
                  <p className="text-caption">
                    <span className="font-medium">Sale trigger:</span> {p.saleTrigger}
                  </p>
                )}
              </>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => onRemove(p.id)}
            aria-label={`Remove proposal for ${p.ticker}`}
          >
            <X className="h-4 w-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

interface ProposalActionBarProps {
  onAdd: () => void;
  onRemove: () => void;
  proposalCount: number;
}

export function ProposalActionBar({ onAdd, onRemove, proposalCount }: ProposalActionBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        className="gap-1.5 bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)] hover:bg-primary/90"
        onClick={onAdd}
      >
        <PlusCircle className="h-4 w-4" />
        Add stock
      </Button>
      <Button type="button" size="sm" variant="outline" className="glass-inset gap-1.5 border-0" onClick={onRemove}>
        <MinusCircle className="h-4 w-4" />
        Remove stock
      </Button>
      {proposalCount > 0 && (
        <GlassBadge tone={proposalCount > 0 ? "primary" : "neutral"}>
          {proposalCount} session proposal{proposalCount === 1 ? "" : "s"}
        </GlassBadge>
      )}
    </div>
  );
}
