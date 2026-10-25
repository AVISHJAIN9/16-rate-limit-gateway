import * as net from 'node:net';

export interface FaultConfig {
  latencyMs?: number;
  drop?: boolean;
  reset?: boolean;
  blackhole?: boolean;
  partition?: boolean;
  slowCloseMs?: number;
}

export class FaultInjectingProxy {
  private server: net.Server;
  private activeSockets = new Set<net.Socket>();
  private fault: FaultConfig = {};
  public port: number = 0;

  constructor(
    private readonly targetHost: string = '127.0.0.1',
    private readonly targetPort: number = 6379
  ) {
    this.server = net.createServer((clientSocket) => {
      this.handleConnection(clientSocket);
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as net.AddressInfo;
        this.port = addr.port;
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  setFault(fault: FaultConfig): void {
    this.fault = { ...fault };
    if (fault.reset) {
      for (const s of this.activeSockets) {
        s.destroy();
      }
      this.activeSockets.clear();
    }
  }

  clearFaults(): void {
    this.fault = {};
  }

  private handleConnection(clientSocket: net.Socket): void {
    if (this.fault.reset) {
      clientSocket.destroy();
      return;
    }

    if (this.fault.partition) {
      clientSocket.destroy();
      return;
    }

    this.activeSockets.add(clientSocket);
    const targetSocket = new net.Socket();
    this.activeSockets.add(targetSocket);

    targetSocket.connect(this.targetPort, this.targetHost);

    // Forward client -> target
    clientSocket.on('data', (data) => {
      if (this.fault.blackhole) {
        return; // Absorb without response
      }
      if (this.fault.drop) {
        return;
      }
      if (this.fault.latencyMs && this.fault.latencyMs > 0) {
        setTimeout(() => {
          if (!targetSocket.destroyed) targetSocket.write(data);
        }, this.fault.latencyMs);
      } else {
        targetSocket.write(data);
      }
    });

    // Forward target -> client
    targetSocket.on('data', (data) => {
      if (this.fault.blackhole || this.fault.drop) {
        return;
      }
      if (this.fault.latencyMs && this.fault.latencyMs > 0) {
        setTimeout(() => {
          if (!clientSocket.destroyed) clientSocket.write(data);
        }, this.fault.latencyMs);
      } else {
        clientSocket.write(data);
      }
    });

    const cleanup = () => {
      this.activeSockets.delete(clientSocket);
      this.activeSockets.delete(targetSocket);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!targetSocket.destroyed) targetSocket.destroy();
    };

    clientSocket.on('close', cleanup);
    targetSocket.on('close', cleanup);
    clientSocket.on('error', cleanup);
    targetSocket.on('error', cleanup);
  }

  async close(): Promise<void> {
    for (const s of this.activeSockets) {
      s.destroy();
    }
    this.activeSockets.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
