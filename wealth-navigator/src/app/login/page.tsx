import LoginOne from "@/components/login-1";

/**
 * /login — split-screen sign-in.
 *
 * The actual form, persona picker, mouse-driven sheen, and decorative
 * right-hand photo all live in `<LoginOne />` (the 21st.dev-derived
 * component). This page is intentionally thin so the visual update is
 * easy to revert: swap the import for the previous client component and
 * drop the wrapper.
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas p-4 sm:p-6">
      <LoginOne
        photos={[
          { src: "/login/abuti-221.jpg", alt: "Abuti at a formal event" },
          { src: "/login/abuti-226.jpg", alt: "Abuti at a formal event" },
        ]}
        rotationMs={7000}
      />
    </div>
  );
}
