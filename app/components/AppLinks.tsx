"use client";
import {useEffect} from "react";

// Safari Dock apps keep forced new windows inside the app. Let ordinary
// out-of-scope navigation hand external links to the OS default browser.
export function AppLinks() {
  useEffect(() => {
    const follow = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !matchMedia("(display-mode: standalone)").matches) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target !== "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, location.href);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== location.origin) link.target = "_self";
    };
    document.addEventListener("click", follow, true);
    return () => document.removeEventListener("click", follow, true);
  }, []);
  return null;
}
