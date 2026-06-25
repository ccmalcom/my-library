"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { api, type Stats } from "@/lib/api";
import SetupWizard from "@/components/SetupWizard";

// Routes that are useless without a library — show the setup wizard INLINE here when the
// logged-in user has none yet, instead of redirecting to /setup. Profile, to-read, and
// settings are intentionally NOT gated (settings in particular must stay reachable so a user
// can add their Anthropic API key before profiling).
const GATED = new Set(["/", "/swipe", "/library"]);

function GateSpinner() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <svg className="h-6 w-6 animate-spin text-slate-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </div>
  );
}

/**
 * Gates the library-consuming routes behind having a library. On a gated route, if the user's
 * stats show zero books, it renders <SetupWizard> in place (within the main shell — navbar
 * stays) rather than the page. Otherwise it renders the page.
 *
 * The decision is LATCHED: we pick "setup" vs "ready" once, the first time stats are known,
 * and don't flip afterward. That matters because the wizard ingests books mid-flow (total goes
 * 0 → N after the upload step); without latching, the gate would see total > 0 and swap the
 * wizard out before the user reached enrich/profile. The wizard calls `onComplete` at its final
 * step to move us to "ready" deliberately.
 */
export default function LibraryGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const gated = GATED.has(pathname);

  // Shares the "stats" SWR key with the dashboard, so no duplicate fetch.
  const { data: stats, isLoading } = useSWR<Stats>("stats", () => api.stats());
  const [mode, setMode] = useState<"loading" | "setup" | "ready">("loading");

  useEffect(() => {
    if (mode !== "loading") return; // decide once, then latch
    if (isLoading || stats == null) return;
    setMode(stats.total === 0 ? "setup" : "ready");
  }, [isLoading, stats, mode]);

  if (!gated) return <>{children}</>;
  if (mode === "loading") return <GateSpinner />;
  if (mode === "setup") return <SetupWizard onComplete={() => setMode("ready")} />;
  return <>{children}</>;
}
