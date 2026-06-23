"use client";

// This route has moved into /library?tab=to-read.
// Keep the file so any bookmarks or old links redirect gracefully.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ToReadRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/library?tab=to-read");
  }, [router]);
  return null;
}
