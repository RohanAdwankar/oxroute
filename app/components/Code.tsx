"use client";

import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";

// The languages an agent working in a repository actually types. The rest
// of highlight.js is a megabyte nobody here reads.
for (const [name, language] of Object.entries({
  bash,
  diff,
  javascript,
  json,
  python,
  rust,
  typescript,
})) {
  hljs.registerLanguage(name, language);
}

/**
 * A command, or whatever an agent ran, coloured the way a terminal would.
 *
 * What it ran is code even when nobody wrapped it in a fence, so this is
 * the same highlighter the fences use, pointed at a bare string.
 */
export function Code({ text, language = "bash" }: { text: string; language?: string }) {
  const html = useMemo(() => {
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, language]);

  if (html === null) return <>{text}</>;
  return <span className="hljs" dangerouslySetInnerHTML={{ __html: html }} />;
}
