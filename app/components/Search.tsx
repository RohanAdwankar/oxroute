"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { clock } from "../lib/format";
import type { ConversationLine, NativeSession, SearchGroup } from "../lib/types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

type Choice =
  | { key: string; type: "managed"; result: SearchGroup }
  | { key: string; type: "native"; session: NativeSession };

/// The part of an entry that actually contains what you typed. A row that
/// says "Bash" tells you nothing; the command it ran might be the thing you
/// remember.
function matched(query: string, ...parts: (string | undefined)[]): string {
  const wanted = query.trim().toLowerCase();
  const present = parts.filter((part): part is string => Boolean(part));
  return present.find((part) => part.toLowerCase().includes(wanted)) ?? present[0] ?? "";
}

export function Search({ onOpen, onContinue }: {
  onOpen: (agent: string, entry: number) => void;
  onContinue: (agent: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [managed, setManaged] = useState<SearchGroup[]>([]);
  const [other, setOther] = useState<NativeSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState<{ key: string; lines: ConversationLine[] }>({ key: "", lines: [] });
  const [continuing, setContinuing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);
  const previewRequest = useRef(0);
  const choices = useMemo<Choice[]>(() => [
    ...managed.map((result) => ({
      key: `managed:${result.destinations[0]?.agentId}:${result.destinations[0]?.entryId}`,
      type: "managed" as const,
      result,
    })),
    ...other.map((session) => ({
      key: `native:${session.backend}:${session.sessionId}`,
      type: "native" as const,
      session,
    })),
  ], [managed, other]);
  const choice = choices[selected];

  useEffect(() => {
    const term = query.trim();
    if (!term) return;
    const current = ++request.current;
    const timer = window.setTimeout(() => {
      // Two questions with different answers in mind: what oxroute knows is
      // local and instant, and the harnesses' own transcripts take as long
      // as they take. Neither waits for the other.
      api.search(term).then((hits) => {
        if (request.current !== current) return;
        setManaged(hits);
        setSelected(0);
        setLoading(false);
      }, (reason) => {
        if (request.current !== current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
      api.searchNative(term).then((sessions) => {
        if (request.current === current) setOther(sessions);
      }, () => {});
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
            text: matched(query, item.text, item.detail, item.output),
          }));
        })
      : api.nativePreview(choice.session.backend, choice.session.sessionId);
    load.then(
      (lines) => previewRequest.current === current && setPreview({ key: choice.key, lines }),
      () => previewRequest.current === current && setPreview({ key: choice.key, lines: [] }),
    );
  }, [choice, query]);

  const activate = async (target: Choice | undefined) => {
    if (!target) return;
    if (target.type === "managed") {
      const destination = target.result.destinations[0];
      setOpen(false);
      onOpen(destination.agentId, destination.entryId);
      return;
    }
    setContinuing(target.session.sessionId);
    setError("");
    try {
      const agent = await api.continueSession(target.session.backend, target.session.sessionId);
      setOpen(false);
      onContinue(agent.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setContinuing(null);
    }
  };

  return (
    <div className="relative flex min-w-[180px] flex-1 basis-[260px] items-stretch">
      <input
        type="search"
        value={query}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          setManaged([]);
          setOther([]);
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
        className="tnum w-full bg-card px-4 text-[12px] outline-none placeholder:text-faint focus:bg-paper"
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
                {managed.length > 0 && <Band>Oxroute sessions</Band>}
                {managed.map((result, index) => (
                  <ResultRow
                    key={choices[index].key}
                    selected={selected === index}
                    time={result.at}
                    title={matched(query, result.text, result.detail, result.origin)}
                    detail={`${result.destinations[0].agentName}${result.destinations.length > 1 ? ` · ${result.destinations.length} forks` : ""}`}
                    action="Open"
                    onSelect={() => setSelected(index)}
                    onActivate={() => void activate(choices[index])}
                  />
                ))}
                {other.length > 0 && <Band>Other sessions</Band>}
                {other.map((session, offset) => {
                  const index = managed.length + offset;
                  return <ResultRow
                    key={choices[index].key}
                    selected={selected === index}
                    time={session.updatedAt}
                    title={session.name || session.preview || "Untitled session"}
                    detail={`${session.backend} · ${session.cwd || "folder unavailable"}`}
                    action={continuing === session.sessionId ? "Starting…" : "Continue"}
                    disabled={continuing !== null}
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
              ) : preview.lines.map((line, index) => {
                const hit = line.text.toLowerCase().includes(query.trim().toLowerCase());
                return (
                <div
                  key={`${line.role}:${index}`}
                  ref={(node) => {
                    if (hit) node?.scrollIntoView({ block: "center" });
                  }}
                  className={`flex gap-3 border-b border-hair py-3 last:border-b-0 ${
                    hit ? "bg-mine" : ""
                  }`}
                >
                  <span className={`w-10 shrink-0 pt-0.5 text-[10.5px] ${line.role === "agent" ? "text-ok" : "text-faint"}`}>
                    {line.role}
                  </span>
                  <div className="min-w-0 text-[13px] leading-[1.5] text-ink">
                    <Markdown>{line.text}</Markdown>
                  </div>
                </div>
                );
              })}
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
        aria-label={action}
        title={action}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
        }}
        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center text-mid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name={action === "Open" ? "open" : "play"} size={14} />
      </button>
    </div>
  );
}
