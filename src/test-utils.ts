// Shared test utilities for the ludics test suite.

/**
 * Whether this environment can bind a loopback socket.
 * Use with `describe.if(canBindSocket)(...)` to skip network tests
 * in environments where socket binding is restricted.
 */
export let canBindSocket = true;
try {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() { return new Response("ok"); },
  });
  probe.stop(true);
} catch {
  canBindSocket = false;
}
