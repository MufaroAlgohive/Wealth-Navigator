import { Suspense } from "react";

import LoginOne from "@/components/login-1";

export const dynamic = "force-dynamic";

function LoginFallback() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas p-4 sm:p-6">
      <div className="h-[440px] w-full max-w-5xl animate-pulse rounded-2xl border border-border bg-card" />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <div className="flex min-h-screen w-full items-center justify-center bg-canvas p-4 sm:p-6">
        <LoginOne
          photos={[
            { src: "/login/abuti-221.jpg", alt: "Professional event photography" },
            { src: "/login/abuti-226.jpg", alt: "Professional event photography" },
          ]}
          rotationMs={7000}
        />
      </div>
    </Suspense>
  );
}
