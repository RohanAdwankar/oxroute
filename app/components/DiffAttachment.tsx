import type { DiffQuote } from "../lib/drafts";
import { Icon } from "./Icon";

export default function DiffAttachment({ quote, onRemove }: { quote: DiffQuote; onRemove?: () => void }) {
  return <section aria-label={`Attached diff ${quote.path}`} className="min-w-0 py-2 text-[12px]">
    <div className="flex items-center gap-2 text-faint">
      <span className="min-w-0 flex-1 truncate" title={quote.path}>{quote.path}</span>
      {onRemove && <button aria-label={`Remove diff ${quote.path}`} title="Remove diff" onClick={onRemove} className="cursor-pointer"><Icon name="discard" size={13} /></button>}
    </div>
    <pre className="mt-1 max-h-36 overflow-auto font-mono leading-[1.6]">{quote.rows.map((row, at) => <div key={at} data-quoted-diff-line className={row.old === null && row.next === null ? "text-faint" : row.old === null ? "bg-ok/10 text-ok" : row.next === null ? "bg-remove/10 text-remove" : ""}><span className="mr-2 inline-block w-9 text-right text-faint">{row.old}</span><span className="mr-2 inline-block w-9 text-right text-faint">{row.next}</span><span>{row.text}</span></div>)}</pre>
  </section>;
}
