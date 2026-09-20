declare module 'hyperdht' {
  import { EventEmitter } from 'node:events';
  import { Duplex } from 'node:stream';
  export interface DhtServer extends EventEmitter {
    listen(keyPair: { publicKey: Buffer; secretKey: Buffer }): Promise<void>;
    address(): { publicKey: Buffer };
    close(): Promise<void>;
  }
  export default class DHT extends EventEmitter {
    constructor(options?: Record<string, unknown>);
    static keyPair(): { publicKey: Buffer; secretKey: Buffer };
    createServer(listener: (socket: Duplex) => void): DhtServer;
    connect(publicKey: Buffer): Duplex;
    destroy(options?: { force?: boolean }): Promise<void>;
  }
}
declare module 'hyperdht/testnet.js' {
  export default function createTestnet(size?: number): Promise<{
    bootstrap: { host: string; port: number }[];
    destroy(): Promise<void>;
  }>;
}
