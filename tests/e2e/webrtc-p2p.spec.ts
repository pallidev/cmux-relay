/**
 * E2E test for WebRTC P2P connection between agent (node-datachannel) and browser.
 *
 * Flow:
 * 1. Mock relay server forwards signaling messages between agent and browser
 * 2. Agent creates WebRTC offer via node-datachannel
 * 3. Browser receives offer, creates answer via native RTCPeerConnection
 * 4. ICE candidates exchanged via relay
 * 5. DataChannel opens — verify bidirectional data transfer
 */

import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createRequire } from 'node:module';

const projectRoot = join(import.meta.dirname, '..', '..');
const nc = createRequire(import.meta.url)(
  join(projectRoot, 'packages', 'agent', 'node_modules', 'node-datachannel', 'dist', 'cjs', 'index.cjs')
);
const { PeerConnection } = nc.nodeDataChannel;

// ─── Mock relay server ───

let server: Server;
let wss: WebSocketServer;
let port: number;
let agentWs: WebSocket | null = null;
let clientWs: WebSocket | null = null;

test.beforeAll(async () => {
  server = createServer();
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const role = url.searchParams.get('role');

    if (role === 'agent') {
      agentWs = ws;
      ws.on('message', (raw) => {
        const data = typeof raw === 'string' ? raw : raw.toString();
        const msg = JSON.parse(data);
        if (msg.type === 'agent.data') {
          clientWs?.send(JSON.stringify(msg.payload));
        }
      });
    } else if (role === 'client') {
      clientWs = ws;
      agentWs?.send(JSON.stringify({ type: 'client.connected' }));
      ws.on('message', (raw) => {
        const data = typeof raw === 'string' ? raw : raw.toString();
        const msg = JSON.parse(data);
        agentWs?.send(JSON.stringify({ type: 'client.data', payload: msg }));
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as any).port;
});

test.afterAll(async () => {
  agentWs?.close();
  clientWs?.close();
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
});

// Browser test page: connects to relay, handles WebRTC signaling
const TEST_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>WebRTC P2P Test</title></head>
<body>
  <div id="status">idle</div>
  <div id="transport">none</div>
  <div id="received"></div>
  <script>
    const received = [];

    window.__connect = (relayUrl) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(relayUrl);
        window.__ws = ws;

        ws.onopen = () => {
          document.getElementById('status').textContent = 'ws-connected';
          resolve();
        };

        ws.onmessage = async (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'webrtc.offer') {
            const pc = new RTCPeerConnection({
              iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
              ],
            });
            window.__pc = pc;

            pc.onicecandidate = (e) => {
              if (e.candidate) {
                ws.send(JSON.stringify({
                  type: 'webrtc.ice-candidate',
                  candidate: e.candidate.candidate,
                  mid: e.candidate.sdpMid || '',
                }));
              }
            };

            pc.ondatachannel = (e) => {
              const dc = e.channel;
              window.__dc = dc;
              dc.onopen = () => {
                document.getElementById('transport').textContent = 'p2p';
              };
              dc.onmessage = (ev) => {
                received.push(JSON.parse(ev.data));
                document.getElementById('received').textContent = JSON.stringify(received);
              };
            };

            await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({
              type: 'webrtc.answer',
              sdp: pc.localDescription.sdp,
            }));
          }

          if (msg.type === 'webrtc.ice-candidate') {
            window.__pc?.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid });
          }
        };

        ws.onerror = () => reject(new Error('WS error'));
      });
    };

    window.__sendViaDC = (data) => {
      if (window.__dc && window.__dc.readyState === 'open') {
        window.__dc.send(JSON.stringify(data));
        return true;
      }
      return false;
    };
  </script>
</body>
</html>`;

test.describe('WebRTC P2P', () => {
  test('establishes P2P DataChannel between agent and browser', async ({ page }) => {
    test.setTimeout(60000);

    // Serve test page
    await page.route('**/test', (route) => {
      route.fulfill({ body: TEST_HTML, contentType: 'text/html' });
    });
    await page.goto('http://localhost/test');

    // 1. Browser connects to mock relay
    await page.evaluate((url) => window.__connect(url), `ws://127.0.0.1:${port}?role=client`);
    await expect(page.locator('#status')).toHaveText('ws-connected', { timeout: 3000 });

    // 2. Agent WebSocket connects to relay (so agentWs is set)
    const agentSocket = new WebSocket(`ws://127.0.0.1:${port}?role=agent`);
    await new Promise<void>((resolve, reject) => {
      agentSocket.on('open', () => resolve());
      agentSocket.on('error', reject);
    });

    // 3. Agent: create PeerConnection and offer
    const agentPc = new PeerConnection('test-agent', {
      iceServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    });
    const agentDc = agentPc.createDataChannel('terminal');
    agentPc.setLocalDescription('offer');
    const offer = agentPc.localDescription();

    // Forward ICE candidates from agent to browser (via relay)
    agentPc.onLocalCandidate((candidate, mid) => {
      clientWs?.send(JSON.stringify({
        type: 'webrtc.ice-candidate',
        candidate,
        mid,
      }));
    });

    // 3. Send offer to browser via relay
    agentSocket.send(JSON.stringify({
      type: 'agent.data',
      payload: { type: 'webrtc.offer', sdp: offer?.sdp },
    }));

    // 4. Wait for browser's answer (forwarded by relay)
    const answerSdp = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Answer timeout')), 10000);
      const handler = (raw: WebSocket.Data) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'client.data' && msg.payload?.type === 'webrtc.answer') {
          clearTimeout(timeout);
          agentSocket.off('message', handler);
          resolve(msg.payload.sdp);
        }
      };
      agentSocket.on('message', handler);
    });
    expect(answerSdp.length).toBeGreaterThan(100);

    // 5. Agent sets remote description
    agentPc.setRemoteDescription(answerSdp, 'answer');

    // 6. Wait for DataChannel to open on agent side
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Agent DC open timeout')), 15000);
      agentDc.onOpen(() => { clearTimeout(timeout); resolve(); });
      agentDc.onError((err) => { clearTimeout(timeout); reject(new Error(`DC error: ${err}`)); });
    });

    // 7. Verify browser DataChannel is open
    await expect(page.locator('#transport')).toHaveText('p2p', { timeout: 5000 });

    // 8. Test: agent → browser
    agentDc.sendMessage(JSON.stringify({ type: 'test', data: 'hello from agent' }));
    await page.waitForTimeout(500);
    const received = await page.evaluate(() => document.getElementById('received')!.textContent);
    expect(JSON.parse(received!)).toEqual(
      expect.arrayContaining([expect.objectContaining({ data: 'hello from agent' })])
    );

    // 9. Test: browser → agent
    const agentMsg = new Promise<string>((resolve) => {
      agentDc.onMessage((msg) => { if (typeof msg === 'string') resolve(msg); });
    });
    await page.evaluate(() => window.__sendViaDC({ type: 'test', data: 'hello from browser' }));
    expect(JSON.parse(await agentMsg)).toEqual({ type: 'test', data: 'hello from browser' });

    // Cleanup
    agentPc.close();
    agentSocket.close();
  });
});
