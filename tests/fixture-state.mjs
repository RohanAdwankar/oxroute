// Keep runtime configuration while replacing the complete conversation fixture graph.
export const fixtureState=(snapshot,agents)=>({...snapshot,agents,archived:[],reviews:{},focusAgentId:null,tasks:[],taskNotes:[],taskPriorities:{},reviewPriorities:{},inbox:[],inboxWaiting:0,inboxClearThrough:0,quoteThreads:[],messages:{},paneLinks:{},tags:{},boards:[]});
