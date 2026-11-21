import type {DiffQuote} from "./drafts";

export function titleQuote(text:string,source:{agentId:string;reviewId?:string;taskId?:string;evidenceEntryIds?:number[]}):DiffQuote {
  return {path:source.reviewId?"Review title":"Decision title",rows:[{text,old:null,next:null}],text:[
    `Source conversation: ${source.agentId}`,source.reviewId&&`Review: ${source.reviewId}`,source.taskId&&`Task: ${source.taskId}`,
    source.evidenceEntryIds?.length&&`Evidence entries: ${source.evidenceEntryIds.join(', ')}`,`Selected title:\n> ${text}\n\n`,
  ].filter(Boolean).join('\n')};
}
