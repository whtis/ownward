import {existsSync} from "fs";
import {join} from "path";
import {mutateTasksAt} from "../dispatch.ts";

export function markTaskRunAccepted(dataRoot:string,taskId:string,command:{commandId:string;runId:string}):void{if(!existsSync(join(dataRoot,"tasks.json")))return;mutateTasksAt(dataRoot,tasks=>{const task=tasks.find(item=>item.id===taskId);if(task){task.status="running";task.launchState="accepted";task.launchAcceptedAt=new Date().toISOString();task.commandId=command.commandId;task.runId=command.runId;task.uncertain=false;delete task.endedAt;delete task.exitCode;}return tasks;});}
