import { createContext, memo, useContext } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";

import { Copyable } from "./Copyable";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon";
import { TaskReference } from "./TaskReference";
import type { QuoteThread } from "../lib/types";

export const ArtifactRoot = createContext("");

export const ReviewLinks = createContext<{ titles: Map<string, string>; open: (id: string) => void } | null>(null);
export const TaskLinks = createContext<{ titles: Map<string, string>; open: (id: string) => void } | null>(null);
export const QuoteLinks = createContext<{ threads: QuoteThread[]; open: (id: string, rect: DOMRect) => void } | null>(null);

type Node = { type: string; value?: string; url?: string; tagName?: string; properties?: Record<string, string>; children?: Node[] };
function quoteLinks(threads: QuoteThread[]) {
  return () => (tree: Node) => {
    const text = (node: Node): string => node.type === "text" ? node.value ?? "" : (node.children ?? []).map(text).join("");
    const source = text(tree);
    const valid = threads.filter(thread => source.slice(thread.start, thread.end) === thread.text);
    if (!valid.length) return;
    let offset = 0;
    const visit = (node: Node) => {
      if (!node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text") { visit(child); return [child]; }
        const value = child.value ?? "", start = offset;
        offset += value.length;
        const boundaries = [...new Set([start, offset, ...valid.flatMap(thread => [thread.start, thread.end]).filter(at => at > start && at < offset)])].sort((a, b) => a - b);
        return boundaries.slice(0, -1).map((at, i) => {
          const next = boundaries[i + 1];
          const content = { type: "text", value: value.slice(at - start, next - start) };
          const thread = valid.findLast(thread => thread.start <= at && thread.end >= next);
          return thread ? { type: "element", tagName: "span", properties: { "data-quote-thread": thread.agentId }, children: [content] } : content;
        });
      });
    };
    visit(tree);
  };
}
function referenceLinks(titles: Map<string, string>) {
  const link = (id: string) => ({ type: "link", url: `#${id.startsWith("task_") ? "task" : "review"}/${id}`, children: [{ type: "text", value: titles.get(id) }] });
  return () => (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children || ["code", "link", "linkReference"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type === "inlineCode" && titles.has(child.value ?? "")) {
          return [link(child.value!)];
        }
        if (child.type === "text") return (child.value ?? "").split(/\b((?:review|task)_[0-9a-f]{32})(?![\w])/g).filter(Boolean).map(value =>
          titles.has(value) ? link(value) : { type: "text", value });
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}

// Stable renderer identities preserve native selections when Markdown updates.
const markdownComponents: Components = {
  span: function QuoteSpan({ node, children, ...props }) {
    const quotes = useContext(QuoteLinks);
    const id = node?.properties?.["data-quote-thread"];
    if (typeof id !== "string" || !quotes) return <span {...props}>{children}</span>;
    const open = (element: HTMLElement) => quotes.open(id, element.getBoundingClientRect());
    return <span {...props} data-quote-thread={id} role="button" tabIndex={0} aria-label="Open quoted thread"
      className="cursor-pointer underline decoration-mid decoration-1 underline-offset-4 hover:decoration-ink"
      onClick={event => { event.preventDefault(); event.stopPropagation(); open(event.currentTarget); }}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); open(event.currentTarget); } }}>{children}</span>;
  },
  // A fence is something you take: wrap it in the thing that lets
  // you, rather than leaving the reader to select it by hand.
  pre: ({ children, ...props }) => (
    <Copyable>
      <pre {...props}>{children}</pre>
    </Copyable>
  ),
  a: function ReferenceLink({ children, href, ...props }) {
    const reviews = useContext(ReviewLinks);
    const tasks = useContext(TaskLinks);
    const task = href?.startsWith("#task/");
    const links = task ? tasks : reviews;
    const id = task ? href!.slice(6) : href?.startsWith("#review/") ? href.slice(8) : "";
    if (task && tasks?.titles.has(id)) return <TaskReference id={id} open={() => tasks.open(id)} />;
    if (links?.titles.has(id)) return <button type="button" aria-label={`${task ? "Task" : "Review"} ${links.titles.get(id)}`} title={task ? "Open task" : "Open change review"}
      onClick={() => links.open(id)} className="inline-flex cursor-pointer items-center gap-1 bg-band px-1.5 py-0.5 align-baseline text-[0.9em] text-ink hover:text-mid">
      <Icon name={task ? "tasks" : "diff"} size={12} />{children}
    </button>;
    return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
  },
};

/// Memoised on the text: a refetch replaces every entry object, so the
/// messages re-render even though not a character of them changed, and
/// re-parsing a transcript through remark and a highlighter is the most
/// expensive thing this app does.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  const reviews = useContext(ReviewLinks);
  const tasks = useContext(TaskLinks);
  const quotes = useContext(QuoteLinks);
  const root = useContext(ArtifactRoot);
  return (
    <div className="message-markdown min-w-0">
      <ReactMarkdown
        urlTransform={url => {
          if (root && url.startsWith("/") && !url.startsWith("//")) {
            try {
              const parsed = new URL(url, "http://localhost");
              const path = decodeURIComponent(parsed.pathname);
              if (path.startsWith(root.endsWith("/") ? root : root + "/")) {
                return `/api/artifacts?path=${encodeURIComponent(path)}${parsed.hash}`;
              }
            } catch { /* A malformed link must not break the conversation. */ }
          }
          return defaultUrlTransform(url);
        }}
        // Tables, task lists and strikethrough are GFM rather than CommonMark,
        // so without this an agent's table arrives as a wall of pipes.
        // A shell's home-directory tildes are literal; deletion needs ~~.
        remarkPlugins={[[remarkGfm, { singleTilde: false }], ...((reviews || tasks) ? [referenceLinks(new Map([...(reviews?.titles ?? []), ...(tasks?.titles ?? [])]))] : [])]}
        // A fence that names no language still gets read: most of what an
        // agent pastes is a command or a diff, and guessing beats grey.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }], ...(quotes ? [quoteLinks(quotes.threads)] : [])]}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
