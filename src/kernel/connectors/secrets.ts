// Kernel-owned broker is provider-neutral. Product assembly supplies connector-specific readers.
export type ConnectorSecretProvider=(ref:string)=>string|undefined;
export function createConnectorSecretResolver(providers:Record<string,ConnectorSecretProvider>){return(connectorId:string,ref:string):string|undefined=>providers[connectorId]?.(ref);}
