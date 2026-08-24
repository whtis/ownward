import {describe,expect,test} from "bun:test";
import {queueRouteResponse} from "./workbench.ts";

describe("workbench queue route",()=>{
  const never=async()=>{throw new Error("remove 不该被调用");};
  test("GET projects the session state's queued items",async()=>{
    const queued=[{id:"q1",text:"later"}],response=await queueRouteResponse("GET","task-1",async()=>({queued}),never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ok:true,queued});
  });
  test("POST remove drops the item the client actually pointed at",async()=>{
    let asked="";
    const response=await queueRouteResponse("POST","task-1",async()=>({queued:[]}),async(queueId)=>{
      asked=queueId;return{removed:true,queued:[{id:"q2",text:"still queued"}]};
    },{action:"remove",queueId:"q1"});
    expect(asked).toBe("q1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,queued:[{id:"q2"}]});
  });
  // 撤不到不能装作撤掉了：本轮刚结束、这条已经合并发出，用户必须看见
  test("POST remove reports a vanished item instead of silently succeeding",async()=>{
    const response=await queueRouteResponse("POST","task-1",async()=>({queued:[]}),async()=>({removed:false,queued:[]}),
      {action:"remove",queueId:"gone"});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ok:false,errorCode:"QUEUE_ITEM_GONE"});
  });
  // 按下标撤是这条路由被禁掉的原因，别让它悄悄回来
  test("POST rejects anything but remove-by-id",async()=>{
    let called=false;
    const remove=async()=>{called=true;return{removed:true,queued:[]};};
    for(const body of [{action:"clear"},{action:"remove",index:0},{action:"remove",queueId:""}]){
      const response=await queueRouteResponse("POST","task-1",async()=>({queued:[]}),remove,body as any);
      expect(response.status).toBe(400);
    }
    expect(called).toBeFalse();
  });
  test("missing id is rejected before anything is touched",async()=>{
    const response=await queueRouteResponse("GET","",async()=>({queued:[]}),never);
    expect(response.status).toBe(400);
  });
});
