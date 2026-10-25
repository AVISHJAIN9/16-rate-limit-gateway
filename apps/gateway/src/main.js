import path from 'node:path';
import { GatewayConfigValidator } from '@rlgw/core';
import { GatewayServer } from './server.js';
function parseArgs() {
    const args = process.argv.slice(2);
    let configPath = 'examples/gateway.yaml';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-config' || args[i] === '--config') {
            configPath = args[i + 1] || configPath;
            i++;
        }
    }
    return { configPath };
}
async function main() {
    const { configPath } = parseArgs();
    const resolvedPath = path.resolve(process.cwd(), configPath);
    console.log(`[rlgw] Loading configuration from ${resolvedPath}`);
    const config = GatewayConfigValidator.loadFromFile(resolvedPath);
    const server = new GatewayServer(config);
    const { dataPort, adminPort } = await server.start();
    console.log(`[rlgw] Data listener running on http://${config.dataListener.host}:${dataPort}`);
    console.log(`[rlgw] Admin listener running on http://${config.adminListener.host}:${adminPort}`);
    const shutdown = async (signal) => {
        console.log(`[rlgw] Received ${signal}, starting graceful drain...`);
        try {
            await server.stop(5000);
            console.log('[rlgw] Gateway shutdown complete.');
            process.exit(0);
        }
        catch (err) {
            console.error('[rlgw] Error during shutdown:', err);
            process.exit(1);
        }
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
main().catch((err) => {
    console.error('[rlgw] Fatal startup error:', err);
    process.exit(1);
});
