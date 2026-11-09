# Flutter HP App Device Authentication Contract

This document is the client integration contract for the HP Calculator / Safety Mode Android app.

## Production endpoints

Base URL: `https://hpws.webae.workers.dev`

WebSocket URL: `wss://hpws.webae.workers.dev/ws`

The Flutter client must never embed the administrator secret or the Worker internal secret.

## First-time registration

1. Generate an install ID and proof using a cryptographically secure random source.
   - Install ID: 24–32 random bytes, Base64URL encoded without padding.
   - Proof: 32 random bytes, Base64URL encoded without padding.
2. Save both values in Android secure storage before making the registration request. Reuse them on app restarts.
3. Send:
   `POST /api/device/register`
   `Content-Type: application/json`

   ```json
   {
     "installId": "<base64url-install-id>",
     "proof": "<base64url-proof>",
     "label": "Android device"
   }
   ```

4. HTTP 202 means pending approval. Poll `POST /api/device/status` with the same installId and proof. Use a modest backoff (e.g. 5 seconds increasing to 30 seconds); do not create a tight polling loop.
5. If status is `rejected`, stop polling and show a clear rejected state.
6. If status is `approved`, the response contains `deviceId` and a one-time-delivered device `token`. Store both securely before acknowledging.
7. After secure storage succeeds, send `POST /api/device/ack` with installId and proof. This tells the Worker it may erase the pending record's copy of the device token.

## Existing registered device

On every service startup, read deviceId and token from secure storage. Verify credentials with:

`POST /api/device/verify`

```json
{ "deviceId": "HPPHONE1", "token": "<secure-device-token>" }
```

A 401 means credentials are invalid or the device was revoked. Stop the signaling connection and show an authentication/re-registration state; do not fall back to a legacy pairing code.

## WebSocket ticket and signaling

Before every WebSocket connection or reconnect, request a fresh one-time ticket:

`POST /api/ws-ticket/phone`

```json
{ "deviceId": "HPPHONE1", "token": "<secure-device-token>" }
```

The response is `{ "ticket": "...", "expiresIn": 60 }`. Open:

`wss://hpws.webae.workers.dev/ws?ticket=<url-encoded-ticket>`

The ticket is single-use and expires after 60 seconds. Obtain a new ticket for each reconnect. Do not send a `join` message, `role`, `code`, or device token over the WebSocket. The Worker authenticates the ticket and assigns the `phone` role and device room itself.

After connection, exchange only the supported WebRTC signaling messages:
- `{ "type": "offer", "sdp": "<SDP string>" }`
- `{ "type": "answer", "sdp": "<SDP string>" }`
- `{ "type": "candidate", "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 } }`

Do not include the old `code` field. The Worker validates and forwards only the signaling fields it accepts.

## Required Flutter packages

- `flutter_secure_storage` for installId, proof, deviceId, and token.
- `http` for HTTPS registration, status, acknowledgement, verification, and ticket requests.
- Existing `web_socket_channel` for the authenticated WebSocket.
- Existing `flutter_background_service` for the Android foreground service.

Do not store credentials in SharedPreferences, plain files, logs, notifications, or WebSocket URLs. Never log response bodies containing the device token or ticket.

## Device ID format

The backend assigns stable IDs centrally:
- Device 1: `HPPHONE1`
- Device 2: `HPPHONE..2`
- Device 3: `HPPHONE...3`
- Device n (n >= 2): `HPPHONE` + n dots + n

The client must treat deviceId as an opaque server-issued identifier and must not generate it.

## Legacy protocol removal

Remove the old hardcoded `pairingCode = '123456'`, `?code=123456` URL, and WebSocket `join` message using role `hp-app`. Do not keep a compatibility fallback: the new Worker requires a one-time ticket and role `phone`.

## Integration acceptance checks

- New install creates and securely persists one installId/proof pair.
- Repeated registration after app restart reuses the same pair and does not create another device.
- Pending approval is visible and polling is bounded/backed off.
- Approval credentials are saved before `/api/device/ack`.
- Relaunch uses the stored deviceId/token without repeating registration.
- Every WebSocket connection uses a newly requested one-time ticket.
- Reconnect obtains a new ticket; replaying a consumed ticket fails.
- No `123456`, `code`, or client-supplied role is sent in the WebSocket handshake/message.
- Revoked/invalid credentials stop connection attempts and require a clear recovery path.
- Existing WebRTC offer/answer/ICE behavior remains intact after authentication changes.
