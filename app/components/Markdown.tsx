import { createContext, memo, useContext, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";

import { FileReviews, ReviewFileButton, ReviewImage, savedReview } from "./FileReview";
import { Copyable } from "./Copyable";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon";
import { encodePrFormLink } from "../lib/pr-links";
import { FocusReview } from "./FocusReview";
import { EmbeddedReviews, ConversationReferences } from "./FocusContext";
import { FocusCards } from "./FocusCards";
import {ConversationLink} from "./ConversationLink";
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

/** Conversation references keep their prose intact and share one deck after the reply. */
function conversationCards(known: Set<string>) {
  return () => (tree: Node) => {
    const links = new Map<string, Node>();
    const id = (node: Node) => node.type === "element" && node.tagName === "a" && node.properties?.href?.startsWith("#agent/") && known.has(node.properties.href.slice(7)) ? node.properties.href.slice(7) : "";
    const remember = (node: Node) => { links.set(id(node), node); };
    const visit = (node: Node) => {
      if (!node.children) return;
      node.children = node.children.flatMap(child => {
        if (id(child)) { remember(child); return child.children ?? []; }
        if (node.type === "root" && child.tagName === "p" && child.children?.some(id) && child.children.every(part => id(part) || part.type === "text" && !part.value?.trim())) {
          child.children.filter(id).forEach(remember);
          return [];
        }
        visit(child);
        return [child];
      });
    };
    visit(tree);
    if (links.size) tree.children?.push({ type: "element", tagName: "p", properties: {}, children: [...links.values()] });
  };
}

// Stable renderer identities preserve native selections when Markdown updates.
const markdownComponents: Components = {
  p: function Paragraph({node,children}) {
    const reviews=useContext(EmbeddedReviews),references=useContext(ConversationReferences);
    const known=useMemo(()=>references?new Set<string>(JSON.parse(references)):null,[references]);
    const nodes=node?.children??[];
    const agentLink=(child:typeof nodes[number])=>child.type==="element"&&child.tagName==="a"&&typeof child.properties.href==="string"&&child.properties.href.startsWith("#agent/")&&known?.has((child.properties.href as string).slice(7));
    const ids=nodes.filter(agentLink).map(child=>child.type==="element"?String(child.properties.href).slice(7):"");
    if(ids.length&&nodes.every(child=>agentLink(child)||child.type==="text"&&!child.value.trim()))return <FocusCards ids={ids}/>;
    const embedded=node?.children.some(child=>child.type==="element"&&child.tagName==="a"&&typeof child.properties.href==="string"&&child.properties.href.startsWith("#review/")&&reviews?.owners.has(child.properties.href.slice(8)));
    return embedded?<div>{children}</div>:<p>{children}</p>;
  },
  img: ({src, alt, title}) => <ReviewImage src={src} alt={alt} title={title} />,
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
    const openFile = useContext(FileReviews);
    const reviews = useContext(ReviewLinks);
    const tasks = useContext(TaskLinks);
    const embedded=useContext(EmbeddedReviews);
    if(href?.startsWith("#agent/")&&href.length>7)return <ConversationLink {...props} id={href.slice(7)}>{children}</ConversationLink>;
    if(href?.startsWith("#review/")&&embedded?.owners.has(href.slice(8)))return <FocusReview id={href.slice(8)}/>;
    if (href && savedReview(href) && openFile) return <button type="button" className="cursor-pointer underline" onClick={() => openFile(href)}>{children}</button>;
    const task = href?.startsWith("#task/");
    const links = task ? tasks : reviews;
    const id = task ? href!.slice(6) : href?.startsWith("#review/") ? href.slice(8) : "";
    if (task && tasks?.titles.has(id)) return <TaskReference id={id} open={() => tasks.open(id)} />;
    if (links?.titles.has(id)) return <button type="button" aria-label={`${task ? "Task" : "Review"} ${links.titles.get(id)}`} title={task ? "Open task" : "Open change review"}
      onClick={() => links.open(id)} className="inline-flex cursor-pointer items-center gap-1 bg-band px-1.5 py-0.5 align-baseline text-[0.9em] text-ink hover:text-mid">
      <Icon name={task ? "tasks" : "diff"} size={12} />{children}
    </button>;
    return <><a {...props} href={href && encodePrFormLink(href)} target="_blank" rel="noreferrer">{children}</a>{href && <ReviewFileButton url={href} />}</>;
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
  const embedded=useContext(EmbeddedReviews), agents=useContext(ConversationReferences);
  const titles = JSON.stringify([...(reviews?.titles ?? []), ...(tasks?.titles ?? []), ...[...(embedded?.owners ?? [])].map(([id, owner]) => [id, `Review from ${owner.name}`])]);
  return <ParsedMarkdown text={children} root={root} titles={titles} agents={agents} threads={quotes?.threads} />;
});

// Live cards and links consume their own contexts. Fleet activity must not
// reparse unchanged prose and syntax-highlight every code fence in history.
const ParsedMarkdown = memo(function ParsedMarkdown({ text, root, titles, agents, threads }: {
  text: string; root: string; titles: string; agents: string | null; threads?: QuoteThread[];
}) {
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
        remarkPlugins={[[remarkGfm, { singleTilde: false }], referenceLinks(new Map(JSON.parse(titles)))]}
        // A fence that names no language still gets read: most of what an
        // agent pastes is a command or a diff, and guessing beats grey.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }], ...(threads ? [quoteLinks(threads)] : []), ...(agents ? [conversationCards(new Set(JSON.parse(agents)))] : [])]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
