import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MyLibrary",
  description: "Your personal AI-powered reading engine",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      {/* Browser extensions (e.g. ColorZilla adds cz-shortcut-listen) mutate <body>
          before React hydrates, causing a benign attribute-mismatch warning. Suppress
          it on this element only — it does not hide real mismatches inside the app. */}
      <body
        className="min-h-screen bg-[#0f1117] text-slate-200 antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
