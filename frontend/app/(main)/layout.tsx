import NavBar from "@/components/NavBar";
import ReprofileBanner from "@/components/ReprofileBanner";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <NavBar />
      <ReprofileBanner />
      <main className="mx-auto max-w-4xl px-4 pb-16 pt-4">{children}</main>
    </>
  );
}
