export interface BoundRemoteTransportAddress { readonly host: string; readonly port: number; readonly protocol: "http:" | "https:" }
export interface BoundRemoteTransportHost { start(): Promise<BoundRemoteTransportAddress>; stop(): Promise<void> }
