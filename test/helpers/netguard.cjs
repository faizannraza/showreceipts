'use strict';
// Runtime no-network guard (ARCHITECTURE §13.4), loaded into every spawned
// CLI child through NODE_OPTIONS=--require. Every outbound entry point throws
// synchronously, so a network attempt fails loudly instead of hanging.
//
// Cost matters: the `--version` budget (≤ 80 ms) is measured with this guard
// armed. `net`, `dns` and `fetch` are patched eagerly (~7 ms);
// `tls`, `http`, `https` and `http2` are patched the moment they are required
// (a `Module._load` hook), because loading them up front costs ~20 ms. Every
// socket those modules open still goes through `net.Socket.prototype.connect`
// and `net.createConnection`, so the eager `net` patch is the backstop even
// for an ESM `import` that bypasses `require`.
const Module = require('module');

const MESSAGE = 'network blocked by netguard';

function blocked() {
  throw new Error(MESSAGE);
}

function patch(target, names) {
  if (!target) return;
  for (const name of names) {
    if (typeof target[name] === 'function') target[name] = blocked;
  }
}

function resolverNames(target) {
  return target ? Object.getOwnPropertyNames(target).filter((k) => k.startsWith('resolve')) : [];
}

// --- eager: the transport every other module rides on --------------------------
const net = require('net');
patch(net.Socket.prototype, ['connect']);
patch(net, ['connect', 'createConnection']);

const dns = require('dns');
patch(dns, ['lookup', 'lookupService', ...resolverNames(dns)]);
patch(dns.Resolver && dns.Resolver.prototype, resolverNames(dns.Resolver && dns.Resolver.prototype));
patch(dns.promises, ['lookup', 'lookupService', ...resolverNames(dns.promises)]);
patch(
  dns.promises.Resolver && dns.promises.Resolver.prototype,
  resolverNames(dns.promises.Resolver && dns.promises.Resolver.prototype),
);

// `globalThis.WebSocket` is deliberately left alone: redefining Node's lazy
// accessor loads undici (~30 ms), and undici's sockets go through the patched
// `net.connect`/`tls.connect` anyway.
Object.defineProperty(globalThis, 'fetch', { value: blocked, writable: true, configurable: true, enumerable: true });

// --- lazy: patched on first require --------------------------------------------
const LAZY = {
  tls: (m) => patch(m, ['connect']),
  http: (m) => patch(m, ['request', 'get']),
  https: (m) => patch(m, ['request', 'get']),
  http2: (m) => patch(m, ['connect']),
};
const patched = new Set();

function patchLazily(id, exports) {
  const name = id.startsWith('node:') ? id.slice(5) : id;
  const apply = LAZY[name];
  if (apply && !patched.has(name)) {
    patched.add(name);
    apply(exports);
  }
  return exports;
}

const originalLoad = Module._load;
Module._load = function netguardLoad(request, parent, isMain) {
  const exports = originalLoad.call(this, request, parent, isMain);
  return typeof request === 'string' ? patchLazily(request, exports) : exports;
};

if (typeof process.getBuiltinModule === 'function') {
  const originalGetBuiltin = process.getBuiltinModule;
  process.getBuiltinModule = function netguardGetBuiltinModule(id) {
    const exports = originalGetBuiltin.call(this, id);
    return typeof id === 'string' && exports ? patchLazily(id, exports) : exports;
  };
}
