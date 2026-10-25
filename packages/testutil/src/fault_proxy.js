import * as net from 'node:net';
export class FaultInjectingProxy {
    targetHost;
    targetPort;
    server;
    activeSockets = new Set();
    fault = {};
    port = 0;
    constructor(targetHost = '127.0.0.1', targetPort = 6379) {
        this.targetHost = targetHost;
        this.targetPort = targetPort;
        this.server = net.createServer((clientSocket) => {
            this.handleConnection(clientSocket);
        });
    }
    async start() {
        return new Promise((resolve, reject) => {
            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server.address();
                this.port = addr.port;
                resolve(this.port);
            });
            this.server.on('error', reject);
        });
    }
    setFault(fault) {
        this.fault = { ...fault };
        if (fault.reset) {
            for (const s of this.activeSockets) {
                s.destroy();
            }
            this.activeSockets.clear();
        }
    }
    clearFaults() {
        this.fault = {};
    }
    handleConnection(clientSocket) {
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
                    if (!targetSocket.destroyed)
                        targetSocket.write(data);
                }, this.fault.latencyMs);
            }
            else {
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
                    if (!clientSocket.destroyed)
                        clientSocket.write(data);
                }, this.fault.latencyMs);
            }
            else {
                clientSocket.write(data);
            }
        });
        const cleanup = () => {
            this.activeSockets.delete(clientSocket);
            this.activeSockets.delete(targetSocket);
            if (!clientSocket.destroyed)
                clientSocket.destroy();
            if (!targetSocket.destroyed)
                targetSocket.destroy();
        };
        clientSocket.on('close', cleanup);
        targetSocket.on('close', cleanup);
        clientSocket.on('error', cleanup);
        targetSocket.on('error', cleanup);
    }
    async close() {
        for (const s of this.activeSockets) {
            s.destroy();
        }
        this.activeSockets.clear();
        return new Promise((resolve) => {
            this.server.close(() => resolve());
        });
    }
}
