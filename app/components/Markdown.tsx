import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="message-markdown min-w-0">
      <ReactMarkdown
        // A fence that names no language still gets read: most of what an
        // agent pastes is a command or a diff, and guessing beats grey.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
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
}
