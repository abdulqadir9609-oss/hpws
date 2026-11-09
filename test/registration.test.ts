import { env, exports } from "cloudflare:workers";
import { validateSignalingMessage } from "../src/server/signaling";

import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const ADMIN_SECRET = "hpws-vitest-only-secret-not-production";

async function api(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {}
) {
  return exports.default.fetch(
    `https://hpws.test${path}`,
    {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }
  );
}

function newDevice() {
  return {
    installId: crypto.randomUUID().replace(/-/g, ""),
    proof: crypto.randomUUID() + crypto.randomUUID(),
    label: "Vitest Android",
  };
}

async function loginAdmin() {
  const response = await api("/api/admin/session", "POST", {
    secret: ADMIN_SECRET,
  });

  expect(response.status).toBe(200);

  const data = await response.json() as { token: string };
  return data.token;
}

async function registerDevice(device: ReturnType<typeof newDevice>) {
  return api("/api/device/register", "POST", device);
}

describe("WebRTC signaling payload validation", () => {
  const validate = validateSignalingMessage;

  it("accepts the SDP string format sent by the HP Flutter app", () => {
    const sdp = "v=0\\r\\no=- 123 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\n";
    expect(validate({ type: "offer", sdp })).toEqual({ type: "offer", sdp });
    expect(validate({ type: "answer", sdp })).toEqual({ type: "answer", sdp });
  });

  it("accepts the object SDP format used by WebRTC clients", () => {
    const sdp = "v=0\\r\\no=- 123 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\n";
    expect(validate({ type: "offer", sdp: { type: "offer", sdp } }))
      .toEqual({ type: "offer", sdp });
  });

  it("accepts structured and string ICE candidates", () => {
    const candidate = "candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host";
    expect(validate({ type: "candidate", candidate }))
      .toEqual({ type: "candidate", candidate });
    expect(validate({
      type: "candidate",
      candidate: { candidate, sdpMid: "0", sdpMLineIndex: 0 },
    })).toEqual({
      type: "candidate",
      candidate: { candidate, sdpMid: "0", sdpMLineIndex: 0 },
    });
  });

  it("rejects malformed or oversized SDP and ICE candidate payloads", () => {
    expect(validate({ type: "offer", sdp: "" })).toBeNull();
    expect(validate({ type: "answer", sdp: "x".repeat(48_001) })).toBeNull();
    expect(validate({ type: "candidate", candidate: "" })).toBeNull();
    expect(validate({ type: "candidate", candidate: "x".repeat(8_193) })).toBeNull();
    expect(validate({ type: "candidate", candidate: { candidate: "x", sdpMLineIndex: -1 } })).toBeNull();
    expect(validate({ type: "candidate", candidate: { candidate: "x", sdpMLineIndex: 1.5 } })).toBeNull();
    expect(validate({ type: "candidate", candidate: { candidate: "x", sdpMid: 7 } })).toBeNull();
    expect(validate({ type: "join", role: "hp-app" })).toBeNull();
    expect(validate(null)).toBeNull();
    expect(validate([])).toBeNull();
  });
});

