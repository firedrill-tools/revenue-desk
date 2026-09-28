// Preload for child processes under test: `NODE_OPTIONS=--import=<file URL of this file>`.
// Blocks every TCP/TLS connection and fetch() to a non-loopback host, and
// reports each attempt on stderr as `[deny-network] blocked <host>:<port>`,
// so a test can prove that a third-party process made no outbound calls.
// Plain JavaScript because it runs inside a bare `node` child, not under tsx.
import net from "node:net";

const MARKER = "[deny-network] blocked";

function isLoopbackHost(host) {
  if (host === undefined || host === null || host === "") return true; // Node defaults to localhost
  const value = String(host)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    value === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
  );
}

function report(host, port) {
  process.stderr.write(`${MARKER} ${host}:${port ?? "?"}\n`);
}

function blockedError(host, port) {
  const error = new Error(`deny-network: outbound connection to ${host}:${port ?? "?"} blocked`);
  error.code = "EDENYNETWORK";
  return error;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0]; // internal normalized form
  let host;
  let port;
  if (options !== null && typeof options === "object") {
    if (typeof options.path === "string") return originalConnect.apply(this, args); // IPC
    host = options.host;
    port = options.port;
  } else if (typeof options === "number" || /^\d+$/.test(String(options))) {
    port = options;
    host = typeof args[1] === "string" ? args[1] : undefined;
  } else if (typeof options === "string") {
    return originalConnect.apply(this, args); // IPC path
  }
  if (!isLoopbackHost(host)) {
    report(host, port);
    const error = blockedError(host, port);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = async function fetch(input, init) {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname)) {
      report(url.hostname, url.port || (url.protocol === "https:" ? 443 : 80));
      throw blockedError(url.hostname, url.port);
    }
    return originalFetch(input, init);
  };
}
