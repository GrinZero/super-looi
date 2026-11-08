import http from "node:http";
import https from "node:https";
import net from "node:net";

export const fixtureCases = ["get", "post307", "post308", "resources"];
const callbackHost = "homeassistant.local:8123";
const authHost = "account.xiaomi.com";
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

/** A closed-world proxy: no DNS lookup or remote socket is ever performed.
 * Counters contain only fixed case names/methods, never OAuth URLs or headers. */
export async function createMiotFixtureServer({ key, cert }) {
  const sockets = new Set();
  const events = [];
  let callbackConnections = 0;
  const track = (server) => server.on("connection", (socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(15000, () => socket.destroy());
  });
  const consume = (request) => {
    let size = 0;
    request.on("data", (chunk) => { size += chunk.length; if (size > 8192) request.destroy(); });
  };
  const callback = http.createServer((request, response) => {
    consume(request);
    events.push({ route: "callback", method: request.method });
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("fixture callback reached");
  });
  track(callback);
  const callbackPort = await listen(callback);
  const authorize = https.createServer({ key, cert }, (request, response) => {
    consume(request);
    if (request.headers.host !== authHost) { response.writeHead(421).end(); return; }
    const url = new URL(request.url, `https://${authHost}`);
    const kind = url.searchParams.get("fixture_case");
    if (!fixtureCases.includes(kind)) { response.writeHead(400).end(); return; }
    const state = url.searchParams.get("state");
    if (!/^[a-f0-9]{40}$/.test(state ?? "")) { response.writeHead(400).end(); return; }
    const destination = `http://${callbackHost}/api/webhook/software-probe?` +
      new URLSearchParams({ state, code: `fixture-${kind}` });
    const next = (path) => path + "?" + new URLSearchParams({ fixture_case: kind, state });
    const html = (body) => { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(body); };
    if (url.pathname === "/oauth2/authorize" && request.method === "GET") {
      events.push({ route: "authorize", kind, method: "GET" });
      if (kind === "get") { response.writeHead(302, { Location: destination }).end(); return; }
      if (kind.startsWith("post")) {
        html(`<form method="POST" action="${next("/fixture-redirect")}"><input name="fixture" value="synthetic-only"></form><script>document.forms[0].submit()</script>`);
        return;
      }
      html(`<script>
        const urls = ${JSON.stringify([destination, next("/resource-redirect")])};
        Promise.all(urls.map(url => new Promise(resolve => {
          const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('blocked'); image.src = url;
          setTimeout(() => resolve('timeout'), 4000);
        }))).then(results => fetch(${JSON.stringify(next("/resource-report"))} + '&result=' + results.join(',')));
      </script>`);
      return;
    }
    if (url.pathname === "/fixture-redirect" && request.method === "POST" && kind.startsWith("post")) {
      events.push({ route: "redirect", kind, method: "POST" });
      response.writeHead(kind === "post307" ? 307 : 308, { Location: destination }).end(); return;
    }
    if (url.pathname === "/resource-redirect" && request.method === "GET" && kind === "resources") {
      events.push({ route: "resource-redirect", kind, method: "GET" });
      response.writeHead(302, { Location: destination }).end(); return;
    }
    if (url.pathname === "/resource-report" && kind === "resources") {
      const result = url.searchParams.get("result");
      events.push({ route: "resource-report", kind, blocked: result === "blocked,blocked" });
      response.writeHead(204).end(); return;
    }
    response.writeHead(404).end();
  });
  track(authorize);
  const tlsPort = await listen(authorize);
  const proxy = http.createServer((request, response) => {
    let url;
    try { url = new URL(request.url); } catch { response.writeHead(400).end(); return; }
    if (url.protocol !== "http:" || url.host !== callbackHost || url.username || url.password) {
      response.writeHead(403).end(); return;
    }
    callbackConnections++;
    events.push({ route: "callback", method: request.method });
    consume(request);
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("fixture callback reached");
  });
  proxy.on("connect", (request, client, head) => {
    const port = request.url === `${authHost}:443` ? tlsPort : request.url === callbackHost ? callbackPort : 0;
    if (!port) { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    if (port === callbackPort) callbackConnections++;
    const upstream = net.connect({ host: "127.0.0.1", port }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  track(proxy);
  const proxyPort = await listen(proxy);
  return {
    proxyPort,
    snapshot: () => ({ callbackConnections, callbackRequests: events.filter((item) => item.route === "callback").length, events: structuredClone(events) }),
    reset() { events.length = 0; callbackConnections = 0; },
    async close() { for (const socket of sockets) socket.destroy(); await Promise.all([proxy, authorize, callback].map((server) => new Promise((done) => server.close(done)))); },
  };
}
