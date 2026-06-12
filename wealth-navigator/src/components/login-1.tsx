"use client";

/**
 * LoginOne — split-screen institutional sign-in, based on the
 * `abishek1512/login-1` 21st.dev component. The decorative split was kept
 * (form on the left, photo on the right) but the body was rewritten to
 * wire into the existing `/api/auth/login` mock auth route, the six demo
 * personas from the session store, and a toast on failure. The photos
 * are pure decoration — the form is the focus and remains fully
 * functional even if every image 404s.
 */

import * as React from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Building2,
  Briefcase,
  Eye,
  EyeOff,
  HeartPulse,
  HelpCircle,
  LineChart,
  Loader2,
  Lock,
  Mail,
  Shield,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/oems/primitives/pill";
import { cn } from "@/lib/cn";
import {
  PERSONA_USERS,
  useSetPersona,
  type Persona,
} from "@/lib/store/session-provider";

const PERSONA_HOME: Record<Persona, string> = {
  oems: "/oems",
  strategist: "/strategist",
  wealth_manager: "/wm",
  admin: "/admin",
  business: "/business",
  funeral_cover: "/fc/overview",
};

interface LoginResponse {
  ok: boolean;
  error?: string;
  user?: { username: string };
  persona?: Persona | null;
}

async function postLogin(payload: {
  username: string;
  password: string;
  persona?: Persona;
}): Promise<LoginResponse> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as LoginResponse;
  if (!res.ok) {
    throw new Error(data.error ?? "Sign-in failed");
  }
  return data;
}

export interface LoginPhoto {
  src: string;
  alt: string;
}

export interface LoginOneProps {
  /** Decorative photos rendered in the right-hand panel. Defaults to the
   * `abuti-221.jpg` asset. When more than one is supplied, the panel
   * cycles through them on a `rotationMs` timer. */
  photos?: LoginPhoto[];
  /** Time (ms) between photo swaps. Set to `0` to disable rotation. */
  rotationMs?: number;
  /** Optional headline shown above the form (left panel). */
  heading?: string;
  /** Optional supporting copy under the headline. */
  subheading?: string;
}

const DEFAULT_PHOTOS: LoginPhoto[] = [
  { src: "/login/abuti-221.jpg", alt: "Abuti at a formal event" },
];

