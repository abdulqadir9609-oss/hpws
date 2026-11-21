# Private media upload API (R2)

This feature branch adds authenticated multipart uploads for phone recordings. It does not deploy or change production.

## Cloudflare setup required before deployment

1. Create an R2 bucket named `hpws-media` in the same Cloudflare account as this Worker.
2. Keep the bucket private: do not enable public bucket access or expose an r2.dev URL.
3. Deploy this branch only after the bucket exists and the normal Worker environment is configured.
4. The Worker binding is `MEDIA_BUCKET` in `wrangler.json`.

No account credentials or tokens belong in source control.

## Authentication

Every request must include:
- `Authorization: Bearer <approved-device-token>`
- `X-HP-Device-ID: HPPHONE1` (or the assigned device ID)

The Worker validates the token hash against the existing device registry and rejects revoked devices. Upload object keys are scoped under the authenticated device ID.

## Multipart API

All endpoints are POST and use `https://hpws.webae.workers.dev`.

### Start

`POST /api/media/uploads/init`

JSON:
```json
{
  "category": "video_recordings",
  "fileName": "segment-0001.mp4",
  "contentType": "video/mp4",
  "size": 123456789
}
```

Allowed categories are `audio_recordings` and `video_recordings`. The response includes `key`, `uploadId`, and a recommended 16 MiB part size.

### Upload each part

`POST /api/media/uploads/part?key=<key>&uploadId=<uploadId>&partNumber=<1-based-number>`

Send the raw part bytes as the request body. The response returns the part number and R2 ETag. Use sequential part numbers beginning at 1. R2 requires all non-final parts to meet its multipart minimum size.

### Complete

`POST /api/media/uploads/complete`

JSON:
```json
{
  "key": "<key-from-init>",
  "uploadId": "<upload-id-from-init>",
  "parts": [
    { "partNumber": 1, "etag": "<etag-from-part-1>" }
  ]
}
```

A successful response returns `ok: true`, `verified: true`, the object key, ETag, and stored size. The phone must retain its local temporary recording unless it receives this successful completion response and verifies that the returned size matches the source file.

### Abort

`POST /api/media/uploads/abort`

JSON with the upload `key` and `uploadId`. This abandons an incomplete multipart upload.

## Important current limitation

This is the Worker-side upload foundation only. The Android app is not yet wired to call these endpoints when a recording segment is finalized, and the Web Controller media browser/download UI is not yet implemented. Do not delete local recordings based only on part-upload success; only a verified complete response is an upload confirmation.
