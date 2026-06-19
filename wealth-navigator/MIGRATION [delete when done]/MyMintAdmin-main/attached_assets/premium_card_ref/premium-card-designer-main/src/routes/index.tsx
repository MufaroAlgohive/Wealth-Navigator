import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Index,
});

// IMPORTANT: Replace this placeholder. For sites with multiple pages (About, Services, Contact, etc.),
// create separate route files (about.tsx, services.tsx, contact.tsx) — don't put all pages in this file.
function Index() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#070713] text-white px-6">
      <div className="max-w-md text-center">
        <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-b from-white to-slate-400 bg-clip-text text-transparent">
          Mint
        </h1>
        <p className="mt-3 text-sm text-slate-400">Premium fintech factsheets demo</p>
        <Link
          to="/factsheets"
          className="mt-8 inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-violet-500 to-indigo-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/30 transition hover:scale-[1.03]"
        >
          Open Factsheets →
        </Link>
      </div>
    </div>
  );
}
