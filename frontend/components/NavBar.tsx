"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { authEnabled, getSupabaseClient } from "@/utils/supabase/client";

const links = [
  { href: "/", label: "Home" },
  { href: "/swipe", label: "Swipe" },
  { href: "/library", label: "My Library" },
  { href: "/profile", label: "My Profile" },
  { href: "/settings", label: "Settings" },
];

export default function NavBar() {
  const pathname = usePathname();

  async function handleSignOut() {
    const supabase = getSupabaseClient();
    if (supabase) await supabase.auth.signOut();
    // Full document load so the signed-out user's SWR cache + component state is discarded
    // (prevents the next user who signs in from briefly seeing stale cached data).
    window.location.assign("/login");
  }

  return (
    <nav className="sticky top-0 z-50 border-b border-slate-800 bg-[#0f1117]/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
        <span className="text-sm font-semibold tracking-widest text-slate-400 uppercase">
          MyLibrary
        </span>
        <div className="flex gap-1">
          {links.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={[
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-slate-700 text-white"
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                ].join(" ")}
              >
                {label}
              </Link>
            );
          })}
          {authEnabled && (
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-red-300"
            >
              Sign out
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
