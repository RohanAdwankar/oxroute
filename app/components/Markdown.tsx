import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";

import { Copyable } from "./Copyable";
import remarkGfm from "remark-gfm";

/// Memoised on the text: a refetch replaces every entry object, so the
/// messages re-render even though not a character of them changed, and
/// re-parsing a transcript through remark and a highlighter is the most
/// expensive thing this app does.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="message-markdown min-w-0">
      <ReactMarkdown
        // Tables, task lists and strikethrough are GFM rather than CommonMark,
        // so without this an agent's table arrives as a wall of pipes.
        remarkPlugins={[remarkGfm]}
        // A fence that names no language still gets read: most of what an
        // agent pastes is a command or a diff, and guessing beats grey.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          // A fence is something you take: wrap it in the thing that lets
          // you, rather than leaving the reader to select it by hand.
          pre: ({ children, ...props }) => (
            <Copyable>
              <pre {...props}>{children}</pre>
            </Copyable>
          ),
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
