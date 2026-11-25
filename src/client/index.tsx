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
  online?: boolean;
  appOpen?: boolean;
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


type LocalRecording = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  blob: Blob;
};

const RECORDINGS_DB = "hp-web-local-recordings";
const RECORDINGS_STORE = "recordings";

function openRecordingsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECORDINGS_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDINGS_STORE)) {
        db.createObjectStore(RECORDINGS_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open local recording storage"));
  });
}

async function saveLocalRecording(item: LocalRecording): Promise<void> {
  const db = await openRecordingsDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(RECORDINGS_STORE, "readwrite");
    tx.objectStore(RECORDINGS_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Unable to save recording locally"));
    tx.onabort = () => reject(tx.error || new Error("Local recording save was interrupted"));
  });
  db.close();
}

async function loadLocalRecordings(): Promise<LocalRecording[]> {
  const db = await openRecordingsDb();
  const items = await new Promise<LocalRecording[]>((resolve, reject) => {
    const request = db.transaction(RECORDINGS_STORE, "readonly")
      .objectStore(RECORDINGS_STORE).getAll();
    request.onsuccess = () => resolve((request.result as LocalRecording[]).sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error || new Error("Unable to read local recordings"));
  });
  db.close();
  return items;
}

async function deleteLocalRecording(id: string): Promise<void> {
  const db = await openRecordingsDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(RECORDINGS_STORE, "readwrite");
    tx.objectStore(RECORDINGS_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Unable to delete local recording"));
  });
  db.close();
}

