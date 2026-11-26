"use client";

import { useEffect, useRef, useState } from "react";

type Recognition = { continuous: boolean; onresult: (event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void; onend: () => void; start(): void; stop(): void };
type Constructor = new () => Recognition;

/** Speech to text through the browser's own recognizer; each finished phrase goes to `onText`. Listening pauses while `hold` is true. */
export function useDictation(onText: (text: string) => void, hold = false) {
  const [listening, setListening] = useState(false);
  const sink = useRef(onText);
  sink.current = onText;
  const global = typeof window === "undefined" ? {} : (window as unknown as Record<string, Constructor | undefined>);
  const Speech = global.SpeechRecognition ?? global.webkitSpeechRecognition;

  useEffect(() => {
    if (!listening || hold || !Speech) return;
    const recognition = new Speech();
    let live = true;
    recognition.continuous = true;
    recognition.onresult = ({ resultIndex, results }) => {
      for (let i = resultIndex; i < results.length; i++) if (results[i].isFinal) sink.current(results[i][0].transcript.trim());
    };
    // The browser ends a session after a silence; start another while still listening.
    recognition.onend = () => { if (live) recognition.start(); };
    recognition.start();
    return () => { live = false; recognition.stop(); };
  }, [listening, hold, Speech]);

  return { supported: Boolean(Speech), listening, setListening };
}

/** Reads text aloud with the browser's own voice, replacing anything still being spoken. */
export function speak(text: string, onDone: () => void) {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*#>]/g, ""));
  utterance.onend = utterance.onerror = onDone;
  speechSynthesis.speak(utterance);
}
