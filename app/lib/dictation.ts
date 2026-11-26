"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Recognition = { continuous: boolean; onresult: (event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void; onend: () => void; start(): void; stop(): void };
type Constructor = new () => Recognition;

/** Speech to text through the browser's own recognizer; each finished phrase goes to `onText`. */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const active = useRef<Recognition | null>(null);
  const sink = useRef(onText);
  sink.current = onText;
  const global = typeof window === "undefined" ? {} : (window as unknown as Record<string, Constructor | undefined>);
  const Speech = global.SpeechRecognition ?? global.webkitSpeechRecognition;

  useEffect(() => () => active.current?.stop(), []);

  const toggle = useCallback(() => {
    if (active.current) return active.current.stop();
    if (!Speech) return;
    const recognition = new Speech();
    recognition.continuous = true;
    recognition.onresult = ({ resultIndex, results }) => {
      for (let i = resultIndex; i < results.length; i++) if (results[i].isFinal) sink.current(results[i][0].transcript.trim());
    };
    recognition.onend = () => { active.current = null; setListening(false); };
    active.current = recognition;
    recognition.start();
    setListening(true);
  }, [Speech]);

  return { supported: Boolean(Speech), listening, toggle };
}
