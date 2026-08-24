export type RecoveryDecision="finalize-target"|"restore-previous";
export function decideInterruptedRelease(input:{phase:string,stateCurrent:string,target:string,pairIsTarget:boolean}):RecoveryDecision{return (input.phase==="state-committed"||input.stateCurrent===input.target)&&input.pairIsTarget?"finalize-target":"restore-previous"}
