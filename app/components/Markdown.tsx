import { createContext, memo, useContext } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";

import { Copyable } from "./Copyable";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon";

export const ReviewLinks = createContext<{ titles: Map<string, string>; open: (id: string) => void } | null>(null);

type Node = { type: string; value?: string; url?: string; children?: Node[] };
function reviewLinks(titles: Map<string, string>) {
  return () => (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children || ["code", "link", "linkReference"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type === "inlineCode" && titles.has(child.value ?? "")) {
          return [{ type: "link", url: `#review/${child.value}`, children: [{ type: "text", value: titles.get(child.value!) }] }];
        }
        if (child.type === "text") return (child.value ?? "").split(/\b(review_[0-9a-f]{32})(?![\w])/g).filter(Boolean).map(value =>
          titles.has(value) ? { type: "link", url: `#review/${value}`, children: [{ type: "text", value: titles.get(value) }] } : { type: "text", value });
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}

/// Memoised on the text: a refetch replaces every entry object, so the
/// messages re-render even though not a character of them changed, and
/// re-parsing a transcript through remark and a highlighter is the most
/// expensive thing this app does.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  const reviews = useContext(ReviewLinks);
  return (
    <div className="message-markdown min-w-0">
      <ReactMarkdown
        // Tables, task lists and strikethrough are GFM rather than CommonMark,
        // so without this an agent's table arrives as a wall of pipes.
        // A shell's home-directory tildes are literal; deletion needs ~~.
        remarkPlugins={[[remarkGfm, { singleTilde: false }], ...(reviews ? [reviewLinks(reviews.titles)] : [])]}
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
          a: ({ children, href, ...props }) => {
            const id = href?.startsWith("#review/") ? href.slice(8) : "";
            if (reviews?.titles.has(id)) return <button type="button" aria-label={`Review ${reviews.titles.get(id)}`} title="Open change review"
              onClick={() => reviews.open(id)} className="inline-flex cursor-pointer items-center gap-1 bg-band px-1.5 py-0.5 align-baseline text-[0.9em] text-ink hover:text-mid">
              <Icon name="diff" size={12} />{children}
            </button>;
            return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
