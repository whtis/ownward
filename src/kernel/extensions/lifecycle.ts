export class LifecycleCapability {
  private writable=true;
  constructor(readonly moduleType:"vertical"|"connector",readonly moduleId:string){}
  revoke(){this.writable=false;}
  renew(){this.writable=true;}
  assertWrite(){if(!this.writable)throw Object.assign(new Error(`${this.moduleType} capability revoked`),{code:this.moduleType==="vertical"?"EXTENSION_CAPABILITY_REVOKED":"CONNECTOR_CAPABILITY_REVOKED"});}
  get revoked(){return!this.writable;}
}
