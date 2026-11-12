"use client";
import {useEffect, type RefObject} from "react";
import {api} from "./api";

/** A prediction is not feedback until its choices have actually been visible. */
export function useRecommendationExposure(id: number | undefined, target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = target.current;
    if (!id || !element) return;
    let visible = false, sent = false;
    const record = () => {
      if (!visible || sent || document.visibilityState !== "visible") return;
      sent = true;
      void api.recommendationShown(id).catch(() => {sent = false;});
    };
    const observer = new IntersectionObserver(entries => {visible = entries.some(entry => entry.isIntersecting);record();});
    observer.observe(element);
    document.addEventListener("visibilitychange", record);
    return () => {observer.disconnect();document.removeEventListener("visibilitychange", record);};
  }, [id, target]);
}
