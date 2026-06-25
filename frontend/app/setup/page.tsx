import SetupWizard from "@/components/SetupWizard";

// The wizard lives in components/SetupWizard.tsx so it can also be rendered inline by
// <LibraryGate> on /, /swipe, /library when a logged-in user has no library yet. This route
// is the standalone entry point (e.g. a direct visit to /setup); it just renders the wizard.
export default function SetupPage() {
  return <SetupWizard />;
}
