"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { api, API_KEY_STATUS_KEY, type ApiKeyStatus } from "@/lib/api";

/**
 * Settings — bring-your-own Anthropic API key.
 *
 * The key is sent once to the backend, encrypted at rest, and never read back (the status
 * endpoint only reports whether one is configured). Profile + recommend calls use it.
 */
export default function SettingsPage() {
  const { data: status, isLoading } = useSWR<ApiKeyStatus>(
    API_KEY_STATUS_KEY,
    () => api.apiKeyStatus()
  );

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
    </div>
  );
}
