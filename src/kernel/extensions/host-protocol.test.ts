import { describe, expect, test } from "bun:test";
import { encodeHostFrame, EXTENSION_FRAME_MAX, HostFrameDecoder, parseHostEnvelope, type HostEnvelope } from "./host-protocol.ts";

const envelope = (id = "request-1"): HostEnvelope => ({ version: 1, type: "request", id, capability: "a".repeat(64), method: "health", body: {} });
describe("Extension Host framed IPC", () => {
  test("fragmented and coalesced frames decode without trusting declared allocation", () => { const one=encodeHostFrame(envelope("one")),two=encodeHostFrame(envelope("two")),all=Buffer.concat([one,two]),decoder=new HostFrameDecoder(); expect(decoder.push(all.subarray(0,3))).toEqual([]); expect(decoder.push(all.subarray(3))).toEqual([envelope("one"),envelope("two")]); });
  test("zero, oversized, malformed UTF-8 and unknown envelope fields fail closed", () => { const zero=Buffer.alloc(4),huge=Buffer.alloc(4); huge.writeUInt32BE(EXTENSION_FRAME_MAX+1); expect(()=>new HostFrameDecoder().push(zero)).toThrow("长度"); expect(()=>new HostFrameDecoder().push(huge)).toThrow("长度"); const bad=Buffer.from([0,0,0,1,0xff]); expect(()=>new HostFrameDecoder().push(bad)).toThrow(); expect(()=>parseHostEnvelope({...envelope(),extra:true})).toThrow("envelope"); });
  test("version, capability, method and response result are strict", () => { expect(()=>parseHostEnvelope({...envelope(),version:2})).toThrow(); expect(()=>parseHostEnvelope({...envelope(),capability:"short"})).toThrow(); expect(()=>parseHostEnvelope({...envelope(),method:"../../shell"})).toThrow(); expect(()=>parseHostEnvelope({...envelope(),type:"response"})).toThrow("response"); });
});
