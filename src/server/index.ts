import { validateSignalingMessage } from "./signaling";
import { DurableObject } from "cloudflare:workers";

interface Env extends Cloudflare.Env {
  DEVICE_REGISTRATION_SECRET: string;
}

type PendingDevice = {
  installId: string;
  proofHash: string;
  label: string;
  createdAt: number;
  status: "pending" | "approved" | "rejected";
  deviceId?: string;
  deviceToken?: string;
};

type DeviceRecord = {
  deviceId: string;
  tokenHash: string;
  label: string;
  createdAt: number;
  lastSeen: number | null;
  revoked: boolean;
};

type RevokeRetry = {
  deviceId: string;
  attempts: number;
  nextAttemptAt: number;
};

type AdminLoginRateLimit = {
  attempts: number;
  resetAt: number;
};

const encoder = new TextEncoder();

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(length = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(length)));
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64url(new Uint8Array(digest));
}

function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function adminToken(secret: string): Promise<string> {
  const payload = base64url(
    encoder.encode(JSON.stringify({
      purpose: "hp-admin",
      expires: Date.now() + 30 * 60 * 1000,
    }))
  );

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

async function verifyAdmin(token: string, secret: string): Promise<boolean> {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return false;

    const binary = atob(
      payload.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - payload.length % 4) % 4)
    );
    const data = JSON.parse(binary);

    if (data.purpose !== "hp-admin" || data.expires <= Date.now()) {
      return false;
    }

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sig = signature.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - signature.length % 4) % 4);

    const bytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));

    return crypto.subtle.verify(
      "HMAC",
      key,
      bytes,
      encoder.encode(payload)
    );
  } catch {
    return false;
  }
}

async function bodyJson(request: Request): Promise<any | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function deviceId(number: number): string {
  return number === 1 ? "HPPHONE1" : `HPPHONE${".".repeat(number)}${number}`;
}

function isValidDeviceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "HPPHONE1") return true;

  const match = /^HPPHONE(\\.{2,})([2-9]\\d*)$/.exec(value);
  if (!match) return false;

  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return false;

  // Accept legacy two-dot IDs already issued before the format was finalized.
  return match[1].length === 2 || match[1].length === number;
}


