import {quoteReference} from '../lib/quote-references';
import {QuotedReference} from './QuotedReference';
import { DiffCode } from "./DiffCode";
import type { DiffQuote } from "../lib/drafts";
import { Icon } from "./Icon";

export default function DiffAttachment({ quote, onRemove, owner }: { quote: DiffQuote; onRemove?: () => void; owner?:{agentId:string;entryId:number} }) {
  const reference=quoteReference(quote);
  if(reference&&!reference.reviewId)return <section aria-label="Quoted decision" className="flex min-w-0 items-start gap-2 py-1"><div className="min-w-0 flex-1"><QuotedReference reference={reference} owner={owner}/></div>{onRemove&&<button aria-label="Remove quoted decision" title="Remove quote" onClick={onRemove} className="cursor-pointer p-1"><Icon name="discard" size={13}/></button>}</section>;
  return <section aria-label={`Attached diff ${quote.path}`} className="min-w-0 py-2 text-[12px]">
    <div className="flex items-center gap-2 text-faint">
      <span className="min-w-0 flex-1 truncate" title={quote.path}>{quote.path}</span>
      {onRemove && <button aria-label={`Remove diff ${quote.path}`} title="Remove diff" onClick={onRemove} className="cursor-pointer"><Icon name="discard" size={13} /></button>}
    </div>
    <DiffCode rows={quote.rows} path={quote.path}>{(code,ready) => <pre aria-busy={!ready} className="mt-1 max-h-36 overflow-auto font-mono leading-[1.6]">{quote.rows.map((row, at) => <div key={at} data-quoted-diff-line className={row.old === null && row.next === null ? "text-faint" : row.old === null ? "bg-ok/10 text-ok" : row.next === null ? "bg-remove/10 text-remove" : ""}><span className="mr-2 inline-block w-9 text-right text-faint">{row.old}</span><span className="mr-2 inline-block w-9 text-right text-faint">{row.next}</span><span>{code[at]}</span></div>)}</pre>}</DiffCode>
  </section>;
}
