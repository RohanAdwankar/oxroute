import type {DiffQuote,QuoteReference} from './drafts';

export function quoteReference(quote:DiffQuote):QuoteReference|undefined {
  if(quote.reference)return quote.reference;
  // Historical title attachments used this serialized provenance contract.
  if(quote.rows.length!==1||quote.rows[0].old!==null||quote.rows[0].next!==null||!quote.text.startsWith('Source conversation: '))return;
  const fields=new Map(quote.text.split('\n').map(line=>{const at=line.indexOf(': ');return [line.slice(0,at),line.slice(at+2)];}));
  const agentId=fields.get('Source conversation');if(!agentId)return;
  return {agentId,title:quote.rows[0].text,reviewId:fields.get('Review'),evidenceEntryIds:(fields.get('Evidence entries')??'').split(', ').map(Number).filter(id=>Number.isSafeInteger(id)&&id>0)};
}
