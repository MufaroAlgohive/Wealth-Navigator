"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [phase, setPhase] = React.useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState("");
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      const supabase = createSupabaseBrowserClient();
      for (let i = 0; i < 10; i++) {
        const { data } = await supabase.auth.getSession();
        if (!alive) return;
        if (data.session?.user) { setPhase("ready"); return; }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (alive) setPhase("invalid");
    })();
    return () => { alive = false; };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setPending(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: upErr } = await supabase.auth.updateUser({ password });
      if (upErr) throw upErr;
      await supabase.auth.signOut();
      toast.success("Password updated — sign in with your new password.");
      router.push("/login?reason=reset-success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update password.");
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas p-4 sm:p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-xl">
        <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>

        {phase === "checking" && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Validating reset link…</p>}

        {phase === "invalid" && (
          <div className="mt-4">
            <p className="text-sm text-muted-foreground">This reset link is invalid or has expired.</p>
            <Link href="/login/forgot" className="mt-4 inline-block text-sm text-primary underline">Request a new link</Link>
          </div>
        )}

        {phase === "ready" && (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <div className="space-y-1.5"><Label htmlFor="rp-pw">New password</Label><Input id="rp-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" className="h-9" /></div>
            <div className="space-y-1.5"><Label htmlFor="rp-pw2">Confirm password</Label><Input id="rp-pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" className="h-9" /></div>
            {error && <div className="rounded-lg bg-destructive/15 px-3 py-2 text-sm text-destructive">{error}</div>}
            <Button type="submit" className="h-10 w-full" disabled={pending}>{pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Updating…</> : "Update password"}</Button>
            <Link href="/login" className="block text-center text-sm text-muted-foreground hover:text-foreground">Back to sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}
