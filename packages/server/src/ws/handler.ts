import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

const clients = new Set<WebSocket>();

export function wsHandler(socket: WebSocket, _req: FastifyRequest) {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
}

/**
 * Broadcast a message to all connected WebSocket clients
 */
export function broadcast(event: { type: string; [key: string]: unknown }) {
  const data = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}
