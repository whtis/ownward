import { resolve } from "path";
import { assertReleaseMetadata } from "../src/release-metadata.ts";

function usage(): never {
  throw new Error("usage: release-metadata.ts check [root] [baseline-root]");
}

if (import.meta.main) {
  try {
    const [, , command, rootArg, baselineArg] = process.argv;
    if (command !== "check") usage();
    const metadata = assertReleaseMetadata(rootArg ? resolve(rootArg) : process.cwd(), baselineArg ? resolve(baselineArg) : undefined);
    console.log(JSON.stringify(metadata));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
