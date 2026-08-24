import type { CcSessionMeta } from "../../cc-sessions.ts";

/** Preserve the long-lived observation contract. The stable id remains suitable for tabs,
 * pins and read routes; ephemeral adoption capabilities are deliberately not part of this DTO. */
export function devObservationDto<T extends CcSessionMeta>(meta: T): Omit<T, "_path"> {
  const dto: any = { ...meta };
  delete dto._path;
  return dto;
}
