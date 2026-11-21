import React, { useCallback, useEffect, useRef, useState } from "react";
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
  online?: boolean;
};

type ApiError = { error?: string };

type MediaItem = {
  key: string;
  size: number;
  uploadedAt: string;
  etag: string;
  category: string;
  fileName: string;
  contentType: string;
};

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
  const [mediaDeviceId, setMediaDeviceId] = useState("");
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const [playingMedia, setPlayingMedia] = useState<{ key: string; url: string; contentType: string; fileName: string } | null>(null);
  const [screenDeviceId, setScreenDeviceId] = useState("");
  const [screenStatus, setScreenStatus] = useState("idle");
  const [screenMessage, setScreenMessage] = useState("");
  const screenSocket = useRef<WebSocket | null>(null);
  const screenPeer = useRef<RTCPeerConnection | null>(null);
  const screenChannel = useRef<RTCDataChannel | null>(null);
  const screenRequestId = useRef("");
  const [liveFrame, setLiveFrame] = useState("");
  const [screenShot, setScreenShot] = useState("");
  const screenPeer = useRef<RTCPeerConnection | null>(null);
  const screenChannel = useRef<RTCDataChannel | null>(null);
  const screenRequestId = useRef<string>("");
  const [liveFrame, setLiveFrame] = useState("");
  const [screenShot, setScreenShot] = useState("");

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
    if (!token) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20000);
    return () => window.clearInterval(timer);
  }, [token, refresh]);

  async function loadMedia(deviceId: string) {
    if (!deviceId) return;
    setMediaBusy(true);
    setMediaError("");
    setPlayingMedia(null);
    try {
      const result = await api<{ media: MediaItem[] }>(
        `media?deviceId=${encodeURIComponent(deviceId)}`, token,
      );
      setMediaItems(result.media || []);
      setMediaDeviceId(deviceId);
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : "Unable to load recordings");
      setMediaItems([]);
    } finally {
      setMediaBusy(false);
    }
  }

  async function playMedia(item: MediaItem) {
    setMediaBusy(true);
    setMediaError("");
    try {
      const result = await api<{ url: string }>("media/access", token, {
        deviceId: mediaDeviceId,
        key: item.key,
      });
      setPlayingMedia({
        key: item.key,
        url: new URL(result.url, window.location.origin).toString(),
        contentType: item.contentType,
        fileName: item.fileName,
      });
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : "Unable to open recording");
    } finally {
      setMediaBusy(false);
    }
  }

  function closeScreenSocket(sendStop = false) {
    const socket = screenSocket.current;
    if (socket && socket.readyState === WebSocket.OPEN && sendStop && screenRequestId.current) {
      socket.send(JSON.stringify({ type: "screen-share-stop", requestId: screenRequestId.current }));
    }
    try { screenChannel.current?.close(); } catch {}
    screenChannel.current = null;
    try { screenPeer.current?.close(); } catch {}
    screenPeer.current = null;
    if (socket) {
      if (!sendStop) { socket.close(); screenSocket.current = null; }
    }
  }

  async function requestScreenShare() {
    if (!screenDeviceId) {
      setScreenMessage("Select an authorized phone first.");
      return;
    }
    closeScreenSocket();
    setLiveFrame("");
    setScreenShot("");
    setScreenStatus("connecting");
    setScreenMessage("Connecting securely to the selected phone…");
    try {
      const result = await api<{ ticket: string }>("ws-ticket/controller", token, { deviceId: screenDeviceId });
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${scheme}//${window.location.host}/ws?ticket=${encodeURIComponent(result.ticket)}`);
      screenSocket.current = socket;
      socket.onopen = async () => {
        setScreenStatus("requesting");
        setScreenMessage("Connected. Sending the screen-sharing request…");
        const requestId = crypto.randomUUID();
        screenRequestId.current = requestId;
        socket.send(JSON.stringify({ type: "screen-share-request", requestId }));
        try {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] });
          screenPeer.current = pc;
          const channel = pc.createDataChannel("hp-screen", { ordered: true });
          screenChannel.current = channel;
          channel.onopen = () => setScreenMessage("Secure screen data channel connected. Waiting for approved screen frames…");
          channel.onmessage = (message) => {
            const value = String(message.data || "");
            if (value.startsWith("HP_FRAME:")) setLiveFrame("data:image/jpeg;base64," + value.slice(9));
            if (value.startsWith("HP_SCREENSHOT:")) setScreenShot("data:image/jpeg;base64," + value.slice(13));
          };
          pc.onicecandidate = (event) => {
            if (event.candidate && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "candidate", candidate: event.candidate.toJSON() }));
            }
          };
          pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed") {
              setScreenStatus("error");
              setScreenMessage("WebRTC connection failed. Check phone connectivity and retry.");
            }
          };
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
        } catch (err) {
          setScreenStatus("error");
          setScreenMessage(err instanceof Error ? err.message : "Unable to start WebRTC screen transport.");
        }
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; status?: string; message?: string; sdp?: string; candidate?: RTCIceCandidateInit };
          if (message.type === "answer" && message.sdp && screenPeer.current) {
            void screenPeer.current.setRemoteDescription({ type: "answer", sdp: message.sdp });
          } else if (message.type === "candidate" && message.candidate && screenPeer.current) {
            void screenPeer.current.addIceCandidate(message.candidate).catch(() => {});
          } else if (message.type === "screen-share-status") {
            const status = message.status || "unknown";
            setScreenStatus(status);
            const descriptions: Record<string, string> = {
              "consent-required": "Open the phone app and approve Android’s screen-capture prompt.",
              started: "The phone confirms capture is active. Establishing the live screen feed…",
              stopped: "Screen sharing has stopped.",
              denied: "Screen sharing was declined on the phone.",
              unsupported: "This phone app version does not support screen sharing yet.",
              error: message.message || "The phone reported a screen-sharing error.",
            };
            setScreenMessage(descriptions[status] || message.message || `Phone status: ${status}`);
          }
        } catch {
          setScreenMessage("Received an unreadable response from the phone.");
        }
      };
      socket.onerror = () => {
        setScreenStatus("error");
        setScreenMessage("Secure connection failed. Check that the phone is online.");
      };
      socket.onclose = () => {
        if (screenSocket.current === socket) screenSocket.current = null;
        setScreenStatus((current) => current === "stopped" ? current : "disconnected");
      };
    } catch (err) {
      setScreenStatus("error");
      setScreenMessage(err instanceof Error ? err.message : "Unable to request screen sharing.");
    }
  }

  function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value < 0) return "Unknown size";
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

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
        <article className="hp-stat"><span>Authorized devices</span><strong>{devices.filter((d) => !d.revoked).length}</strong></article>
        <article className="hp-stat"><span>Online now</span><strong>{devices.filter((d) => !d.revoked && d.online).length}</strong></article>
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
                    <span className={device.revoked ? "hp-status hp-status-off" : device.online ? "hp-status hp-status-on" : "hp-status hp-status-off"}>
                      {device.revoked ? "Revoked" : device.online ? "Online" : "Offline"}
                    </span>
                  </div>
                  <span className="hp-device-id">{device.deviceId}</span>
                  <span>Last connected: {dateLabel(device.lastSeen)}</span>
                  <span>Access: {device.revoked ? "Revoked" : "Authorized"}</span>
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

      <section className="hp-panel">
        <div className="hp-section-heading">
          <div><p className="hp-eyebrow">PRIVATE CLOUD STORAGE</p><h2>Recordings</h2></div>
          <button className="hp-button hp-secondary" disabled={mediaBusy || !mediaDeviceId} onClick={() => void loadMedia(mediaDeviceId)}>Refresh recordings</button>
        </div>
        <p className="hp-muted">Recordings are stored privately in Cloudflare R2 and can only be opened from an authenticated administrator session.</p>
        <label htmlFor="media-device">Select phone</label>
        <select id="media-device" value={mediaDeviceId} onChange={(event) => void loadMedia(event.target.value)}>
          <option value="">Choose an authorized device</option>
          {devices.filter((device) => !device.revoked).map((device) => (
            <option key={device.deviceId} value={device.deviceId}>{device.label || "Android device"} · {device.deviceId}</option>
          ))}
        </select>
        {mediaBusy && <p className="hp-muted" role="status">Loading recordings…</p>}
        {mediaError && <p className="hp-alert hp-error" role="alert">{mediaError}</p>}
        {mediaDeviceId && !mediaBusy && mediaItems.length === 0 && !mediaError && (
          <div className="hp-empty">No uploaded recordings were found for this device.</div>
        )}
        {mediaItems.length > 0 && (
          <div className="hp-list">
            {mediaItems.map((item) => (
              <article className="hp-device" key={item.key}>
                <div className="hp-device-main">
                  <strong>{item.fileName}</strong>
                  <span>{item.category.replaceAll("_", " ")} · {formatBytes(item.size)}</span>
                  <span>Uploaded: {dateLabel(Date.parse(item.uploadedAt))}</span>
                </div>
                <div className="hp-actions">
                  <button className="hp-button hp-primary" disabled={mediaBusy} onClick={() => void playMedia(item)}>
                    {playingMedia?.key === item.key ? "Reload player" : "Play"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {playingMedia && (
          <div className="hp-media-player">
            <h3>{playingMedia.fileName}</h3>
            {playingMedia.contentType.startsWith("video/") ? (
              <video controls playsInline preload="metadata" src={playingMedia.url} style={{ width: "100%", maxHeight: "65vh", background: "#000" }} />
            ) : (
              <audio controls preload="metadata" src={playingMedia.url} style={{ width: "100%" }} />
            )}
          </div>
        )}
      </section>

      <section className="hp-panel">
        <p className="hp-eyebrow">REMOTE CONTROL</p>
        <h2>Live screen and screenshot</h2>
        <p className="hp-muted">Choose an authorized phone and request a screen-sharing session. The phone user must approve Android’s screen-capture prompt before any screen content can be shared.</p>
        <label htmlFor="screen-device">Select phone</label>
        <select id="screen-device" value={screenDeviceId} onChange={(event) => setScreenDeviceId(event.target.value)}>
          <option value="">Choose an authorized device</option>
          {devices.filter((device) => !device.revoked).map((device) => (
            <option key={device.deviceId} value={device.deviceId}>{device.label || "Android device"} · {device.deviceId}</option>
          ))}
        </select>
        <div className="hp-actions">
          <button className="hp-button hp-primary" onClick={() => void requestScreenShare()} disabled={!screenDeviceId || screenStatus === "connecting" || screenStatus === "requesting"}>
            {screenStatus === "connecting" ? "Connecting…" : "Request screen sharing"}
          </button>
          <button className="hp-button hp-secondary" onClick={() => { closeScreenSocket(true); setScreenStatus("stopping"); setScreenMessage("Stop request sent. Waiting for the phone to confirm capture has stopped…"); }} disabled={!screenSocket.current}>
            Stop sharing
          </button>
        </div>
        <p className="hp-muted" role="status">{screenMessage || "No screen-sharing session is active."}</p>
        <div className="hp-actions">
          <button className="hp-button hp-secondary" disabled={!screenChannel.current || screenChannel.current.readyState !== "open"} onClick={() => screenChannel.current?.send("HP_SCREENSHOT_REQUEST")}>Capture screenshot</button>
        </div>
        {liveFrame && <div className="hp-media-player"><h3>Live phone screen</h3><img src={liveFrame} alt="Live phone screen" style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", background: "#000" }} /></div>}
        {screenShot && <div className="hp-media-player"><h3>Controller screenshot</h3><img src={screenShot} alt="Captured phone screen" style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", background: "#000" }} /></div>}
        <p className="hp-footnote">Screen frames and screenshots are displayed in this Controller session; they are not saved to the phone’s Gallery or Vault.</p>
      </section>
      <footer className="hp-footer">HP Web Controller · Secure administrator session</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
