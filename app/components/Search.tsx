"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { clock } from "../lib/format";
import type { ConversationLine, NativeSession, SearchGroup, SearchResults } from "../lib/types";
import { Markdown } from "./Markdown";

const EMPTY: SearchResults = { managed: [], other: [] };
type Choice =
  | { key: string; type: "managed"; result: SearchGroup }
  | { key: string; type: "native"; session: NativeSession };

export function Search({ onOpen, onImport }: {
  onOpen: (agent: string, entry: number) => void;
  onImport: (agent: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState<{ key: string; lines: ConversationLine[] }>({ key: "", lines: [] });
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);
  const previewRequest = useRef(0);
  const choices = useMemo<Choice[]>(() => [
    ...results.managed.map((result) => ({
      key: `managed:${result.destinations[0]?.agentId}:${result.destinations[0]?.entryId}`,
      type: "managed" as const,
      result,
    })),
    ...results.other.map((session) => ({
      key: `native:${session.backend}:${session.sessionId}`,
      type: "native" as const,
      session,
    })),
  ], [results]);
  const choice = choices[selected];

  useEffect(() => {
    const term = query.trim();
    if (!term) return;
    const current = ++request.current;
    const timer = window.setTimeout(() => {
      api.search(term).then((matches) => {
        if (request.current !== current) return;
        setResults(matches);
        setSelected(0);
        setLoading(false);
      }, (reason) => {
        if (request.current !== current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!choice) return;
    const current = ++previewRequest.current;
    const load = choice.type === "managed"
      ? api.agent(choice.result.destinations[0].agentId).then((view) => {
          const entry = choice.result.destinations[0].entryId;
          const at = Math.max(view.timeline.findIndex((item) => item.id === entry), 0);
          return view.timeline.slice(Math.max(0, at - 5), at + 7).map((item) => ({
            role: item.kind === "said" ? "agent" : item.kind === "worked" ? "work" : "you",
            text: item.text === "Command" ? item.detail : item.text || item.detail,
          }));
        })
      : api.nativePreview(choice.session.backend, choice.session.sessionId);
    load.then(
      (lines) => previewRequest.current === current && setPreview({ key: choice.key, lines }),
      () => previewRequest.current === current && setPreview({ key: choice.key, lines: [] }),
    );
  }, [choice]);

  const activate = async (target: Choice | undefined) => {
    if (!target) return;
    if (target.type === "managed") {
      const destination = target.result.destinations[0];
      setOpen(false);
      onOpen(destination.agentId, destination.entryId);
      return;
    }
    setImporting(target.session.sessionId);
    setError("");
    try {
      const agent = await api.importSession(target.session.backend, target.session.sessionId);
      setOpen(false);
      onImport(agent.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="relative w-[min(32vw,390px)]">
      <input
        type="search"
        value={query}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          setResults(EMPTY);
          setLoading(Boolean(value.trim()));
          setError("");
          if (!value.trim()) request.current += 1;
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.currentTarget.blur();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelected((current) => Math.min(current + 1, Math.max(choices.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((current) => Math.max(current - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            void activate(choice);
          }
        }}
        placeholder="Search sessions"
        aria-label="search all sessions"
        className="tnum w-full rounded-[3px] border border-rule bg-paper px-3 py-[7px] text-[12px] outline-none placeholder:text-faint focus:border-edge"
      />

      {open && query.trim() && (
        <div className="fixed top-[76px] right-[5vw] left-[5vw] z-30 flex h-[min(72vh,720px)] overflow-hidden border border-edge bg-card shadow-[0_18px_45px_rgba(33,29,25,0.2)]">
          <div className="quiet-scroll w-[42%] overflow-y-auto border-r border-rule">
            {loading || choices.length === 0 ? (
              <p className="px-4 py-4 text-[12px] text-faint">
                {loading ? "Searching…" : error || "No session matches."}
              </p>
            ) : (
              <>
                {results.managed.length > 0 && <Band>Oxroute sessions</Band>}
                {results.managed.map((result, index) => (
                  <ResultRow
                    key={choices[index].key}
                    selected={selected === index}
                    time={result.at}
                    title={result.text || result.detail || result.origin}
                    detail={`${result.destinations[0].agentName}${result.destinations.length > 1 ? ` · ${result.destinations.length} forks` : ""}`}
                    action="Open"
                    onSelect={() => setSelected(index)}
                    onActivate={() => void activate(choices[index])}
                  />
                ))}
                {results.other.length > 0 && <Band>Other sessions on this VM</Band>}
                {results.other.map((session, offset) => {
                  const index = results.managed.length + offset;
                  return <ResultRow
                    key={choices[index].key}
                    selected={selected === index}
                    time={session.updatedAt}
                    title={session.name || session.preview || "Untitled session"}
                    detail={`${session.backend} · ${session.cwd || "folder unavailable"}`}
                    action={importing === session.sessionId ? "Importing…" : "Import"}
                    disabled={importing !== null}
                    onSelect={() => setSelected(index)}
                    onActivate={() => void activate(choices[index])}
                  />;
                })}
              </>
            )}
          </div>

          <div className="quiet-scroll flex min-w-0 flex-1 flex-col overflow-y-auto bg-paper">
            <div className="sticky top-0 border-b border-rule bg-card px-5 py-3">
              <span className="text-[12px] font-semibold">Conversation preview</span>
              {choice && <span className="ml-3 text-[11px] text-faint">
                {choice.type === "managed"
                  ? choice.result.destinations[0].agentName
                  : choice.session.name || choice.session.backend}
              </span>}
            </div>
            <div className="flex flex-col px-5 py-2">
              {choice && preview.key !== choice.key ? (
                <p className="py-4 text-[12px] text-faint">Loading context…</p>
              ) : preview.lines.length === 0 ? (
                <p className="py-4 text-[12px] text-faint">No conversation context available.</p>
              ) : preview.lines.map((line, index) => (
                <div key={`${line.role}:${index}`} className="flex gap-3 border-b border-hair py-3 last:border-b-0">
                  <span className={`w-10 shrink-0 pt-0.5 text-[10.5px] ${line.role === "agent" ? "text-ok" : "text-faint"}`}>
                    {line.role}
                  </span>
                  <div className="min-w-0 text-[13px] leading-[1.5] text-ink">
                    <Markdown>{line.text}</Markdown>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Band({ children }: { children: React.ReactNode }) {
  return <div className="border-b border-rule bg-band px-4 py-2 text-[11px] text-faint">{children}</div>;
}

function ResultRow({ selected, time, title, detail, action, disabled, onSelect, onActivate }: {
  selected: boolean;
  time: number;
  title: string;
  detail: string;
  action: string;
  disabled?: boolean;
  onSelect: () => void;
  onActivate: () => void;
}) {
  return (
    <div
      onMouseEnter={onSelect}
      onClick={onSelect}
      className={`flex items-start gap-3 border-b border-hair px-4 py-3 ${selected ? "bg-wash" : "hover:bg-paper"}`}
    >
      <span className="tnum w-[48px] shrink-0 pt-px text-[10.5px] text-faint">
        {time > 0 ? clock(time) : ""}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[12.5px] leading-[1.4]">{title}</span>
        <span className="mt-1 block truncate text-[10.5px] text-faint">{detail}</span>
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
        }}
        className="cursor-pointer px-2 py-1 text-[11px] text-mid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        {action}
      </button>
    </div>
  );
}