export class Chat extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // Durable Objects have one alarm, so revocation retries and expired-ticket
  // cleanup share a single schedule.
  private async scheduleMaintenanceAlarm(): Promise<void> {
    const [retries, tickets, loginLimits] = await Promise.all([
      this.ctx.storage.list<RevokeRetry>({ prefix: "revoke-pending:" }),
      this.ctx.storage.list<{ expiresAt: number }>({ prefix: "ws-ticket:" }),
      this.ctx.storage.list<AdminLoginRateLimit>({ prefix: "admin-login:" }),
    ]);

    const deadlines = [
      ...Array.from(retries.values(), (task) => task.nextAttemptAt),
      ...Array.from(tickets.values(), (ticket) => ticket.expiresAt),
      ...Array.from(loginLimits.values(), (limit) => limit.resetAt),
    ];

    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(
      Math.max(Date.now() + 1, Math.min(...deadlines))
    );
  }

  private async disconnectRevokedDevice(deviceId: string): Promise<boolean> {
    try {
      const deviceRoomId = this.env.Chat.idFromName(`device:${deviceId}`);
      const deviceRoom = this.env.Chat.get(deviceRoomId);
      const response = await deviceRoom.fetch(
        new Request("https://device.internal/internal/revoke", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Worker": this.env.DEVICE_REGISTRATION_SECRET,
          },
          body: JSON.stringify({ deviceId }),
        })
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const [tickets, loginLimits] = await Promise.all([
      this.ctx.storage.list<{ expiresAt: number }>({ prefix: "ws-ticket:" }),
      this.ctx.storage.list<AdminLoginRateLimit>({ prefix: "admin-login:" }),
    ]);

    for (const [key, ticket] of tickets) {
      if (ticket.expiresAt <= now) {
        await this.ctx.storage.delete(key);
      }
    }

    for (const [key, limit] of loginLimits) {
      if (limit.resetAt <= now) {
        await this.ctx.storage.delete(key);
      }
    }

    const tasks = await this.ctx.storage.list<RevokeRetry>({
      prefix: "revoke-pending:",
    });

    for (const [key, task] of tasks) {
      if (task.nextAttemptAt > now) continue;

      const disconnected = await this.disconnectRevokedDevice(task.deviceId);
      if (disconnected) {
        await this.ctx.storage.delete(key);
        continue;
      }

      const attempts = task.attempts + 1;
      const delay = Math.min(5 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 8)));
      await this.ctx.storage.put(key, {
        ...task,
        attempts,
        nextAttemptAt: Date.now() + delay,
      } satisfies RevokeRetry);
    }

    await this.scheduleMaintenanceAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname === "/internal/device-authorize" &&
      request.method === "POST"
    ) {
      const internalSecret = request.headers.get("X-Internal-Worker") || "";
      if (!safeEqual(internalSecret, this.env.DEVICE_REGISTRATION_SECRET)) {
        return json({ error: "Forbidden" }, 403);
      }

      const body = await bodyJson(request);
      if (
        typeof body?.deviceId !== "string" ||
        !isValidDeviceId(body.deviceId)
      ) {
        return json({ error: "Invalid device ID" }, 400);
      }

      const record = await this.ctx.storage.get<DeviceRecord>(
        `device:${body.deviceId}`
      );

      return json({
        authorized: Boolean(record && !record.revoked),
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return this.handleApi(request, url.pathname);
    }

    if (url.pathname === "/internal/revoke" && request.method === "POST") {
      const internalSecret = request.headers.get("X-Internal-Worker") || "";
      if (!safeEqual(internalSecret, this.env.DEVICE_REGISTRATION_SECRET)) {
        return json({ error: "Forbidden" }, 403);
      }

      const body = await bodyJson(request);
      if (
        typeof body?.deviceId !== "string" ||
        !isValidDeviceId(body.deviceId)
      ) {
        return json({ error: "Invalid device ID" }, 400);
      }

      // Persist revocation before closing existing connections.
      await this.ctx.storage.put(`revoked:${body.deviceId}`, true);

      let closed = 0;
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as
          | { deviceId?: string }
          | null;

        if (attachment?.deviceId === body.deviceId) {
          try {
            socket.close(4001, "Device revoked");
            closed++;
          } catch {}
        }
      }

      return json({ ok: true, deviceId: body.deviceId, closed });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("HP Signaling Room OK");
    }

    const role = url.searchParams.get("role");
    const deviceId = url.searchParams.get("deviceId");

    if (
      (role !== "phone" && role !== "controller") ||
      !deviceId ||
      !isValidDeviceId(deviceId)
    ) {
      return new Response("Authenticated WebSocket ticket required", { status: 401 });
    }

    const isRevoked = await this.ctx.storage.get<boolean>(
      `revoked:${deviceId}`
    );

    if (isRevoked) {
      return new Response("Device revoked", { status: 403 });
    }

    const registryId = this.env.Chat.idFromName("__hp_registry_v1__");
    const registry = this.env.Chat.get(registryId);
    const authorization = await registry.fetch(
      new Request("https://registry.internal/internal/device-authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Worker": this.env.DEVICE_REGISTRATION_SECRET,
        },
        body: JSON.stringify({ deviceId }),
      })
    );

    if (!authorization.ok) {
      return new Response("Device authorization unavailable", { status: 503 });
    }

    const authorizationResult = await authorization.json() as {
      authorized?: boolean;
    };

    if (!authorizationResult.authorized) {
      return new Response("Device revoked or unavailable", { status: 403 });
    }

    const duplicates = this.ctx.getWebSockets().filter((peer) => {
      const attachment = peer.deserializeAttachment() as
        | { role?: string; deviceId?: string }
        | null;

      return attachment?.role === role &&
        attachment?.deviceId === deviceId;
    });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, deviceId });

    // Register the replacement before closing old connections.
    for (const duplicate of duplicates) {
      try {
        duplicate.close(4000, "Replaced by a newer connection");
      } catch {}
    }

    const peers = this.ctx.getWebSockets().filter((peer) => peer !== server);

    server.send(JSON.stringify({ type: "joined", role, deviceId }));

    if (peers.length > 0) {
      server.send(JSON.stringify({ type: "peer-present" }));
      for (const peer of peers) {
        try {
          peer.send(JSON.stringify({ type: "peer-joined" }));
        } catch {}
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleApi(request: Request, path: string): Promise<Response> {
    const secret = this.env.DEVICE_REGISTRATION_SECRET;
    if (!secret) return json({ error: "Server configuration error" }, 500);

    const auth = request.headers.get("Authorization") || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const isAdmin = await verifyAdmin(bearer, secret);

    // Admin login: the master secret is entered by the administrator
    // in the Web Controller and is never embedded in its source code.
    if (path === "/api/admin/session" && request.method === "POST") {
      const body = await bodyJson(request);
      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateKey = `admin-login:${await hash(clientIp)}`;
      const now = Date.now();

      const loginResult = await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get<AdminLoginRateLimit>(rateKey);

        if (current && current.resetAt > now && current.attempts >= 5) {
          return "blocked" as const;
        }

        const state = current && current.resetAt > now
          ? current
          : { attempts: 0, resetAt: now + 15 * 60 * 1000 };

        if (
          !body ||
          typeof body.secret !== "string" ||
          !safeEqual(body.secret, secret)
        ) {
          state.attempts++;
          await txn.put(rateKey, state);
          return "invalid" as const;
        }

        await txn.delete(rateKey);
        return "success" as const;
      });

      if (loginResult !== "blocked") {
        // Failed-attempt records expire automatically after their 15-minute
        // window; successful authentication removes this IP's record.
        await this.scheduleMaintenanceAlarm();
      }

      if (loginResult === "blocked") {
        return json({ error: "Too many login attempts. Try again later." }, 429);
      }

      if (loginResult === "invalid") {
        return json({ error: "Invalid administrator credentials" }, 401);
      }

      return json({
        token: await adminToken(secret),
        expiresIn: 1800,
      });
    }

    // A phone creates its own random installId and proof locally.
    // The proof is stored only as a hash on the server.
    if (path === "/api/device/register" && request.method === "POST") {
      const body = await bodyJson(request);

      if (
        !body ||
        typeof body.installId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(body.installId) ||
        typeof body.proof !== "string" ||
        body.proof.length < 32 ||
        body.proof.length > 256
      ) {
        return json({ error: "Invalid registration request" }, 400);
      }

      const label =
        typeof body.label === "string"
          ? body.label.trim().slice(0, 80)
          : "Unknown Android device";

      const key = `pending:${body.installId}`;
      const proofHash = await hash(body.proof);

      const result = await this.ctx.storage.transaction(async (txn) => {
        const existing = await txn.get<PendingDevice>(key);

        if (existing) {
          if (!safeEqual(existing.proofHash, proofHash)) {
            return { error: "Registration identity conflict" };
          }
          return { status: existing.status };
        }

        const allPending = await txn.list<PendingDevice>({
          prefix: "pending:",
        });

        const pendingCount = [...allPending.values()].filter(
          (device) => device.status === "pending"
        ).length;

        if (pendingCount >= 100) {
          return { error: "Pending device queue is full" };
        }

        const record: PendingDevice = {
          installId: body.installId,
          proofHash,
          label,
          createdAt: Date.now(),
          status: "pending",
        };

        await txn.put(key, record);
        return { status: "pending" };
      });

      if ("error" in result) {
        return json({ error: result.error }, 409);
      }

      const registrationStatus = result.status as PendingDevice["status"];
      const messages: Record<PendingDevice["status"], string> = {
        pending: "Waiting for administrator approval",
        approved: "Device already approved",
        rejected: "Device registration was rejected",
      };

      return json({
        ok: true,
        status: registrationStatus,
        message: messages[registrationStatus],
      }, registrationStatus === "pending" ? 202 : 200);
    }

    // The app polls this endpoint using its locally stored proof.
    // An approved token remains available until the app acknowledges saving it.
    if (path === "/api/device/status" && request.method === "POST") {
      const body = await bodyJson(request);

      if (
        !body ||
        typeof body.installId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(body.installId) ||
        typeof body.proof !== "string" ||
        body.proof.length < 32 ||
        body.proof.length > 256
      ) {
        return json({ error: "Invalid request" }, 400);
      }

      const key = `pending:${body.installId}`;
      const record = await this.ctx.storage.get<PendingDevice>(key);

      if (!record || !safeEqual(record.proofHash, await hash(body.proof))) {
        return json({ error: "Registration not found" }, 401);
      }

      if (record.status === "pending") {
        return json({ status: "pending" });
      }

      if (record.status === "rejected") {
        return json({ status: "rejected" });
      }

      return json({
        status: "approved",
        deviceId: record.deviceId,
        token: record.deviceToken,
        pairingCode: record.deviceId,
      });
    }

    // The app calls this only after saving its token in secure storage.
    if (path === "/api/device/ack" && request.method === "POST") {
      const body = await bodyJson(request);
      if (
        !body ||
        typeof body.installId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(body.installId) ||
        typeof body.proof !== "string" ||
        body.proof.length < 32 ||
        body.proof.length > 256
      ) {
        return json({ error: "Invalid request" }, 400);
      }

      const key = `pending:${body.installId}`;
      const record = await this.ctx.storage.get<PendingDevice>(key);

      if (!record || !safeEqual(record.proofHash, await hash(body.proof))) {
        return json({ error: "Registration not found" }, 401);
      }

      if (record.status !== "approved") {
        return json({ error: "Device is not approved" }, 409);
      }

      record.deviceToken = undefined;
      await this.ctx.storage.put(key, record);
      return json({ ok: true });
    }

    if (path === "/api/devices/pending" && request.method === "GET") {
      if (!isAdmin) return json({ error: "Unauthorized" }, 401);

      const records = await this.ctx.storage.list<PendingDevice>({
        prefix: "pending:",
      });

      const devices = Array.from(records.values())
        .filter((item) => item.status === "pending")
        .map((item) => ({
          installId: item.installId,
          label: item.label,
          createdAt: item.createdAt,
        }));

      return json({ devices });
    }

    if (path === "/api/devices/approve" && request.method === "POST") {
      if (!isAdmin) return json({ error: "Unauthorized" }, 401);

      const body = await bodyJson(request);
      if (
        typeof body?.installId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(body.installId)
      ) {
        return json({ error: "Invalid install ID" }, 400);
      }

      const result = await this.ctx.storage.transaction(async (txn) => {
        const key = `pending:${body.installId}`;
        const pending = await txn.get<PendingDevice>(key);

        if (!pending) return { error: "Pending device not found" };
        if (pending.status === "approved") {
          return { deviceId: pending.deviceId };
        }
        if (pending.status !== "pending") {
          return { error: "Device is not pending" };
        }

        const next =
          (await txn.get<number>("registry:nextDeviceNumber")) ?? 1;

        const id = deviceId(next);
        const token = randomToken(32);

        const device: DeviceRecord = {
          deviceId: id,
          tokenHash: await hash(token),
          label: pending.label,
          createdAt: Date.now(),
          lastSeen: null,
          revoked: false,
        };

        pending.status = "approved";
        pending.deviceId = id;
        pending.deviceToken = token;

        await txn.put(`device:${id}`, device);
        await txn.put(key, pending);
        await txn.put("registry:nextDeviceNumber", next + 1);

        return { deviceId: id };
      });

      if ("error" in result) {
        return json(
          result,
          result.error === "Device is not pending" ? 409 : 404
        );
      }
      return json({ ok: true, deviceId: result.deviceId });
    }

    if (path === "/api/devices/reject" && request.method === "POST") {
      if (!isAdmin) return json({ error: "Unauthorized" }, 401);

      const body = await bodyJson(request);
      if (
        typeof body?.installId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(body.installId)
      ) {
        return json({ error: "Invalid install ID" }, 400);
      }

      const key = `pending:${body.installId}`;

      const result = await this.ctx.storage.transaction(async (txn) => {
        const record = await txn.get<PendingDevice>(key);

        if (!record) return { error: "Pending device not found", status: 404 };
        if (record.status !== "pending") {
          return { error: "Only pending devices can be rejected", status: 409 };
        }

        record.status = "rejected";
        record.deviceToken = undefined;
        await txn.put(key, record);

        return { ok: true };
      });

      if ("error" in result) {
        return json({ error: result.error }, result.status);
      }

      return json({ ok: true });
    }

    if (path === "/api/devices" && request.method === "GET") {
      if (!isAdmin) return json({ error: "Unauthorized" }, 401);

      const records = await this.ctx.storage.list<DeviceRecord>({
        prefix: "device:",
      });

      const devices = Array.from(records.values()).map((item) => ({
        deviceId: item.deviceId,
        label: item.label,
        createdAt: item.createdAt,
        lastSeen: item.lastSeen,
        revoked: item.revoked,
      }));

      devices.sort((a, b) => a.createdAt - b.createdAt);
      return json({ devices });
    }

    if (path === "/api/devices/revoke" && request.method === "POST") {
      if (!isAdmin) return json({ error: "Unauthorized" }, 401);

      const body = await bodyJson(request);
      if (
        typeof body?.deviceId !== "string" ||
        !isValidDeviceId(body.deviceId)
      ) {
        return json({ error: "Invalid device ID" }, 400);
      }

      const key = `device:${body.deviceId}`;
      const record = await this.ctx.storage.get<DeviceRecord>(key);
      if (!record) return json({ error: "Device not found" }, 404);

      // Revocation is authoritative in the registry. Persist a retry task
      // before contacting the room so a temporary room failure is not lost.
      record.revoked = true;
      await this.ctx.storage.put(key, record);

      const retryKey = `revoke-pending:${body.deviceId}`;
      await this.ctx.storage.put(retryKey, {
        deviceId: body.deviceId,
        attempts: 0,
        nextAttemptAt: Date.now() + 1000,
      } satisfies RevokeRetry);
      await this.scheduleMaintenanceAlarm();

      const disconnected = await this.disconnectRevokedDevice(body.deviceId);
      if (!disconnected) {
        return json({
          ok: true,
          deviceId: body.deviceId,
          revoked: true,
          disconnectWarning: true,
          retryScheduled: true,
        }, 202);
      }

      await this.ctx.storage.delete(retryKey);
      await this.scheduleMaintenanceAlarm();

      return json({
        ok: true,
        deviceId: body.deviceId,
        revoked: true,
        disconnectWarning: false,
      });
    }


    if (path === "/api/ws-ticket/phone" && request.method === "POST") {
      const body = await bodyJson(request);
      if (
        !body ||
        typeof body.deviceId !== "string" ||
        !isValidDeviceId(body.deviceId) ||
        typeof body.token !== "string" ||
        body.token.length < 32 ||
        body.token.length > 256
      ) {
        return json({ error: "Invalid device credentials" }, 400);
      }

      const record = await this.ctx.storage.get<DeviceRecord>(
        `device:${body.deviceId}`
      );

      if (
        !record ||
        record.revoked ||
        !safeEqual(record.tokenHash, await hash(body.token))
      ) {
        return json({ error: "Invalid device credentials" }, 401);
      }

      const ticket = randomToken(32);
      await this.ctx.storage.put(`ws-ticket:${await hash(ticket)}`, {
        role: "phone",
        deviceId: record.deviceId,
        expiresAt: Date.now() + 60_000,
      });
      await this.scheduleMaintenanceAlarm();

      record.lastSeen = Date.now();
      await this.ctx.storage.put(`device:${record.deviceId}`, record);

      return json({ ticket, expiresIn: 60 });
    }

    if (path === "/api/ws-ticket/controller" && request.method === "POST") {
      if (!isAdmin) return json({ error: "Unauthorized" }, 401);

      const body = await bodyJson(request);
      if (
        typeof body?.deviceId !== "string" ||
        !isValidDeviceId(body.deviceId)
      ) {
        return json({ error: "Invalid device ID" }, 400);
      }

      const record = await this.ctx.storage.get<DeviceRecord>(
        `device:${body.deviceId}`
      );

      if (!record || record.revoked) {
        return json({ error: "Device unavailable" }, 404);
      }

      const ticket = randomToken(32);
      await this.ctx.storage.put(`ws-ticket:${await hash(ticket)}`, {
        role: "controller",
        deviceId: record.deviceId,
        expiresAt: Date.now() + 60_000,
      });
      await this.scheduleMaintenanceAlarm();

      return json({ ticket, expiresIn: 60 });
    }

    if (path === "/api/ws-ticket/consume" && request.method === "POST") {
      const internalSecret = request.headers.get("X-Internal-Worker") || "";
      if (!safeEqual(internalSecret, secret)) {
        return json({ error: "Forbidden" }, 403);
      }

      const body = await bodyJson(request);
      if (typeof body?.ticket !== "string") {
        return json({ error: "Invalid ticket" }, 400);
      }

      const key = `ws-ticket:${await hash(body.ticket)}`;
      const result = await this.ctx.storage.transaction(async (txn) => {
        const ticket = await txn.get<{
          role: "phone" | "controller";
          deviceId: string;
          expiresAt: number;
        }>(key);

        if (!ticket || ticket.expiresAt <= Date.now()) {
          if (ticket) await txn.delete(key);
          return null;
        }

        const device = await txn.get<DeviceRecord>(`device:${ticket.deviceId}`);
        await txn.delete(key);

        if (!device || device.revoked) return null;

        return { role: ticket.role, deviceId: ticket.deviceId };
      });

      if (!result) return json({ error: "Invalid or expired ticket" }, 401);
      return json(result);
    }

    if (path === "/api/device/verify" && request.method === "POST") {
      const body = await bodyJson(request);

      if (
        !body ||
        typeof body.deviceId !== "string" ||
        typeof body.token !== "string" ||
        body.token.length < 32 ||
        body.token.length > 256 ||
        !isValidDeviceId(body.deviceId)
      ) {
        return json({ error: "Invalid device credentials" }, 400);
      }

      const record = await this.ctx.storage.get<DeviceRecord>(
        `device:${body.deviceId}`
      );

      if (
        !record ||
        record.revoked ||
        !safeEqual(record.tokenHash, await hash(body.token))
      ) {
        return json({ error: "Invalid device credentials" }, 401);
      }

      record.lastSeen = Date.now();
      await this.ctx.storage.put(`device:${body.deviceId}`, record);

      return json({ ok: true, deviceId: record.deviceId });
    }

    return json({ error: "Not found" }, 404);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const sender = ws.deserializeAttachment() as
      | { role?: string; deviceId?: string }
      | null;

    if (
      !sender ||
      (sender.role !== "phone" && sender.role !== "controller") ||
      !sender.deviceId
    ) {
      ws.close(1008, "Invalid session");
      return;
    }

    const text = typeof message === "string"
      ? message
      : new TextDecoder().decode(message);

    if (new TextEncoder().encode(text).byteLength > 64_000) {
      ws.close(1009, "Message too large");
      return;
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      ws.close(1008, "Invalid message");
      return;
    }

    const validated = validateSignalingMessage(data);
    if (!validated) {
      ws.close(1008, "Invalid signaling payload");
      return;
    }

    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;

      const recipient = peer.deserializeAttachment() as
        | { role?: string; deviceId?: string }
        | null;

      if (
        !recipient ||
        recipient.deviceId !== sender.deviceId ||
        recipient.role === sender.role
      ) {
        continue;
      }

      try {
        peer.send(JSON.stringify(validated));
      } catch {}
    }
  }

  async webSocketClose(ws: WebSocket) {
    const sender = ws.deserializeAttachment() as
      | { role?: string; deviceId?: string }
      | null;

    if (!sender?.deviceId || !sender.role) return;

    const sockets = this.ctx.getWebSockets();
    const replacementExists = sockets.some((peer) => {
      if (peer === ws) return false;

      const attachment = peer.deserializeAttachment() as
        | { role?: string; deviceId?: string }
        | null;

      return attachment?.deviceId === sender.deviceId &&
        attachment?.role === sender.role;
    });

    if (replacementExists) return;

    for (const peer of sockets) {
      if (peer === ws) continue;

      const recipient = peer.deserializeAttachment() as
        | { role?: string; deviceId?: string }
        | null;

      if (
        recipient?.deviceId === sender.deviceId &&
        recipient.role !== sender.role
      ) {
        try {
          peer.send(JSON.stringify({ type: "peer-left" }));
        } catch {}
      }
    }
  }

  async webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "WebSocket error");
    } catch {}
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "HP WEB Signaling",
        registrationApi: true,
      });
    }

    if (url.pathname.startsWith("/api/")) {
      const registryId = env.Chat.idFromName("__hp_registry_v1__");
      const registry = env.Chat.get(registryId);
      return registry.fetch(request);
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      const ticket = url.searchParams.get("ticket");
      if (!ticket || ticket.length < 32 || ticket.length > 256) {
        return new Response("WebSocket ticket required", { status: 401 });
      }

      const registryId = env.Chat.idFromName("__hp_registry_v1__");
      const registry = env.Chat.get(registryId);

      const consumeRequest = new Request(
        "https://registry.internal/api/ws-ticket/consume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Worker": env.DEVICE_REGISTRATION_SECRET,
          },
          body: JSON.stringify({ ticket }),
        }
      );

      const ticketResponse = await registry.fetch(consumeRequest);
      if (!ticketResponse.ok) {
        return new Response("Invalid or expired WebSocket ticket", {
          status: 401,
        });
      }

      const session = await ticketResponse.json() as {
        role: "phone" | "controller";
        deviceId: string;
      };

      const roomId = env.Chat.idFromName(`device:${session.deviceId}`);
      const room = env.Chat.get(roomId);

      const targetUrl = new URL(request.url);
      targetUrl.search = "";
      targetUrl.searchParams.set("role", session.role);
      targetUrl.searchParams.set("deviceId", session.deviceId);

      return room.fetch(new Request(targetUrl.toString(), request));
    }

    return new Response("HP WEB Signaling Server");
  },
};
