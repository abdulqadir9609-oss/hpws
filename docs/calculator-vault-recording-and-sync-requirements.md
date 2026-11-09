# HP Calculator App — Vault Sync and Background Recording Requirements

Status: Approved product requirements; implementation and device verification pending.

This document extends the existing HP Calculator App / HP WEB project requirements. Preserve secure device registration, device-issued IDs, one-time WebSocket tickets, existing WebRTC signaling, background service, Calculator UI, and private Vault requirements.

## 1. Calculator and private Vault
- The normal app launch screen is a functional calculator.
- First launch requires creating and confirming a secret PIN. Entering the PIN in the calculator opens the Vault.
- The Vault stores private photos and videos in app-private storage, not in the public Gallery.
- Support selecting multiple photos/videos from the user's media library, importing/copying them into private storage, thumbnails, full-screen photo preview, video playback, multi-select, restore/unhide to Gallery, and permanent deletion.
- Do not claim an item is hidden unless its private copy is safely stored and the original's removal from public media storage has been confirmed. Explain and report if Android permission or media-provider behavior prevents deletion of the original.

## 2. Automatic Vault-to-Web upload
- Photos and videos imported/hidden in the Vault are automatically queued for secure upload to the configured Web App / Cloudflare R2.
- Uploads must use authenticated, short-lived upload authorization; do not expose permanent device tokens or R2 credentials in URLs, logs, or client-visible source.
- Upload in the background with resumable/retry behavior where supported. Avoid unbounded duplicate queues and preserve the local Vault copy until upload success is confirmed.
- The Web Controller must show per-file upload state (queued, uploading, uploaded, failed/retrying), progress where available, timestamps, and a gallery/history view.
- The user must be able to see and manage the upload queue. Do not silently delete local Vault originals after upload.

## 3. Audio and video recording — exact user-approved behavior
- Provide separate audio-recording and video-recording controls inside the PIN-protected Vault.
- Recording starts only after the user has granted the relevant Android permissions and explicitly turns the selected recording mode ON.
- **Once recording is ON, closing the app UI, pressing Home, locking the phone, or removing the app from Recents must not intentionally stop the recording.** Recording must continue in the background using an Android foreground service, subject to OS/device limitations.
- **The recording is stopped by the user's explicit action inside the app: reopen the Calculator, enter the PIN to access the Vault, and turn the active recording OFF.** Do not make closing the UI, leaving the screen, or removing the app from Recents an implicit stop action.
- When the app UI is closed, the Calculator/Vault UI must no longer be visible; the display should be allowed to turn off/sleep so it does not remain lit and unnecessarily drain battery. The screen must not be kept awake for recording.
- Do not interpret the request for the app UI to disappear and the screen to turn off as permission to hide or suppress Android's system foreground-service notification or camera/microphone privacy indicators. Follow Android's required visible notification and privacy behavior; do not bypass them.
- Audio and video recordings are written directly to app-private Vault storage and must not be indexed in or automatically appear in the normal Gallery.
- Recording files are automatically queued for secure Web App / R2 upload using the same authenticated upload design. Keep local copies until upload success and user-controlled deletion.
- Show recording state, elapsed time, file history, storage use, and upload status in the Vault and/or Web Controller as appropriate.
- Handle permission revocation, camera/microphone contention, storage exhaustion, network loss, service termination, and device reboot safely. Report when recording stops or cannot resume; never imply uninterrupted recording when Android has stopped the service.
- Do not implement covert recording, hidden recording indicators, notification suppression, or bypasses of Android permission/foreground-service requirements.

## 4. Platform and verification constraints
- Android background camera/microphone capture is subject to Android version, foreground-service type/permission requirements, OEM battery management, and camera/microphone availability. Verify on the actual target Android versions and devices.
- Closing the Activity or removing the app from Recents should not intentionally stop an active foreground service. Android force-stop, reboot, permission revocation, system resource limits, or OEM restrictions may stop it; expose truthful status and recovery behavior.
- Verify private storage, Gallery non-indexing, restore/export, upload integrity, retry after network loss, required system notification behavior, PIN-gated stop action, screen-off behavior, and recording continuity on real devices.
- No production Worker deployment, branch merge, or production credential changes without explicit user approval.

## 5. Device identity convention
- Device 1: HPPHONE1
- Device 2 onward: HPPHONE..2, HPPHONE..3, HPPHONE..4, etc.
- Exactly two dots for every device number from 2 onward.
