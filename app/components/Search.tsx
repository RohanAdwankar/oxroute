"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { clock } from "../lib/format";
import type { SearchGroup } from "../lib/types";

export function Search({
  onOpen,
}: {
  onOpen: (agent: string, entry: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    const term = query.trim();
    if (!term) return;
    const current = ++request.current;
    const timer = window.setTimeout(() => {
      api.search(term).then((matches) => {
        if (request.current === current) {
          setResults(matches);
          setLoading(false);
        }
      }, () => {
        if (request.current === current) setLoading(false);
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  const choose = (agent: string, entry: number) => {
    setOpen(false);
    onOpen(agent, entry);
  };

  return (
    <div
      className="relative w-[min(32vw,390px)]"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <input
        type="search"
        value={query}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          setResults([]);
          setLoading(Boolean(value.trim()));
          if (!value.trim()) {
            request.current += 1;
          }
          setExpanded(null);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.currentTarget.blur();
          }
        }}
        placeholder="Search sessions"
        aria-label="search all sessions"
        className="tnum w-full rounded-[3px] border border-rule bg-paper px-3 py-[7px] text-[12px] outline-none placeholder:text-faint focus:border-edge"
      />

      {open && query.trim() && (
        <div className="quiet-scroll absolute top-[42px] left-0 z-20 max-h-[min(68vh,620px)] w-[min(48vw,570px)] overflow-y-auto border border-rule bg-card shadow-[0_12px_30px_rgba(33,29,25,0.12)]">
          {loading || results.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-faint">
              {loading ? "Searching…" : "No timeline matches."}
            </p>
          ) : (
            results.map((result) => {
              const key = `${result.at}:${result.kind}:${result.destinations[0]?.entryId}`;
              const stacked = result.destinations.length > 1;
              const showBranches = stacked && expanded === key;
              return (
                <div key={key} className="border-b border-hair last:border-b-0">
                  <button
                    type="button"
                    onClick={() =>
                      stacked
                        ? setExpanded(showBranches ? null : key)
                        : choose(result.destinations[0].agentId, result.destinations[0].entryId)
                    }
                    className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left hover:bg-wash"
                  >
                    <span className="tnum w-[58px] shrink-0 pt-px text-[11px] text-faint">
                      {clock(result.at)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[12.5px] leading-[1.45]">
                        {result.text || result.detail || result.origin}
                      </span>
                      <span className="mt-1 block text-[11px] text-faint">
                        {result.kind} · {stacked ? `${result.destinations.length} overlapping forks` : result.destinations[0].agentName}
                      </span>
                    </span>
                    {stacked && <span className="text-[11px] text-mid">{showBranches ? "↑" : "↓"}</span>}
                  </button>

                  {showBranches && (
                    <div className="border-t border-hair bg-paper py-1">
                      {result.destinations.map((destination) => (
                        <button
                          key={`${destination.agentId}:${destination.entryId}`}
                          type="button"
                          onClick={() => choose(destination.agentId, destination.entryId)}
                          className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 pl-[69px] text-left text-[12px] hover:bg-wash"
                        >
                          <span className="text-merge">↳</span>
                          <span className="truncate">{destination.agentName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
