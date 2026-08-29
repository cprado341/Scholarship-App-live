import type { ServerResponse } from "node:http";

export interface RealtimeEvent {
  type: string;
  message: string;
  data?: unknown;
}

interface Client {
  familyId: string;
  res: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}

export class RealtimeHub {
  private clients = new Set<Client>();

  connect(familyId: string, res: ServerResponse): void {
    const heartbeat = setInterval(() => {
      res.write(`: keep-alive ${new Date().toISOString()}\n\n`);
    }, 25000);
    const client = { familyId, res, heartbeat };
    this.clients.add(client);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    this.sendToClient(client, { type: "connected", message: "Live portal updates connected." });
    res.on("close", () => {
      clearInterval(client.heartbeat);
      this.clients.delete(client);
    });
  }

  publish(familyId: string, event: RealtimeEvent): void {
    for (const client of this.clients) {
      if (client.familyId === familyId) this.sendToClient(client, event);
    }
  }

  private sendToClient(client: Client, event: RealtimeEvent): void {
    client.res.write(`event: ${event.type}\n`);
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