const LoginOne: React.FC<LoginOneProps> = ({
  photos = DEFAULT_PHOTOS,
  rotationMs = 0,
  heading = "Sign in",
  subheading = "Authorised personnel only. Every session is logged.",
}) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setPersona = useSetPersona();

  // Honour the `?next=` redirect that middleware appends when it bounces
  // an unauthenticated user. Only accept same-origin paths so a hostile
  // link cannot turn into an open redirect.
  const nextPath = React.useMemo(() => {
    const raw = searchParams.get("next");
    if (!raw) return "/oems";
    if (!raw.startsWith("/") || raw.startsWith("//")) return "/oems";
    return raw;
  }, [searchParams]);

  const [username, setUsername] = React.useState("admin");
  const [password, setPassword] = React.useState("admin");
  const [showPassword, setShowPassword] = React.useState(false);

  // Mouse-tracking on the left panel drives a single, very subtle bloom
  // — institutional polish, not marketing sparkle. Kept from the
  // 21st.dev original because it adds depth without dominating the eye.
  const [mouse, setMouse] = React.useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [hovering, setHovering] = React.useState(false);
  const leftRef = React.useRef<HTMLDivElement | null>(null);
  const handleMouseMove = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setMouse({ x: e.clientX - r.left, y: e.clientY - r.top });
    },
    [],
  );

  // Photo rotation — opt-in. Only runs when at least two photos are
  // supplied and `rotationMs > 0`. The interval pauses on hover so a
  // reader can actually study a frame.
  const shouldRotate = photos.length > 1 && rotationMs > 0;
  const [photoIndex, setPhotoIndex] = React.useState(0);
  React.useEffect(() => {
    if (!shouldRotate) return;
    if (hovering) return;
    const id = window.setInterval(() => {
      setPhotoIndex((i) => (i + 1) % photos.length);
    }, rotationMs);
    return () => window.clearInterval(id);
  }, [shouldRotate, rotationMs, photos.length, hovering]);
  const activePhoto = photos[photoIndex] ?? photos[0] ?? DEFAULT_PHOTOS[0];

  const login = useMutation({
    mutationFn: postLogin,
    onSuccess: (data, variables) => {
      const persona = (data.persona ??
        variables.persona ??
        null) as Persona | null;
      if (persona) setPersona(persona);
      const dest = persona && persona !== "oems" ? PERSONA_HOME[persona] : nextPath;
      const description = persona
        ? `Welcome back, ${PERSONA_USERS[persona].name.split(" ")[0]}.`
        : "Welcome back.";
      toast.success("Signed in", { description });
      // `dest` is a same-origin path; the typed-routes check is overly
      // strict for the dynamic `?next=` redirect target, so cast.
      router.replace(dest as Parameters<typeof router.replace>[0]);
    },
    onError: (err: Error) => {
      toast.error("Sign-in failed", { description: err.message });
    },
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (login.isPending) return;
    login.mutate({ username: username.trim(), password });
  };

  return (
    <div
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl",
        "lg:flex-row",
        "min-h-[440px]",
      )}
    >
      {/* ── Left panel — sign-in form ─────────────────────────────────── */}
      <div
        ref={leftRef}
        onMouseMove={handleMouseMove}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className="relative flex w-full flex-col justify-center overflow-hidden bg-card px-6 py-10 sm:px-10 lg:w-1/2 lg:px-14 lg:py-12"
      >
        {/* The mouse-driven bloom is rendered here as a positioned div so
            it never affects layout. Low-opacity so it reads as
            "institutional sheen" not "marketing glow". */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl transition-opacity duration-300",
            hovering ? "opacity-100" : "opacity-0",
          )}
          style={{
            left: mouse.x,
            top: mouse.y,
            width: 520,
            height: 520,
            background:
              "radial-gradient(circle, hsl(var(--primary) / 0.18) 0%, hsl(var(--info) / 0.10) 40%, transparent 70%)",
          }}
        />

        <div className="relative z-10 mx-auto w-full max-w-md">
          <div className="mb-7 flex items-center justify-between">
            <Brand />
            <Pill tone="info" size="xs" dot>
              SSO · IRESS
            </Pill>
          </div>

          <div className="mb-6 space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
            <p className="text-sm text-muted-foreground">{subheading}</p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="login-username" className="text-muted-foreground">
                Email or IRESS user code
              </Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="login-username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  required
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder="admin"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={login.isPending}
                  className="h-9 pl-8 font-mono text-[13px]"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="login-password" className="text-muted-foreground">
                  Password
                </Label>
                <button
                  type="button"
                  className="text-[11px] font-medium text-primary/80 transition-colors hover:text-primary"
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  placeholder="admin"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={login.isPending}
                  className="h-9 pl-8 pr-9 font-mono text-[13px] tracking-wider"
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showPassword ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              size="lg"
              className="h-10 w-full text-sm font-semibold"
              disabled={login.isPending}
            >
              {login.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
                </>
              ) : (
                <>
                  Sign in <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </form>

          <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
            <HelpCircle className="h-3 w-3" />
            <span>
              Need access?{" "}
              <button
                type="button"
                className="font-medium text-primary/80 transition-colors hover:text-primary"
              >
                Contact your compliance officer
              </button>
            </span>
          </div>

          <p
            className="mt-1.5 font-mono text-[10px] text-muted-foreground/70"
            aria-label="Default credentials"
          >
            Default: admin / admin
          </p>

          <p className="mt-5 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            Mint Wealth Navigator · IRESS V4 wired · session secured
          </p>
        </div>
      </div>

      {/* ── Right panel — decorative photo ────────────────────────────── */}
      <div className="relative hidden w-full overflow-hidden bg-surface lg:block lg:w-1/2">
        {/* The image is purely decorative — `alt` is present, the form
            has its own labels, and a load failure only blanks this
            panel. The form stays fully usable. */}
        {activePhoto ? (
          <Image
            key={activePhoto.src}
            src={activePhoto.src}
            alt={activePhoto.alt}
            fill
            priority
            sizes="(min-width: 1024px) 50vw, 100vw"
            className="object-cover"
          />
        ) : null}

        {/* Gradient overlay: a slight darken across the whole frame, and
            a stronger shadow on the left edge so the form side stays the
            visual focus even if the photo is light. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-l from-transparent via-black/10 to-black/55"
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-black/20"
        />

        {/* Top-right corner watermark */}
        <div className="absolute right-6 top-6 z-10">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/60">
            IRESS · JSE · Live
          </span>
        </div>
      </div>
    </div>
  );
};

function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-primary to-primary/40 text-primary-foreground">
        <Sparkles className="h-4 w-4" />
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,_white_0%,_transparent_60%)] opacity-30" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold tracking-tight">
          Mint Wealth Navigator
        </span>
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">
          v2.0 · institutional
        </span>
      </span>
    </span>
  );
}

export default LoginOne;
