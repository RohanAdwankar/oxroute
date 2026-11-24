import type {DiffQuote,QuoteReference} from "./drafts";

export function titleQuote(text:string,source:Omit<QuoteReference,'title'>):DiffQuote {
  return {reference:{...source,title:text},path:source.reviewId?"Review title":"Decision title",rows:[{text,old:null,next:null}],text:[
    `Source conversation: ${source.agentId}`,source.reviewId&&`Review: ${source.reviewId}`,source.taskId&&`Task: ${source.taskId}`,
    source.evidenceEntryIds?.length&&`Evidence entries: ${source.evidenceEntryIds.join(', ')}`,`Selected title:\n> ${text}\n\n`,
  ].filter(Boolean).join('\n')};
}
