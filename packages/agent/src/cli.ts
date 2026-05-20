import { readFile } from 'node:fs/promises';
import type { TlsOptions } from './ws-server.js';

export interface CliOptions {
  isLocal: boolean;
  port: number;
  host: string;
  cmuxSocket: string;
  tlsCert: string;
  tlsKey: string;
  apiToken: string;
  relayUrl: string;
  acpCommand: string;
  acpArgs: string[];
  acpName: string;
}

/**
 * Parse command-line arguments and environment variables into a structured options object.
 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  const isLocal = argv.includes('--local');
  const port = parseInt(getArg(argv, '--port') || process.env.CMUX_RELAY_PORT || '8080', 10);
  const host = getArg(argv, '--host') || process.env.CMUX_RELAY_HOST || '0.0.0.0';
  const cmuxSocket = getArg(argv, '--socket') || '';
  const tlsCert = getArg(argv, '--tls-cert') || process.env.CMUX_RELAY_TLS_CERT || '';
  const tlsKey = getArg(argv, '--tls-key') || process.env.CMUX_RELAY_TLS_KEY || '';
  const apiToken = getArg(argv, '--token') || process.env.CMUX_RELAY_TOKEN || '';
  const relayUrl = getArg(argv, '--relay-url') || process.env.CMUX_RELAY_URL || 'wss://relay.gateway.myaddr.io/ws/agent';
  const acpCommand = getArg(argv, '--acp-command') || process.env.CMUX_ACP_COMMAND || '';
  const acpArgsRaw = getArg(argv, '--acp-args') || process.env.CMUX_ACP_ARGS || '';
  const acpArgs = acpArgsRaw ? acpArgsRaw.split(',') : [];
  const acpName = getArg(argv, '--acp-name') || process.env.CMUX_ACP_NAME || acpCommand.split('/').pop() || '';

  return { isLocal, port, host, cmuxSocket, tlsCert, tlsKey, apiToken, relayUrl, acpCommand, acpArgs, acpName };
}

/**
 * Load TLS certificate and key from file paths.
 * Returns undefined if either path is empty or files cannot be read.
 */
export async function loadTlsOptions(certPath: string, keyPath: string): Promise<TlsOptions | undefined> {
  if (!certPath || !keyPath) return undefined;
  try {
    const [cert, key] = await Promise.all([
      readFile(certPath, 'utf-8'),
      readFile(keyPath, 'utf-8'),
    ]);
    console.log(`TLS enabled: cert=${certPath}`);
    return { cert, key };
  } catch (err: unknown) {
    console.error(`Failed to load TLS certs: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function getArg(argv: string[], name: string): string {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx < argv.length - 1 ? argv[idx + 1] : '';
}
