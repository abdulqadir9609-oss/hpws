import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type PendingDevice = {
  installId: string;
  label: string;
  createdAt: number;
};

type Device = {
  deviceId: string;
  label: string;
  createdAt: number;
  lastSeen: number | null;
  revoked: boolean;
};

type ApiError = { error?: string };

const API_BASE = "";

async function api<T>(
  path: string,
  token?: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${API_BASE}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function dateLabel(value: number | null): string {
  if (!value) return "Never connected";
  return new Date(value).toLocaleString();
}

function App() {
  const [token, setToken] = useState(() => {
    try { return sessionStorage.getItem("hp-admin-session") || ""; }
    catch { return ""; }
  });
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const [pendingResult, deviceResult] = await Promise.all([
        api<{ devices: PendingDevice[] }>("devices/pending", token),
        api<{ devices: Device[] }>("devices", token),
      ]);
      setPending(pendingResult.devices);
      setDevices(deviceResult.devices);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load devices";
      setError(message);
      if (message.toLowerCase().includes("unauthorized")) {
        setToken("");
        try { sessionStorage.removeItem("hp-admin-session"); } catch {}
      }
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) void refresh();
  }, [token, refresh]);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ token: string }>("admin/session", undefined, { secret });
      setToken(result.token);
      try { sessionStorage.setItem("hp-admin-session", result.token); } catch {}
      setSecret("");
      setNotice("Administrator session started.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  async function decide(installId: string, action: "approve" | "reject") {
    const label = action === "approve" ? "approve this device" : "reject this registration";
    if (!window.confirm(`Are you sure you want to ${label}?`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ deviceId?: string }>(`devices/${action}`, token, { installId });
      setNotice(action === "approve"
        ? `Device approved: ${result.deviceId || "assigned"}`
        : "Device registration rejected.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string) {
    if (!window.confirm(`Revoke access for ${deviceId}? Its active connection will be closed.`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ disconnectWarning?: boolean }>("devices/revoke", token, { deviceId });
      setNotice(result.disconnectWarning
        ? `${deviceId} is revoked. Disconnect retry has been scheduled.`
        : `${deviceId} has been revoked.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to revoke device");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    setToken("");
    setPending([]);
    setDevices([]);
    setNotice("");
    setError("");
    try { sessionStorage.removeItem("hp-admin-session"); } catch {}
  }

  if (!token) {
    return (
      <main className="hp-shell">
        <section className="hp-login">
          <div className="hp-mark">HP</div>
          <p className="hp-eyebrow">SECURE DEVICE MANAGEMENT</p>
          <h1>HP Web Controller</h1>
          <p className="hp-muted">Sign in with your administrator secret to manage registered phones.</p>
          <form onSubmit={login} className="hp-form">
            <label htmlFor="admin-secret">Administrator secret</label>
            <input
              id="admin-secret"
              type="password"
              autoComplete="current-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              required
              minLength={1}
              placeholder="Enter administrator secret"
            />
            <button type="submit" disabled={busy || !secret.trim()}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {error && <p className="hp-alert hp-error" role="alert">{error}</p>}
          <p className="hp-footnote">Your administrator secret is sent only to this Worker over HTTPS and is not saved in this browser.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="hp-shell">
      <header className="hp-header">
        <div className="hp-brand">
          <div className="hp-mark">HP</div>
          <div><p className="hp-eyebrow">SECURE DEVICE MANAGEMENT</p><h1>HP Web Controller</h1></div>
        </div>
        <div className="hp-header-actions">
          <button className="hp-button hp-secondary" onClick={() => void refresh()} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
          <button className="hp-button hp-quiet" onClick={logout}>Sign out</button>
        </div>
      </header>

      {error && <p className="hp-alert hp-error" role="alert">{error}</p>}
      {notice && <p className="hp-alert hp-success" role="status">{notice}</p>}

      <section className="hp-stats">
        <article className="hp-stat"><span>Pending approvals</span><strong>{pending.length}</strong></article>
        <article className="hp-stat"><span>Registered devices</span><strong>{devices.filter((d) => !d.revoked).length}</strong></article>
        <article className="hp-stat"><span>Revoked devices</span><strong>{devices.filter((d) => d.revoked).length}</strong></article>
      </section>

      <section className="hp-panel">
        <div className="hp-section-heading">
          <div><p className="hp-eyebrow">REGISTRATION QUEUE</p><h2>Pending devices</h2></div>
          <span className="hp-count">{pending.length}</span>
        </div>
        {pending.length === 0 ? (
          <div className="hp-empty">No devices are waiting for approval.</div>
        ) : (
          <div className="hp-list">
            {pending.map((item) => (
              <article className="hp-device" key={item.installId}>
                <div className="hp-device-main">
                  <strong>{item.label || "Android device"}</strong>
                  <span>Requested {dateLabel(item.createdAt)}</span>
                  <code>{item.installId}</code>
                </div>
                <div className="hp-actions">
                  <button className="hp-button hp-primary" disabled={busy} onClick={() => void decide(item.installId, "approve")}>Approve</button>
                  <button className="hp-button hp-danger" disabled={busy} onClick={() => void decide(item.installId, "reject")}>Reject</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="hp-panel">
        <div className="hp-section-heading">
          <div><p className="hp-eyebrow">DEVICE ACCESS</p><h2>Registered devices</h2></div>
          <span className="hp-count">{devices.length}</span>
        </div>
        {devices.length === 0 ? (
          <div className="hp-empty">No registered devices yet. Approve a phone after it requests registration.</div>
        ) : (
          <div className="hp-list">
            {devices.map((device) => (
              <article className="hp-device" key={device.deviceId}>
                <div className="hp-device-main">
                  <div className="hp-device-title">
                    <strong>{device.label || "Android device"}</strong>
                    <span className={device.revoked ? "hp-status hp-status-off" : "hp-status hp-status-on"}>
                      {device.revoked ? "Revoked" : "Authorized"}
                    </span>
                  </div>
                  <span className="hp-device-id">{device.deviceId}</span>
                  <span>Last connected: {dateLabel(device.lastSeen)}</span>
                </div>
                {!device.revoked && (
                  <div className="hp-actions">
                    <button className="hp-button hp-danger" disabled={busy} onClick={() => void revoke(device.deviceId)}>Revoke access</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="hp-panel hp-limitation">
        <p className="hp-eyebrow">REMOTE CONTROL</p>
        <h2>Live screen and screenshot</h2>
        <p>Device approval and access management are connected. Live screen viewing and screenshot requests are not enabled yet: the Android app must implement the matching WebRTC and MediaProjection flow before these controls can work safely.</p>
      </section>
      <footer className="hp-footer">HP Web Controller · Secure administrator session</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
