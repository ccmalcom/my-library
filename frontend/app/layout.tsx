import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MyLibrary",
  description: "Your personal AI-powered reading engine",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#0f1117] text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
