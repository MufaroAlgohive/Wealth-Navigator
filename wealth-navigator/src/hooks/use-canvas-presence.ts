"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseAuthConfigured } from "@/lib/supabase/config";
import { readPersonaCookie } from "@/lib/auth/store";

export interface RemoteCursor {
  clientId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  selectedNodeId: string | null;
  updatedAt: number;
}

export interface PresencePeer {
  clientId: string;
  name: string;
  color: string;
  onlineAt: number;
}

export interface CanvasPresenceApi {
  ready: boolean;
  available: boolean;
  peers: PresencePeer[];
  remoteCursors: RemoteCursor[];
  self: { clientId: string; name: string; color: string };
  publishCursor: (x: number, y: number, selectedNodeId?: string | null) => void;
  publishNodeMove: (nodeId: string, x: number, y: number) => void;
  onRemoteNodeMove: (handler: (nodeId: string, x: number, y: number, from: string) => void) => () => void;
}

const COLORS = ["#0d9488", "#0369a1", "#b45309", "#be123c", "#4d7c0f", "#7c3aed", "#0f766e"];

function hashHue(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

function makeClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultDisplayName(): string {
  const persona = readPersonaCookie();
  if (persona) {
    const pretty = persona.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return pretty.slice(0, 24);
  }
  if (typeof window === "undefined") return "Guest";
  try {
    const stored = localStorage.getItem("wn-canvas-display-name");
    if (stored?.trim()) return stored.trim().slice(0, 24);
  } catch {
    /* ignore */
  }
  const guest = `Guest ${Math.floor(100 + Math.random() * 900)}`;
  try {
    localStorage.setItem("wn-canvas-display-name", guest);
  } catch {
    /* ignore */
  }
  return guest;
}

const CURSOR_STALE_MS = 8_000;
const BROADCAST_MIN_MS = 90;
const BROADCAST_MIN_DIST = 4;

/**
 * Live multiplayer presence + cursors on `canvas:{canvasId}`.
 * Falls back to available=false when Supabase env is missing.
 */
export function useCanvasPresence(canvasId: string, enabled = true): CanvasPresenceApi {
  const clientIdRef = useRef(makeClientId());
  const name = useMemo(() => defaultDisplayName(), []);
  const color = useMemo(() => hashHue(clientIdRef.current + name), [name]);

  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastBroadcastRef = useRef(0);
  const lastCursorRef = useRef({ x: 0, y: 0 });
  const nodeMoveHandlers = useRef(new Set<(nodeId: string, x: number, y: number, from: string) => void>());

  useEffect(() => {
    if (!enabled || !canvasId) {
      setReady(true);
      setAvailable(false);
      return;
    }

    if (!isSupabaseAuthConfigured()) {
      setReady(true);
      setAvailable(false);
      return;
    }

    let cancelled = false;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase.channel(`canvas:${canvasId}`, {
      config: { presence: { key: clientIdRef.current } },
    });
    channelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      if (cancelled) return;
      const state = channel.presenceState() as Record<
        string,
        Array<{ name?: string; color?: string; online_at?: number }>
      >;
      const next: PresencePeer[] = [];
      for (const [id, metas] of Object.entries(state)) {
        if (id === clientIdRef.current) continue;
        const meta = metas[0];
        if (!meta) continue;
        next.push({
          clientId: id,
          name: meta.name ?? "Guest",
          color: meta.color ?? hashHue(id),
          onlineAt: meta.online_at ?? Date.now(),
        });
      }
      setPeers(next);
    });

    channel.on("broadcast", { event: "cursor" }, ({ payload }) => {
      if (cancelled || !payload || typeof payload !== "object") return;
      const p = payload as Partial<RemoteCursor> & { clientId?: string };
      if (!p.clientId || p.clientId === clientIdRef.current) return;
      if (typeof p.x !== "number" || typeof p.y !== "number") return;
      setRemoteCursors((prev) => {
        const next = prev.filter((c) => c.clientId !== p.clientId);
        next.push({
          clientId: p.clientId!,
          name: typeof p.name === "string" ? p.name : "Guest",
          color: typeof p.color === "string" ? p.color : hashHue(p.clientId!),
          x: p.x!,
          y: p.y!,
          selectedNodeId: typeof p.selectedNodeId === "string" ? p.selectedNodeId : null,
          updatedAt: Date.now(),
        });
        return next;
      });
    });

    channel.on("broadcast", { event: "node_move" }, ({ payload }) => {
      if (cancelled || !payload || typeof payload !== "object") return;
      const p = payload as { clientId?: string; nodeId?: string; x?: number; y?: number };
      if (!p.clientId || p.clientId === clientIdRef.current) return;
      if (!p.nodeId || typeof p.x !== "number" || typeof p.y !== "number") return;
      for (const h of nodeMoveHandlers.current) h(p.nodeId, p.x, p.y, p.clientId);
    });

    void channel.subscribe(async (status) => {
      if (cancelled) return;
      if (status === "SUBSCRIBED") {
        await channel.track({
          name,
          color,
          online_at: Date.now(),
        });
        setAvailable(true);
        setReady(true);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        setAvailable(false);
        setReady(true);
      }
    });

    const prune = window.setInterval(() => {
      const cutoff = Date.now() - CURSOR_STALE_MS;
      setRemoteCursors((prev) => prev.filter((c) => c.updatedAt >= cutoff));
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(prune);
      channelRef.current = null;
      void supabase.removeChannel(channel);
      setPeers([]);
      setRemoteCursors([]);
    };
  }, [canvasId, color, enabled, name]);

  const publishCursor = useCallback((x: number, y: number, selectedNodeId: string | null = null) => {
    const ch = channelRef.current;
    if (!ch) return;
    const now = Date.now();
    if (now - lastBroadcastRef.current < BROADCAST_MIN_MS) return;
    const dx = x - lastCursorRef.current.x;
    const dy = y - lastCursorRef.current.y;
    if (dx * dx + dy * dy < BROADCAST_MIN_DIST * BROADCAST_MIN_DIST) return;
    lastBroadcastRef.current = now;
    lastCursorRef.current = { x, y };
    void ch.send({
      type: "broadcast",
      event: "cursor",
      payload: {
        clientId: clientIdRef.current,
        name,
        color,
        x,
        y,
        selectedNodeId,
      },
    });
  }, [color, name]);

  const publishNodeMove = useCallback((nodeId: string, x: number, y: number) => {
    const ch = channelRef.current;
    if (!ch) return;
    void ch.send({
      type: "broadcast",
      event: "node_move",
      payload: {
        clientId: clientIdRef.current,
        nodeId,
        x,
        y,
      },
    });
  }, []);

  const onRemoteNodeMove = useCallback(
    (handler: (nodeId: string, x: number, y: number, from: string) => void) => {
      nodeMoveHandlers.current.add(handler);
      return () => {
        nodeMoveHandlers.current.delete(handler);
      };
    },
    [],
  );

  return {
    ready,
    available,
    peers,
    remoteCursors,
    self: { clientId: clientIdRef.current, name, color },
    publishCursor,
    publishNodeMove,
    onRemoteNodeMove,
  };
}