describe("HPWS Device Registration and Security", () => {
  it("assigns the finalized stable multi-device ID format", async () => {
    const adminToken = await loginAdmin();
    const expected = [
      "HPPHONE1",
      "HPPHONE..2",
      "HPPHONE...3",
      "HPPHONE....4",
      "HPPHONE.....5",
    ];

    for (const deviceId of expected) {
      const device = newDevice();
      await registerDevice(device);

      const approval = await api(
        "/api/devices/approve",
        "POST",
        { installId: device.installId },
        { Authorization: `Bearer ${adminToken}` }
      );

      expect(approval.status).toBe(200);
      const data = await approval.json() as { deviceId: string };
      expect(data.deviceId).toBe(deviceId);
    }
  });

  it("registers a valid device as pending", async () => {
    const device = newDevice();
    const response = await registerDevice(device);
    const data = await response.json() as { ok: boolean; status: string };

    expect(response.status).toBe(202);
    expect(data.ok).toBe(true);
    expect(data.status).toBe("pending");
  });

  it("rejects invalid registration data", async () => {
    const response = await api("/api/device/register", "POST", {
      installId: "invalid",
      proof: "short",
    });

    expect(response.status).toBe(400);
  });

  it("returns the existing registration for the same identity", async () => {
    const device = newDevice();

    await registerDevice(device);

    const duplicate = await registerDevice(device);
    const data = await duplicate.json() as { status: string };

    expect(duplicate.status).toBe(202);
    expect(data.status).toBe("pending");

    const conflict = await registerDevice({
      ...device,
      proof: crypto.randomUUID() + crypto.randomUUID(),
    });

    expect(conflict.status).toBe(409);
  });

  it("returns approved status for a duplicate approved registration", async () => {
    const device = newDevice();
    await registerDevice(device);
    const adminToken = await loginAdmin();

    const approval = await api(
      "/api/devices/approve",
      "POST",
      { installId: device.installId },
      { Authorization: `Bearer ${adminToken}` }
    );
    expect(approval.status).toBe(200);

    const duplicate = await registerDevice(device);
    const data = await duplicate.json() as {
      ok: boolean;
      status: string;
      message: string;
    };

    expect(duplicate.status).toBe(200);
    expect(data).toEqual({
      ok: true,
      status: "approved",
      message: "Device already approved",
    });
  });

  it("returns rejected status for a duplicate rejected registration", async () => {
    const device = newDevice();
    await registerDevice(device);
    const adminToken = await loginAdmin();

    const rejection = await api(
      "/api/devices/reject",
      "POST",
      { installId: device.installId },
      { Authorization: `Bearer ${adminToken}` }
    );
    expect(rejection.status).toBe(200);

    const duplicate = await registerDevice(device);
    const data = await duplicate.json() as {
      ok: boolean;
      status: string;
      message: string;
    };

    expect(duplicate.status).toBe(200);
    expect(data).toEqual({
      ok: true,
      status: "rejected",
      message: "Device registration was rejected",
    });
  });

  it("requires administrator authentication", async () => {
    const response = await api("/api/devices/pending");

    expect(response.status).toBe(401);
  });

  it("rejects incorrect administrator credentials", async () => {
    const response = await api("/api/admin/session", "POST", {
      secret: "incorrect-secret",
    });

    expect(response.status).toBe(401);
  });

  it("allows admin to approve a device and issue credentials", async () => {
    const device = newDevice();
    await registerDevice(device);

    const adminToken = await loginAdmin();
    const headers = { Authorization: `Bearer ${adminToken}` };

    const approval = await api(
      "/api/devices/approve",
      "POST",
      { installId: device.installId },
      headers
    );

    expect(approval.status).toBe(200);

    const approved = await approval.json() as {
      ok: boolean;
      deviceId: string;
    };

    expect(approved.ok).toBe(true);
    expect(approved.deviceId).toMatch(
      /^HPPHONE(?:1|\\.{2,}[2-9]\\d*)$/
    );

    const status = await api("/api/device/status", "POST", {
      installId: device.installId,
      proof: device.proof,
    });

    const credentials = await status.json() as {
      status: string;
      deviceId: string;
      token: string;
    };

    expect(status.status).toBe(200);
    expect(credentials.status).toBe("approved");
    expect(credentials.deviceId).toBe(approved.deviceId);
    expect(credentials.token).toBeTruthy();

    const acknowledgement = await api("/api/device/ack", "POST", {
      installId: device.installId,
      proof: device.proof,
    });

    expect(acknowledgement.status).toBe(200);

    const verify = await api("/api/device/verify", "POST", {
      deviceId: credentials.deviceId,
      token: credentials.token,
    });

    expect(verify.status).toBe(200);

    const phoneTicket = await api("/api/ws-ticket/phone", "POST", {
      deviceId: credentials.deviceId,
      token: credentials.token,
    });

    expect(phoneTicket.status).toBe(200);

    const controllerTicket = await api(
      "/api/ws-ticket/controller",
      "POST",
      { deviceId: credentials.deviceId },
      headers
    );

    expect(controllerTicket.status).toBe(200);

    const registry = env.Chat.get(
      env.Chat.idFromName("__hp_registry_v1__")
    );

    const authorizeRequest = (secret: string) =>
      registry.fetch(
        new Request("https://registry.internal/internal/device-authorize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Worker": secret,
          },
          body: JSON.stringify({ deviceId: credentials.deviceId }),
        })
      );

    const authorizedBeforeRevoke = await authorizeRequest(ADMIN_SECRET);
    expect(authorizedBeforeRevoke.status).toBe(200);
    expect(await authorizedBeforeRevoke.json()).toEqual({ authorized: true });

    const wrongSecret = await authorizeRequest("incorrect-internal-secret");
    expect(wrongSecret.status).toBe(403);

    const revoke = await api(
      "/api/devices/revoke",
      "POST",
      { deviceId: credentials.deviceId },
      headers
    );

    expect(revoke.status).toBe(200);
    const revokeData = await revoke.json() as {
      ok: boolean;
      deviceId: string;
      revoked: boolean;
      disconnectWarning: boolean;
    };
    expect(revokeData).toEqual({
      ok: true,
      deviceId: credentials.deviceId,
      revoked: true,
      disconnectWarning: false,
    });

    const authorizedAfterRevoke = await authorizeRequest(ADMIN_SECRET);
    expect(authorizedAfterRevoke.status).toBe(200);
    expect(await authorizedAfterRevoke.json()).toEqual({ authorized: false });

    // A revoked device must not reconnect to its Durable Object room.
    const roomId = env.Chat.idFromName(`device:${credentials.deviceId}`);
    const room = env.Chat.get(roomId);
    const revokedConnection = await room.fetch(
      new Request(
        `https://device.test/ws?role=phone&deviceId=${credentials.deviceId}`,
        { headers: { Upgrade: "websocket" } }
      )
    );

    expect(revokedConnection.status).toBe(403);

    const verifyAfterRevoke = await api("/api/device/verify", "POST", {
      deviceId: credentials.deviceId,
      token: credentials.token,
    });

    expect(verifyAfterRevoke.status).toBe(401);

    const newPhoneTicket = await api("/api/ws-ticket/phone", "POST", {
      deviceId: credentials.deviceId,
      token: credentials.token,
    });

    expect(newPhoneTicket.status).toBe(401);
  });

  it("allows admin to reject a pending device", async () => {
    const device = newDevice();
    await registerDevice(device);

    const adminToken = await loginAdmin();

    const rejection = await api(
      "/api/devices/reject",
      "POST",
      { installId: device.installId },
      { Authorization: `Bearer ${adminToken}` }
    );

    expect(rejection.status).toBe(200);

    const status = await api("/api/device/status", "POST", {
      installId: device.installId,
      proof: device.proof,
    });

    const data = await status.json() as { status: string };

    expect(data.status).toBe("rejected");
  });

  it("does not count rejected devices toward the pending queue limit", async () => {
    const adminToken = await loginAdmin();
    const headers = { Authorization: `Bearer ${adminToken}` };

    for (let i = 0; i < 100; i++) {
      const device = newDevice();
      const registration = await registerDevice(device);
      expect(registration.status).toBe(202);

      const rejection = await api(
        "/api/devices/reject",
        "POST",
        { installId: device.installId },
        headers
      );

      expect(rejection.status).toBe(200);
    }

    const freshDevice = newDevice();
    const response = await registerDevice(freshDevice);
    const data = await response.json() as { status?: string };

    expect(response.status).toBe(202);
    expect(data.status).toBe("pending");
  });

  it("returns 409 when an administrator tries to approve a rejected device", async () => {
    const device = newDevice();
    await registerDevice(device);

    const adminToken = await loginAdmin();
    const headers = { Authorization: `Bearer ${adminToken}` };

    const rejection = await api(
      "/api/devices/reject",
      "POST",
      { installId: device.installId },
      headers
    );

    expect(rejection.status).toBe(200);

    const approval = await api(
      "/api/devices/approve",
      "POST",
      { installId: device.installId },
      headers
    );

    expect(approval.status).toBe(409);
  });

  it("allows a WebSocket ticket to be consumed only once", async () => {
    const device = newDevice();
    await registerDevice(device);

    const adminToken = await loginAdmin();
    const headers = { Authorization: `Bearer ${adminToken}` };

    const approval = await api(
      "/api/devices/approve",
      "POST",
      { installId: device.installId },
      headers
    );
    expect(approval.status).toBe(200);

    const status = await api("/api/device/status", "POST", {
      installId: device.installId,
      proof: device.proof,
    });

    const credentials = await status.json() as {
      deviceId: string;
      token: string;
    };

    const ticketResponse = await api("/api/ws-ticket/phone", "POST", {
      deviceId: credentials.deviceId,
      token: credentials.token,
    });
    expect(ticketResponse.status).toBe(200);

    const ticketData = await ticketResponse.json() as { ticket: string };
    const internalHeaders = {
      "X-Internal-Worker": ADMIN_SECRET,
    };

    const wrongSecret = await api(
      "/api/ws-ticket/consume",
      "POST",
      { ticket: ticketData.ticket },
      { "X-Internal-Worker": "wrong-internal-secret" }
    );
    expect(wrongSecret.status).toBe(403);

    const firstUse = await api(
      "/api/ws-ticket/consume",
      "POST",
      { ticket: ticketData.ticket },
      internalHeaders
    );
    expect(firstUse.status).toBe(200);

    const session = await firstUse.json() as {
      role: string;
      deviceId: string;
    };
    expect(session.role).toBe("phone");
    expect(session.deviceId).toBe(credentials.deviceId);

    const secondUse = await api(
      "/api/ws-ticket/consume",
      "POST",
      { ticket: ticketData.ticket },
      internalHeaders
    );
    expect(secondUse.status).toBe(401);
  });


  it("rejects invalid install IDs and proofs in status and acknowledgement", async () => {
    const invalidBodies = [
      { installId: "short", proof: "a".repeat(40) },
      { installId: "A".repeat(16), proof: "short" },
      { installId: "A".repeat(16), proof: "a".repeat(257) },
    ];

    for (const body of invalidBodies) {
      const status = await api("/api/device/status", "POST", body);
      const ack = await api("/api/device/ack", "POST", body);

      expect(status.status).toBe(400);
      expect(ack.status).toBe(400);
    }
  });

  it("rejects malformed IDs and invalid phone token lengths", async () => {
    const adminToken = await loginAdmin();
    const headers = { Authorization: `Bearer ${adminToken}` };

    const invalidInstallId = "invalid!";
    const invalidDeviceId = "NOT-A-DEVICE";

    for (const path of ["/api/devices/approve", "/api/devices/reject"]) {
      const response = await api(path, "POST", {
        installId: invalidInstallId,
      }, headers);
      expect(response.status).toBe(400);
    }

    for (const path of [
      "/api/devices/revoke",
      "/api/ws-ticket/controller",
    ]) {
      const response = await api(path, "POST", {
        deviceId: invalidDeviceId,
      }, headers);
      expect(response.status).toBe(400);
    }

    const invalidDevice = await api("/api/ws-ticket/phone", "POST", {
      deviceId: invalidDeviceId,
      token: "x".repeat(32),
    });
    expect(invalidDevice.status).toBe(400);

    for (const token of ["x".repeat(31), "x".repeat(257)]) {
      const response = await api("/api/ws-ticket/phone", "POST", {
        deviceId: "HPPHONE1",
        token,
      });
      expect(response.status).toBe(400);
    }
  });

  it("cleans expired WebSocket tickets and admin login rate limits with the alarm", async () => {
    const registry = env.Chat.get(
      env.Chat.idFromName("__hp_registry_v1__")
    );
    const expiredTicketKey = "ws-ticket:test-expired-cleanup";
    const expiredRateLimitKey = "admin-login:test-expired-cleanup";

    await runInDurableObject(registry, async (_instance, state) => {
      await state.storage.put(expiredTicketKey, {
        role: "phone",
        deviceId: "HPPHONE1",
        expiresAt: Date.now() - 1,
      });
      await state.storage.put(expiredRateLimitKey, {
        attempts: 5,
        resetAt: Date.now() - 1,
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const alarmRan = await runDurableObjectAlarm(registry);
    expect(alarmRan).toBe(true);

    await runInDurableObject(registry, async (_instance, state) => {
      expect(await state.storage.get(expiredTicketKey)).toBeUndefined();
      expect(await state.storage.get(expiredRateLimitKey)).toBeUndefined();
    });
  });

  it("processes a pending device revocation retry with the alarm", async () => {
    const device = newDevice();
    await registerDevice(device);
    const adminToken = await loginAdmin();

    const approval = await api(
      "/api/devices/approve",
      "POST",
      { installId: device.installId },
      { Authorization: `Bearer ${adminToken}` }
    );
    expect(approval.status).toBe(200);
    const approved = await approval.json() as { deviceId: string };

    const registry = env.Chat.get(
      env.Chat.idFromName("__hp_registry_v1__")
    );
    const retryKey = `revoke-pending:${approved.deviceId}`;

    await runInDurableObject(registry, async (_instance, state) => {
      await state.storage.put(retryKey, {
        deviceId: approved.deviceId,
        attempts: 0,
        nextAttemptAt: Date.now() - 1,
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const alarmRan = await runDurableObjectAlarm(registry);
    expect(alarmRan).toBe(true);

    await runInDurableObject(registry, async (_instance, state) => {
      expect(await state.storage.get(retryKey)).toBeUndefined();
    });

    const room = env.Chat.get(
      env.Chat.idFromName(`device:${approved.deviceId}`)
    );
    const reconnect = await room.fetch(
      new Request(
        `https://device.test/ws?role=phone&deviceId=${approved.deviceId}`,
        { headers: { Upgrade: "websocket" } }
      )
    );
    expect(reconnect.status).toBe(403);
  });

  it("rate-limits repeated failed administrator logins per IP", async () => {
    const headers = { "CF-Connecting-IP": "192.0.2.45" };

    for (let i = 0; i < 5; i++) {
      const response = await api(
        "/api/admin/session",
        "POST",
        { secret: "incorrect-secret" },
        headers
      );

      expect(response.status).toBe(401);
    }

    const blocked = await api(
      "/api/admin/session",
      "POST",
      { secret: ADMIN_SECRET },
      headers
    );

    expect(blocked.status).toBe(429);
  });

});
