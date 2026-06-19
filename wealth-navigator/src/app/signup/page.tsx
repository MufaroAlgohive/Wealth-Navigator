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

export default function SignupPage() {
  const router = useRouter();
  const [phase, setPhase] = React.useState<"checking" | "ready" | "invalid">("checking");
  const [email, setEmail] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState("");
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      // The invite magic-link routes through /auth/callback which sets the
      // session; poll briefly for it to settle.
      const supabase = createSupabaseBrowserClient();
      for (let i = 0; i < 12; i++) {
        const { data } = await supabase.auth.getSession();
        if (!alive) return;
        if (data.session?.user) {
          setEmail(data.session.user.email || "");
          setPhase("ready");
          return;
        }
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
      const { error: upErr } = await supabase.auth.updateUser({ password, data: { full_name: fullName.trim() } });
      if (upErr) throw upErr;
      await fetch("/api/admin/complete-signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: fullName.trim() }) });
      await supabase.auth.signOut();
      toast.success("Account created — sign in to continue.");
      router.push(`/login?reason=signup-success&email=${encodeURIComponent(email)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create account.");
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas p-4 sm:p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-xl">
        <h1 className="text-xl font-semibold tracking-tight">Create your Mint admin account</h1>

        {phase === "checking" && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Verifying your invitation…</p>}

        {phase === "invalid" && (
          <div className="mt-4">
            <p className="text-sm text-muted-foreground">This invitation link is invalid or has expired.</p>
            <Link href="/login" className="mt-4 inline-block text-sm text-primary underline">Back to sign in</Link>
          </div>
        )}

        {phase === "ready" && (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <div className="space-y-1.5"><Label>Email</Label><Input value={email} disabled className="h-9" /></div>
            <div className="space-y-1.5"><Label htmlFor="su-name">Full name</Label><Input id="su-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required placeholder="Jane Smith" className="h-9" /></div>
            <div className="space-y-1.5"><Label htmlFor="su-pw">Password</Label><Input id="su-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" className="h-9" /></div>
            <div className="space-y-1.5"><Label htmlFor="su-pw2">Confirm password</Label><Input id="su-pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" className="h-9" /></div>
            {error && <div className="rounded-lg bg-destructive/15 px-3 py-2 text-sm text-destructive">{error}</div>}
            <Button type="submit" className="h-10 w-full" disabled={pending}>{pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating account…</> : "Create account"}</Button>
            <Link href="/login" className="block text-center text-sm text-muted-foreground hover:text-foreground">Already have an account? Sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}
