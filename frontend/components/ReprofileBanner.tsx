"use client";

import { useState } from "react";
import useSWR from "swr";
import { api, PROFILE_STATUS_KEY, type ProfileStatus } from "@/lib/api";

/**
 * App-wide banner that appears only when the taste profile is stale — i.e. the user
 * has re-rated or reviewed books since the profile was last built. Re-profiling is
 * never automatic; this is the explicit "trigger re-profile" control.
 *
 * It shares PROFILE_STATUS_KEY with the edit modal, so saving a rating/review makes
 * the banner pop up immediately (the modal revalidates that key).
 */
export default function ReprofileBanner() {
  const { data: status } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY, () =>
    api.profileStatus()
  );
  const { mutate } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status?.dirty) return null;

  async function handleReprofile() {
    setRunning(true);
    setError(null);
    try {
      await api.updateProfile();
      await mutate(); // profile now fresh -> dirty flips false -> banner hides
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-profile failed.");
      setRunning(false);
    }
  }

  const n = status.changed_books;

  return (
    <div className="border-b border-amber-800/50 bg-amber-950/40">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <p className="text-sm text-amber-200">
          <span className="font-semibold">Taste profile out of date.</span>{" "}
          {n} book{n !== 1 ? "s" : ""} changed since the last build.
          {error && <span className="ml-2 text-red-400">{error}</span>}
        </p>
        <button
          type="button"
          onClick={handleReprofile}
          disabled={running}
          className={[
            "inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-semibold text-slate-900 transition-all",
            running
              ? "cursor-not-allowed bg-amber-600 opacity-70"
              : "bg-amber-400 hover:bg-amber-300 active:scale-95",
          ].join(" ")}
        >
          {running ? (
            <>
              <Spinner />
              Re-profiling…
            </>
          ) : (
            "Re-profile"
          )}
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