function WebRecorder() {
  const previewRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const [mode, setMode] = useState<"audio" | "video">("video");
  const [facing, setFacing] = useState<"user" | "environment">("environment");
  const [active, setActive] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [items, setItems] = useState<LocalRecording[]>([]);
  const [zoom, setZoom] = useState(1);
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null);

  const refreshItems = useCallback(async () => {
    try { setItems(await loadLocalRecordings()); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to load local recordings"); }
  }, []);

  useEffect(() => { void refreshItems(); }, [refreshItems]);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
    setZoomRange(null);
    setZoom(1);
    setPreviewReady(false);
  }, []);

  async function start(modeToStart: "audio" | "video" = mode, facingToUse = facing) {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError("This browser does not support camera or microphone recording.");
      return;
    }
    setError("");
    try {
      let stream = streamRef.current;
      const hasExpectedTracks = stream && (modeToStart === "audio"
        ? stream.getAudioTracks().length > 0 && stream.getVideoTracks().length === 0
        : stream.getVideoTracks().length > 0);
      if (!hasExpectedTracks) {
        stopStream();
        stream = await navigator.mediaDevices.getUserMedia(
          modeToStart === "audio"
            ? { audio: true, video: false }
            : {
                audio: true,
                video: { facingMode: { ideal: facingToUse }, width: { ideal: 1920 }, height: { ideal: 1080 } },
              },
        );
        streamRef.current = stream;
      }
      if (!stream) {
        throw new Error("Unable to start recording: media stream is unavailable.");
      }
      if (previewRef.current && modeToStart === "video") {
        previewRef.current.srcObject = stream;
        await previewRef.current.play().catch(() => undefined);
      }
      if (modeToStart === "video") {
        const track = stream.getVideoTracks()[0];
        const caps = track?.getCapabilities?.() as MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };
        if (caps?.zoom) {
          setZoomRange({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 });
          setZoom(caps.zoom.min);
        }
      }
      chunksRef.current = [];
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "audio/webm;codecs=opus", "audio/webm"]
        .find((candidate) => MediaRecorder.isTypeSupported(candidate) &&
          (modeToStart === "video" ? candidate.startsWith("video/") : candidate.startsWith("audio/")));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onerror = () => setError("The browser reported a recording error. Check device permissions and available storage.");
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || (modeToStart === "video" ? "video/webm" : "audio/webm") });
        chunksRef.current = [];
        try {
          if (blob.size > 0) {
            const createdAt = Date.now();
            const ext = blob.type.includes("mp4") ? "mp4" : "webm";
            const item: LocalRecording = {
              id: crypto.randomUUID(),
              name: `web-${modeToStart}-${createdAt}.${ext}`,
              mimeType: blob.type,
              size: blob.size,
              createdAt,
              blob,
            };
            await saveLocalRecording(item);
            await refreshItems();
            setStatus("Recording saved in this browser's local storage.");
          } else {
            setStatus("No recording data was produced.");
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "Unable to save recording locally");
          setStatus("Recording could not be saved.");
        } finally {
          stopStream();
          setActive(false);
          recorderRef.current = null;
        }
      };
      recorder.start(1000);
      setMode(modeToStart);
      setActive(true);
      setStatus(`${modeToStart === "video" ? "Video" : "Audio"} recording is active.`);
    } catch (e) {
      stopStream();
      setError(e instanceof Error ? e.message : "Camera or microphone access was denied.");
      setStatus("Not recording");
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      setStatus("Finalizing recording…");
      recorderRef.current.stop();
    }
  }

  async function openCameraPreview() {
    if (active || mode !== "video") return;
    setError("");
    try {
      stopStream();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        await previewRef.current.play().catch(() => undefined);
      }
      const track = stream.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };
      if (caps?.zoom) {
        setZoomRange({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 });
        setZoom(caps.zoom.min);
      }
      setPreviewReady(true);
      setStatus("Camera preview ready. Start recording when you are ready.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to open camera preview.");
    }
  }

  async function switchCamera() {
    if (active || mode !== "video") return;
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    stopStream();
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: { ideal: next }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        await previewRef.current.play().catch(() => undefined);
      }
      const caps = stream.getVideoTracks()[0]?.getCapabilities?.() as MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };
      setZoomRange(caps?.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 } : null);
      setZoom(caps?.zoom?.min || 1);
      setPreviewReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to switch camera.");
    }
  }

  async function changeZoom(next: number) {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !zoomRange) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: Math.min(zoomRange.max, Math.max(zoomRange.min, next)) } as unknown as MediaTrackConstraintSet] });
      setZoom(next);
    } catch {
      setError("Zoom is not supported by this camera. Try another camera or device.");
    }
  }

  async function downloadItem(item: LocalRecording) {
    const url = URL.createObjectURL(item.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = item.name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function removeItem(item: LocalRecording) {
    if (!window.confirm(`Delete ${item.name} from this browser's local recordings?`)) return;
    try { await deleteLocalRecording(item.id); await refreshItems(); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to delete local recording"); }
  }

  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    else stopStream();
  }, [stopStream]);

  return (
    <section className="hp-panel hp-recorder">
      <div className="hp-section-heading">
        <div><p className="hp-eyebrow">WEB APP RECORDING</p><h2>Local voice & video recorder</h2></div>
        <span className="hp-count">Browser storage</span>
      </div>
      <p className="hp-footnote">Recordings started here stay in this browser's IndexedDB. They are separate from recordings uploaded by the Calculator app. Camera and microphone permissions are required.</p>
      <div className="hp-recorder-grid">
        <div>
          <video ref={previewRef} className="hp-camera-preview" playsInline muted autoPlay />
          <div className="hp-recorder-controls">
            <button className="hp-button hp-secondary" disabled={active || mode !== "video"} onClick={() => void openCameraPreview()}>Open camera preview</button>
            <button className="hp-button hp-secondary" disabled={active || !previewReady || mode !== "video"} onClick={() => void switchCamera()}>Switch front / back</button>
            <button className="hp-button hp-secondary" disabled={active || mode !== "video" || !zoomRange || zoom <= zoomRange.min} onClick={() => void changeZoom(Math.max(zoomRange?.min || 1, zoom - (zoomRange?.step || 0.1)))}>Zoom −</button>
            <button className="hp-button hp-secondary" disabled={active || mode !== "video" || !zoomRange || zoom >= zoomRange.max} onClick={() => void changeZoom(Math.min(zoomRange?.max || 1, zoom + (zoomRange?.step || 0.1)))}>Zoom +</button>
          </div>
        </div>
        <div className="hp-recorder-actions">
          <label htmlFor="hp-record-mode">Recording type</label>
          <select id="hp-record-mode" value={mode} disabled={active} onChange={(e) => setMode(e.target.value as "audio" | "video")}>
            <option value="video">Video</option><option value="audio">Voice only</option>
          </select>
          <div className="hp-recorder-controls">
            <button className="hp-button hp-primary" disabled={active} onClick={() => void start(mode)}>Start recording</button>
            <button className="hp-button hp-danger" disabled={!active} onClick={stopRecording}>Stop & save</button>
          </div>
          <p className="hp-recorder-status" role="status">{status}</p>
          {error && <p className="hp-alert hp-error" role="alert">{error}</p>}
          <p className="hp-footnote">Zoom controls appear only when the selected camera exposes hardware zoom. Browser support and available camera controls vary by device.</p>
        </div>
      </div>
      <div className="hp-section-heading hp-recordings-heading"><h2>Saved in this browser</h2><span className="hp-count">{items.length}</span></div>
      {items.length === 0 ? <div className="hp-empty">No Web App recordings saved in this browser.</div> : (
        <div className="hp-list">
          {items.map((item) => (
            <article className="hp-device" key={item.id}>
              <div className="hp-device-main"><strong>{item.name}</strong><span>{new Date(item.createdAt).toLocaleString()} · {(item.size / (1024 * 1024)).toFixed(1)} MB</span></div>
              <div className="hp-actions">
                <button className="hp-button hp-secondary" onClick={() => void downloadItem(item)}>Download</button>
                <button className="hp-button hp-danger" onClick={() => void removeItem(item)}>Delete</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
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
    if (!token) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20000);
    return () => window.clearInterval(timer);
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

      <WebRecorder />

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
                  <span className={device.appOpen ? "hp-status hp-status-on" : "hp-status hp-status-off"}>Calculator App: {device.appOpen ? "OPEN" : "OFF"}</span>
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
