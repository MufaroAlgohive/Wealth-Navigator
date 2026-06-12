"use client";

/**
 * Production sign-in — split-screen layout with a focused email/password form.
 * Authenticates via Supabase Auth through `/api/auth/login`.
 */

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notifyAuthChange } from "@/lib/auth/store";
import { cn } from "@/lib/cn";

interface LoginResponse {
  ok: boolean;
  error?: string;
  user?: { email: string };
}

async function postLogin(payload: { email: string; password: string }): Promise<LoginResponse> {
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
  photos?: LoginPhoto[];
  rotationMs?: number;
  heading?: string;
  subheading?: string;
}

const DEFAULT_PHOTOS: LoginPhoto[] = [
  { src: "/login/abuti-221.jpg", alt: "Professional event photography" },
];

const LoginOne: React.FC<LoginOneProps> = ({
  photos = DEFAULT_PHOTOS,
  rotationMs = 0,
  heading = "Sign in",
  subheading = "Enter your credentials to continue.",
}) => {
  const router = useRouter();
  const searchParams = useSearchParams();

  const nextPath = React.useMemo(() => {
    const raw = searchParams.get("next");
    if (!raw) return "/oems";
    if (!raw.startsWith("/") || raw.startsWith("//")) return "/oems";
    return raw;
  }, [searchParams]);

  const callbackError = searchParams.get("error");

  React.useEffect(() => {
    if (callbackError === "auth_callback_failed") {
      toast.error("Sign-in link expired", {
        description: "Request a new link or sign in with your password.",
      });
    }
  }, [callbackError]);

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);

  const [mouse, setMouse] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hovering, setHovering] = React.useState(false);
  const handleMouseMove = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMouse({ x: e.clientX - r.left, y: e.clientY - r.top });
  }, []);

  const shouldRotate = photos.length > 1 && rotationMs > 0;
  const [photoIndex, setPhotoIndex] = React.useState(0);
  const [hoveringPhoto, setHoveringPhoto] = React.useState(false);
  React.useEffect(() => {
    if (!shouldRotate || hoveringPhoto) return;
    const id = window.setInterval(() => {
      setPhotoIndex((i) => (i + 1) % photos.length);
    }, rotationMs);
    return () => window.clearInterval(id);
  }, [shouldRotate, rotationMs, photos.length, hoveringPhoto]);
  const activePhoto = photos[photoIndex] ?? photos[0] ?? DEFAULT_PHOTOS[0];

  const login = useMutation({
    mutationFn: postLogin,
    onSuccess: (data) => {
      notifyAuthChange();
      const first = data.user?.email?.split("@")[0] ?? "there";
      toast.success("Signed in", { description: `Welcome back, ${first}.` });
      router.replace(nextPath as Parameters<typeof router.replace>[0]);
    },
    onError: (err: Error) => {
      toast.error("Sign-in failed", { description: err.message });
    },
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (login.isPending) return;
    login.mutate({ email: email.trim().toLowerCase(), password });
  };

  return (
    <div
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl",
        "lg:flex-row",
        "min-h-[440px]",
      )}
    >
      <div
        onMouseMove={handleMouseMove}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className="relative flex w-full flex-col justify-center overflow-hidden bg-card px-6 py-10 sm:px-10 lg:w-1/2 lg:px-14 lg:py-12"
      >
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
              "radial-gradient(circle, hsl(var(--primary) / 0.16) 0%, hsl(var(--primary) / 0.06) 45%, transparent 70%)",
          }}
        />

        <div className="relative z-10 mx-auto w-full max-w-md">
          <Brand />

          <div className="mb-6 mt-8 space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
            <p className="text-sm text-muted-foreground">{subheading}</p>
          </div>

          <form onSubmit={submit} className="space-y-4" noValidate={false}>
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Email</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="login-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={login.isPending}
                  className="h-10 pl-8 text-[13px]"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="login-password">Password</Label>
                <Link
                  href="/login/forgot"
                  className="text-[11px] font-medium text-primary/80 transition-colors hover:text-primary"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={login.isPending}
                  className="h-10 pl-8 pr-9 text-[13px]"
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

          <p className="mt-8 text-center text-[10px] leading-relaxed text-muted-foreground/80">
            Unauthorised access is prohibited. Activity on this system may be monitored
            and recorded.
          </p>
        </div>
      </div>

      <div
        className="relative hidden w-full overflow-hidden bg-surface lg:block lg:w-1/2"
        onMouseEnter={() => setHoveringPhoto(true)}
        onMouseLeave={() => setHoveringPhoto(false)}
      >
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

        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-l from-transparent via-black/10 to-black/50"
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/15"
        />
      </div>
    </div>
  );
};

function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary to-primary/50 text-primary-foreground shadow-sm">
        <Sparkles className="h-4 w-4" />
      </span>
      <span className="text-sm font-semibold tracking-tight">Mint Wealth Navigator</span>
    </span>
  );
}

export default LoginOne;
