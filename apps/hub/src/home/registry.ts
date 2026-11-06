import WebSocket from "ws";
import { readHomeRegistry as readSharedHomeRegistry } from "@super-looi/home-assistant";
export type { HomeEntityMetadata } from "@super-looi/home-assistant";

/** Node owns handshake/redirect policy; the protocol and filtering live in the shared package. */
export function readHomeRegistry(url: string, token: string, integration: string) {
  return readSharedHomeRegistry(url, token, integration, {
    createWebSocket: (endpoint) => {
      const socket = new WebSocket(endpoint, { handshakeTimeout: 5000, followRedirects: false });
      // ws emits a final error when a connecting socket is terminated on timeout.
      socket.on("error", () => {});
      return {
        send: (data) => socket.send(data),
        close: () => socket.terminate(),
        addEventListener: socket.addEventListener.bind(socket),
        removeEventListener: socket.removeEventListener.bind(socket),
      };
    },
  });
}
