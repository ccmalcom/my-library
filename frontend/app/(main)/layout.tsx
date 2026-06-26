import NavBar from "@/components/NavBar";
import ReprofileBanner from "@/components/ReprofileBanner";
import LibraryGate from "@/components/LibraryGate";
import { ToastProvider } from "@/components/ui";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <NavBar />
      <ReprofileBanner />
      <main className="mx-auto max-w-4xl px-4 pb-16 pt-4">
        {/* On /, /swipe, /library a user with no library sees the setup wizard inline
            (see LibraryGate); other routes pass through untouched. */}
        <LibraryGate>{children}</LibraryGate>
      </main>
    </ToastProvider>
  );
}
