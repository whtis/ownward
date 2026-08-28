export type RecoveryDecision="finalize-target"|"restore-previous";
export function decideInterruptedRelease(input:{phase:string;stateCurrent:string;stateCurrentConfig?:string;target:string;targetConfig?:string;pairIsTarget:boolean}):RecoveryDecision{
  const stateMatches=input.stateCurrent===input.target&&(!input.targetConfig||input.stateCurrentConfig===input.targetConfig);
  return (input.phase==="state-committed"||stateMatches)&&input.pairIsTarget?"finalize-target":"restore-previous";
}
