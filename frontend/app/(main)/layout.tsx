import NavBar from "@/components/NavBar";
import ReprofileBanner from "@/components/ReprofileBanner";
import FeedbackLauncher from "@/components/FeedbackLauncher";
import LibraryGate from "@/components/LibraryGate";
import BottomNav from "@/components/BottomNav";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <NavBar />
      <ReprofileBanner />
      <FeedbackLauncher />
      <main className="mx-auto max-w-4xl px-4 pb-24 sm:pb-16 pt-4">
        {/* On /, /swipe, /library a user with no library sees the setup wizard inline
            (see LibraryGate); other routes pass through untouched. */}
        <LibraryGate>{children}</LibraryGate>
      </main>
      <BottomNav />
    </>
  );
}
