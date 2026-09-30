"use client";

import { useEffect } from "react";

/** An open tab must not keep an obsolete UI after a frontend deployment. */
export function FrontendVersion() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    let live = true;
    let refreshing = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/version", { cache: "no-store" });
        if (!response.ok) return;
        const { version } = await response.json();
        if (!live || refreshing || version === process.env.NEXT_PUBLIC_WEB_VERSION) return;
        // Do not discard unsent images, drafts or a field being edited.
        if (document.querySelector("[data-uploads]") ||
            document.activeElement?.matches("input, textarea, [contenteditable=true]") ||
            Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
              .some((field) => field.value)) return;
        refreshing = true;
        window.location.reload();
      } catch {
        // Offline tabs keep working and check again when connected.
      }
    };
    void check();
    const timer = window.setInterval(check, 30_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return null;
}
