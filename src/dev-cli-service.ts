import { applyEvolve, loadTasks, startEvolve, startWork, updateTask } from "./dispatch.ts";
import { writeFlightRecord } from "./flight-record.ts";

/** CLI composition adapter；CLI 不经过 HTTP/Vertical 生命周期，但只依赖这一处显式领域入口。 */
export const devCliService = Object.freeze({
  applyEvolve,
  loadTasks,
  startEvolve,
  startWork,
  updateTask,
  writeFlightRecord,
});
