"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "@/utils/supabase/client";

/**
 * Email + password sign-in. Invite-only launch: there's no sign-up form — accounts are
 * created by invite in the Supabase dashboard. On success the middleware lets the user
 * through to the app.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const supabase = getSupabaseClient();
    if (!supabase) {
      setError("Auth is not configured (no Supabase env).");
      return;
    }
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f1117] px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-[#1a1f2e] p-8 shadow-2xl">
        <p className="mb-1 text-center text-xs font-semibold uppercase tracking-widest text-slate-500">
          MyLibrary
        </p>
        <h1 className="mb-6 text-center text-xl font-bold text-white">Sign in</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Email
            </label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-600 focus:outline-none"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-600 focus:outline-none"
              placeholder="••••••••"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className={[
              "w-full rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all",
              loading
                ? "cursor-not-allowed bg-blue-700 opacity-60"
                : "bg-blue-600 hover:bg-blue-500 active:scale-95",
            ].join(" ")}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-500">
          Invite-only. Ask the admin for an account.
        </p>
      </div>
    </div>
  );
}
