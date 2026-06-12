"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseAuthConfigured } from "@/lib/supabase/config";

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending || sent) return;

    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;

    if (!isSupabaseAuthConfigured()) {
      toast.error("Password reset unavailable", {
        description: "Authentication is not configured for this environment.",
      });
      return;
    }

    setPending(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=/login`;
      const { error } = await supabase.auth.resetPasswordForEmail(trimmed, { redirectTo });
      if (error) throw error;
      setSent(true);
      toast.success("Check your email", {
        description: "If an account exists, a reset link has been sent.",
      });
    } catch (err) {
      toast.error("Could not send reset email", {
        description: err instanceof Error ? err.message : "Try again later.",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas p-4 sm:p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-xl">
        <Link
          href="/login"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to sign in
        </Link>

        <h1 className="text-xl font-semibold tracking-tight">Reset password</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Enter your work email. We&apos;ll send a secure link to choose a new password.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="forgot-email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="forgot-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={pending || sent}
                className="h-9 pl-8"
              />
            </div>
          </div>

          <Button type="submit" className="h-10 w-full" disabled={pending || sent}>
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Sending…
              </>
            ) : sent ? (
              "Email sent"
            ) : (
              "Send reset link"
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
