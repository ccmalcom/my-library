"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { api, API_KEY_STATUS_KEY, PROFILE_STATUS_KEY, USER_PROFILE_KEY, type ApiKeyStatus, type UserProfile } from "@/lib/api";

/**
 * Settings — bring-your-own Anthropic API key.
 *
 * The key is sent once to the backend, encrypted at rest, and never read back (the status
 * endpoint only reports whether one is configured). Profile + recommend calls use it.
 */
/**
 * A two-step destructive action: the first click arms it (Cancel / Confirm), the second runs
 * `onRun`. Keeps the irreversible operations from firing on a single stray click.
 */
function DangerAction({
  title,
  description,
  buttonLabel,
  onRun,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  onRun: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setRunning(true);
    setError(null);
    try {
      await onRun();
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-red-900/40 bg-red-950/10 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-200">{title}</p>
        <p className="text-xs text-slate-500">{description}</p>
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={running}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:text-slate-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={running}
              className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-60"
            >
              {running ? "Working…" : "Yes, do it"}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-lg border border-red-800 px-3 py-2 text-sm font-medium text-red-300 transition hover:bg-red-900/30"
          >
            {buttonLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { data: status, isLoading } = useSWR<ApiKeyStatus>(
    API_KEY_STATUS_KEY,
    () => api.apiKeyStatus()
  );

  const { data: userProfile } = useSWR<UserProfile>(
    USER_PROFILE_KEY,
    () => api.getProfile()
  );

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Display name state
  const [nameInput, setNameInput] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  async function handleSaveName() {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    setNameSaving(true);
    setNameError(null);
    setNameSaved(false);
    try {
      await api.setProfile(trimmed);
      setNameInput("");
      setNameSaved(true);
      await mutate(USER_PROFILE_KEY);
    } catch (e) {
      setNameError(e instanceof Error ? e.message : "Failed to save name.");
    } finally {
      setNameSaving(false);
    }
  }

  const configured = status?.configured ?? false;

  async function handleSave() {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.setApiKey(key.trim());
      setKey("");
      setSaved(true);
      await mutate(API_KEY_STATUS_KEY);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save key.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.clearApiKey();
      await mutate(API_KEY_STATUS_KEY);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove key.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-1 text-2xl font-bold text-white">Settings</h1>
      <p className="mb-6 text-sm text-slate-400">
        MyLibrary uses your own Anthropic API key for the taste profile and recommendations.
      </p>

      {/* Display name */}
      <section className="mb-6 rounded-2xl border border-slate-700 bg-[#1a1f2e] p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Display name</h2>

        {userProfile?.display_name && (
          <p className="mb-3 text-sm text-slate-400">
            Currently: <span className="font-medium text-slate-200">{userProfile.display_name}</span>
          </p>
        )}

        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">
          {userProfile?.display_name ? "Update name" : "Set your name"}
        </label>
        <input
          type="text"
          value={nameInput}
          onChange={(e) => { setNameInput(e.target.value); setNameSaved(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") void handleSaveName(); }}
          placeholder={userProfile?.display_name ?? "e.g. Alex"}
          className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-600 focus:outline-none"
        />

        {nameError && <p className="mt-2 text-sm text-red-400">{nameError}</p>}
        {nameSaved && <p className="mt-2 text-sm text-emerald-400">Saved.</p>}

        <div className="mt-4">
          <button
            type="button"
            onClick={() => void handleSaveName()}
            disabled={nameSaving || !nameInput.trim()}
            className={[
              "rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all",
              nameSaving || !nameInput.trim()
                ? "cursor-not-allowed bg-blue-700 opacity-60"
                : "bg-blue-600 hover:bg-blue-500 active:scale-95",
            ].join(" ")}
          >
            {nameSaving ? "Saving..." : "Save name"}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-700 bg-[#1a1f2e] p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Anthropic API key</h2>
          {!isLoading && (
            <span
              className={[
                "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                configured
                  ? "bg-emerald-900/50 text-emerald-300"
                  : "bg-slate-700 text-slate-300",
              ].join(" ")}
            >
              {configured ? "Configured" : "Not set"}
            </span>
          )}
        </div>

        <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">
          {configured ? "Replace key" : "Add your key"}
        </label>
        <input
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setSaved(false);
          }}
          placeholder="sk-ant-…"
          autoComplete="off"
          className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 font-mono text-sm text-slate-200 placeholder-slate-600 focus:border-blue-600 focus:outline-none"
        />
        <p className="mt-2 text-xs text-slate-500">
          Stored encrypted on the server and never shown again. Get one at{" "}
          <a
            href="https://console.anthropic.com/"
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline"
          >
            console.anthropic.com
          </a>
          .
        </p>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        {saved && <p className="mt-3 text-sm text-emerald-400">Saved.</p>}

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !key.trim()}
            className={[
              "rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all",
              saving || !key.trim()
                ? "cursor-not-allowed bg-blue-700 opacity-60"
                : "bg-blue-600 hover:bg-blue-500 active:scale-95",
            ].join(" ")}
          >
            {saving ? "Saving…" : "Save key"}
          </button>
          {configured && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={saving}
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-red-300 disabled:opacity-50"
            >
              Remove key
            </button>
          )}
        </div>
      </section>

      {/* Danger zone — destructive, irreversible data removal. */}
      <section className="mt-8 rounded-2xl border border-red-900/50 bg-[#1a1f2e] p-6">
        <h2 className="text-lg font-semibold text-red-300">Danger zone</h2>
        <p className="mb-4 mt-1 text-sm text-slate-400">
          These permanently delete your data and can&apos;t be undone.
        </p>

        <div className="space-y-3">
          <DangerAction
            title="Reset taste profile"
            description="Deletes your taste traits and recommendations. Your books stay — rebuild the profile anytime."
            buttonLabel="Reset profile"
            onRun={async () => {
              await api.clearProfile();
              await Promise.all([
                mutate("profile", [], { revalidate: false }),
                mutate(PROFILE_STATUS_KEY),
                mutate("recommendations", [], { revalidate: false }),
              ]);
            }}
          />

          <DangerAction
            title="Clear library"
            description="Deletes every book, its enrichment, and your taste profile — back to a clean first-setup state."
            buttonLabel="Clear library"
            onRun={async () => {
              await api.clearLibrary();
              // Full reload: LibraryGate remounts, re-reads stats (now 0) → shows first-setup.
              // Avoids the stale latched-gate state that a client-side nav would leave behind.
              window.location.assign("/");
            }}
          />

          <DangerAction
            title="Delete account data"
            description="Deletes ALL your data: library, profile, recommendations, and your stored Anthropic key."
            buttonLabel="Delete everything"
            onRun={async () => {
              await api.deleteAccount();
              window.location.assign("/");
            }}
          />
        </div>
      </section>
    </div>
  );
}
