#!/usr/bin/env node
'use strict';

// npm run tunnel
//
// Starts a Cloudflare Quick Tunnel (free, no account) in front of the game so
// friends outside the house can join, then starts the server with PUBLIC_URL
// set so the host screen shows both the Wi-Fi link and the public link.
//
// Needs `cloudflared` on the PATH: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/

const { spawn } = require('node:child_process');
const QRCode = require('qrcode');
const { startServer, lanAddress } = require('../server');

const port = Number(process.env.PORT) || 3000;
const bin = process.env.CLOUDFLARED || 'cloudflared';
const TUNNEL_TIMEOUT_MS = 45 * 1000;

function startTunnel() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child;
    try {
      child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return done({ error: err.message });
    }
    child.on('error', (err) => done({ error: err.code === 'ENOENT' ? 'cloudflared is not installed' : err.message }));
    child.on('exit', (code) => done({ error: `cloudflared exited with code ${code}` }));
    const timer = setTimeout(() => done({ error: 'cloudflared did not report a URL within 45 s (no internet?)', child }), TUNNEL_TIMEOUT_MS);
    const onData = (chunk) => {
      // Quick Tunnel hostnames are hyphenated words (quiet-river-1234); the
      // API host also appears in error messages and must not match.
      const m = String(chunk).match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/i);
      if (m && !/^https:\/\/api\./i.test(m[0])) {
        clearTimeout(timer);
        done({ url: m[0], child });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

(async () => {
  console.log('Starting a Cloudflare Quick Tunnel…');
  const tunnel = await startTunnel();
  if (tunnel.error) {
    console.log(`\n⚠️  No tunnel: ${tunnel.error}.`);
    console.log('   Install cloudflared (macOS: brew install cloudflared; Windows: winget install Cloudflare.cloudflared;');
    console.log('   Linux: https://pkg.cloudflare.com) and run this again. Starting on the Wi-Fi only.\n');
  }
  const srv = await startServer({ port, publicUrl: tunnel.url || null });
  if (tunnel.url) {
    console.log('');
    console.log('🌍  Friends elsewhere can join at:');
    console.log(`    ${tunnel.url}`);
    console.log(await QRCode.toString(tunnel.url, { type: 'terminal', small: true }));
    console.log('   This link changes every time you restart. Share it together with the room code.');
    const lan = lanAddress();
    if (lan) console.log(`   Kids on this Wi-Fi can use http://${lan}:${port} (faster).`);
  }
  const shutdown = async () => {
    if (tunnel.child && !tunnel.child.killed) tunnel.child.kill();
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
