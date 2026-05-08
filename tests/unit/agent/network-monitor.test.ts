import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkMonitor } from '../../../packages/agent/src/network-monitor.js';

function makeInterfaces(interfaces: Record<string, Array<{ address: string; family: string; internal: boolean }>>) {
  let callCount = 0;
  return {
    fn: () => {
      callCount++;
      return interfaces;
    },
    get callCount() { return callCount; },
  };
}

describe('NetworkMonitor', () => {
  describe('computeDigest', () => {
    it('excludes internal addresses', () => {
      const iface = makeInterfaces({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        en0: [{ address: '192.168.1.1', family: 'IPv4', internal: false }],
      });
      const mon = new NetworkMonitor('example.com', { getInterfaces: iface.fn });
      const digest = mon.computeDigest();
      assert.ok(!digest.includes('127.0.0.1'));
      assert.ok(digest.includes('en0:IPv4:192.168.1.1'));
    });

    it('excludes link-local IPv6', () => {
      const iface = makeInterfaces({
        en0: [
          { address: 'fe80::1', family: 'IPv6', internal: false },
          { address: '192.168.1.1', family: 'IPv4', internal: false },
        ],
      });
      const mon = new NetworkMonitor('example.com', { getInterfaces: iface.fn });
      const digest = mon.computeDigest();
      assert.ok(!digest.includes('fe80::'));
      assert.ok(digest.includes('192.168.1.1'));
    });

    it('produces stable digest when interfaces do not change', () => {
      const iface = makeInterfaces({
        en0: [{ address: '192.168.1.1', family: 'IPv4', internal: false }],
      });
      const mon = new NetworkMonitor('example.com', { getInterfaces: iface.fn });
      assert.equal(mon.computeDigest(), mon.computeDigest());
    });

    it('sorts entries for stability', () => {
      const iface = makeInterfaces({
        en1: [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
        en0: [{ address: '192.168.1.1', family: 'IPv4', internal: false }],
      });
      const mon = new NetworkMonitor('example.com', { getInterfaces: iface.fn });
      const digest = mon.computeDigest();
      assert.ok(digest.indexOf('en0') < digest.indexOf('en1'));
    });
  });

  describe('network change detection', () => {
    it('does not emit on stable interfaces', async () => {
      const iface = makeInterfaces({
        en0: [{ address: '192.168.1.1', family: 'IPv4', internal: false }],
      });
      let dnsCall = 0;
      const resolveDns = (_h: string, cb: (err: Error | null, addr: string[]) => void) => {
        dnsCall++;
        cb(null, ['1.2.3.4']);
      };

      const events: string[] = [];
      const mon = new NetworkMonitor('example.com', {
        pollInterval: 50,
        debounceCount: 1,
        getInterfaces: iface.fn,
        resolveDns,
      });
      mon.on('network-change', () => events.push('change'));
      mon.start();
      await new Promise((r) => setTimeout(r, 200));
      mon.stop();
      assert.equal(events.length, 0);
    });

    it('emits after debounce count reached', async () => {
      let returnIface: Record<string, Array<{ address: string; family: string; internal: boolean }>> = {
        en0: [{ address: '192.168.1.1', family: 'IPv4', internal: false }],
      };

      const getInterfaces = () => returnIface;
      const resolveDns = (_h: string, cb: (err: Error | null, addr: string[]) => void) => {
        cb(null, ['1.2.3.4']);
      };

      const events: string[] = [];
      const mon = new NetworkMonitor('example.com', {
        pollInterval: 50,
        debounceCount: 2,
        getInterfaces,
        resolveDns,
      });
      mon.on('network-change', () => events.push('change'));
      mon.start();

      // After first poll, nothing changed yet (baseline is set in start())
      await new Promise((r) => setTimeout(r, 70));

      // Change the interface
      returnIface = {
        en0: [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
      };

      // Wait for 3 polls to pass debounce (2) + 1 extra
      await new Promise((r) => setTimeout(r, 250));
      mon.stop();

      assert.ok(events.length >= 1, `expected at least 1 event, got ${events.length}`);
    });

    it('suppresses event when DNS resolves to same IP', async () => {
      let returnIface: Record<string, Array<{ address: string; family: string; internal: boolean }>> = {
        en0: [{ address: '192.168.1.1', family: 'IPv4', internal: false }],
      };
      const getInterfaces = () => returnIface;
      const resolveDns = (_h: string, cb: (err: Error | null, addr: string[]) => void) => {
        cb(null, ['1.2.3.4']);
      };

      const events: string[] = [];
      const mon = new NetworkMonitor('example.com', {
        pollInterval: 50,
        debounceCount: 1,
        getInterfaces,
        resolveDns,
      });
      mon.on('network-change', () => events.push('change'));
      mon.start();

      // First change — sets lastResolvedIp
      returnIface = { en0: [{ address: '10.0.0.1', family: 'IPv4', internal: false }] };
      await new Promise((r) => setTimeout(r, 100));

      // Second change — DNS resolves to same IP, should suppress
      returnIface = { en0: [{ address: '172.16.0.1', family: 'IPv4', internal: false }] };
      await new Promise((r) => setTimeout(r, 100));

      mon.stop();
      // First change fires, second is suppressed (same DNS result)
      assert.equal(events.length, 1);
    });

    it('emits when DNS fails', async () => {
      let returnIface: Record<string, Array<{ address: string; family: string; internal: boolean }>> = {
        en0: [{ address: '192.168.1.1', family: 'IPv4', internal: false }],
      };
      const getInterfaces = () => returnIface;
      const resolveDns = (_h: string, cb: (err: Error | null, addr: string[]) => void) => {
        cb(new Error('ENOTFOUND'), []);
      };

      const events: string[] = [];
      const mon = new NetworkMonitor('example.com', {
        pollInterval: 50,
        debounceCount: 1,
        dnsTimeout: 200,
        getInterfaces,
        resolveDns,
      });
      mon.on('network-change', () => events.push('change'));
      mon.start();

      returnIface = { en0: [{ address: '10.0.0.1', family: 'IPv4', internal: false }] };
      await new Promise((r) => setTimeout(r, 150));

      mon.stop();
      assert.ok(events.length >= 1, `expected at least 1 event, got ${events.length}`);
    });
  });

  describe('sleep/wake', () => {
    it('detects time jump as network change', async () => {
      let currentTime = 1000;
      const resolveDns = (_h: string, cb: (err: Error | null, addr: string[]) => void) => {
        cb(new Error('ENOTFOUND'), []);
      };

      const events: string[] = [];
      const mon = new NetworkMonitor('example.com', {
        pollInterval: 50,
        sleepThreshold: 5000,
        debounceCount: 1,
        dnsTimeout: 200,
        now: () => currentTime,
        getInterfaces: () => ({
          en0: [{ address: '192.168.1.1', family: 'IPv4', internal: false }],
        }),
        resolveDns,
      });
      mon.on('network-change', () => events.push('change'));
      mon.start();

      // Normal polls — time advances by poll interval
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(events.length, 0, 'no events during normal polls');

      // Simulate sleep/wake — jump time forward past threshold
      currentTime += 60_000;
      await new Promise((r) => setTimeout(r, 100));

      mon.stop();
      assert.ok(events.length >= 1, `expected sleep/wake event, got ${events.length}`);
    });
  });

  describe('lifecycle', () => {
    it('stop clears timer', () => {
      const mon = new NetworkMonitor('example.com', {
        pollInterval: 1000,
        getInterfaces: () => ({}),
      });
      mon.start();
      mon.stop();
      // No crash = success
    });

    it('start is idempotent', () => {
      const mon = new NetworkMonitor('example.com', {
        pollInterval: 1000,
        getInterfaces: () => ({}),
      });
      mon.start();
      mon.start();
      mon.stop();
    });
  });
});
