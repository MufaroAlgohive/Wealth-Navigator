"use client";

/**
 * SkipLink — keyboard-only "Skip to main content" link.
 *
 * The link is visually hidden by default and pops into the top-left of
 * the page the first time a keyboard user presses Tab. The target is
 * `#main-content`; the OEMS shell's `<main>` carries that id.
 *
 * Placement matters: this MUST be the first focusable element in the
 * OEMS tree (it's rendered before `<OEMSShell>` in `app/oems/layout.tsx`)
 * so that a fresh page-load, the first Tab keystroke focuses the skip
 * link rather than the top bar's brand chip or the side nav.
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="absolute top-2 left-2 z-50 -translate-y-16 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground shadow-lg transition-transform duration-150 focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
    >
      Skip to main content
    </a>
  );
}
