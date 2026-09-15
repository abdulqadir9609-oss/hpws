import { DurableObject } from "cloudflare:workers";

export class Chat extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("HP Signaling Room OK");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const existingPeers = this.ctx.getWebSockets();

    server.send(
      JSON.stringify({
        type: "joined",
        role: "unknown",
      })
    );

    if (existingPeers.length > 0) {
      server.send(
        JSON.stringify({
          type: "peer-present",
        })
      );

      for (const peer of existingPeers) {
        try {
          peer.send(
            JSON.stringify({
              type: "peer-joined",
            })
          );
        } catch (_) {}
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let data: any;

    try {
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);

      data = JSON.parse(text);
    } catch (_) {
      return;
    }

    if (data?.type === "join") {
      return;
    }

    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;

      try {
        peer.send(JSON.stringify(data));
      } catch (_) {}
    }
  }

  async webSocketClose(ws: WebSocket) {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;

      try {
        peer.send(
          JSON.stringify({
            type: "peer-left",
          })
        );
      } catch (_) {}
    }
  }

  async webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "WebSocket error");
    } catch (_) {}
  }
}

interface Env {
  Chat: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "HP WEB Signaling",
        websocket: "/ws",
      });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket upgrade required", {
          status: 426,
        });
      }

      const roomName = url.searchParams.get("code") || "123456";

      const roomId = env.Chat.idFromName(roomName);
      const room = env.Chat.get(roomId);

      return room.fetch(request);
    }

    return new Response("HP WEB Signaling Server");
  },
};
