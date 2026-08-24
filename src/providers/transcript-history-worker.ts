import { readClaudeTranscript, readCodexTranscript } from "./transcript-history.ts";

type Request = { id: string; kind: "claude"; nativeRef: string; home?: string }
  | { id: string; kind: "codex"; nativeRef: string; providerHome?: string; home?: string };

declare const self: Worker;
self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    const messages = request.kind === "claude"
      ? readClaudeTranscript(request.nativeRef, request.home)
      : readCodexTranscript(request.nativeRef, request.providerHome, request.home);
    self.postMessage({ id: request.id, ok: true, messages });
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, message: error instanceof Error ? error.message : "历史读取失败" });
  }
};
