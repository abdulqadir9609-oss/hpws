export function validateSignalingMessage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const data = value as Record<string, unknown>;
  if (data.type === "offer" || data.type === "answer") {
    const rawSdp = data.sdp;
    const sdp = typeof rawSdp === "string"
      ? rawSdp
      : rawSdp && typeof rawSdp === "object" && !Array.isArray(rawSdp)
        ? (rawSdp as Record<string, unknown>).sdp
        : null;

    if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > 48_000) {
      return null;
    }

    return { type: data.type, sdp };
  }

  if (data.type === "candidate") {
    const raw = data.candidate;
    if (typeof raw === "string") {
      if (raw.length === 0 || raw.length > 8_192) return null;
      return { type: "candidate", candidate: raw };
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const candidate = raw as Record<string, unknown>;
    if (
      typeof candidate.candidate !== "string" ||
      candidate.candidate.length === 0 ||
      candidate.candidate.length > 8_192
    ) return null;

    const normalized: Record<string, unknown> = {
      type: "candidate",
      candidate: { candidate: candidate.candidate },
    };

    if (candidate.sdpMid !== undefined && candidate.sdpMid !== null) {
      if (typeof candidate.sdpMid !== "string" || candidate.sdpMid.length > 256) {
        return null;
      }
      (normalized.candidate as Record<string, unknown>).sdpMid = candidate.sdpMid;
    }

    if (candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null) {
      if (
        typeof candidate.sdpMLineIndex !== "number" ||
        !Number.isInteger(candidate.sdpMLineIndex) ||
        candidate.sdpMLineIndex < 0 ||
        candidate.sdpMLineIndex > 255
      ) return null;
      (normalized.candidate as Record<string, unknown>).sdpMLineIndex =
        candidate.sdpMLineIndex;
    }

    return normalized;
  }

  if (data.type === "media-request") {
    if (
      (data.media !== "audio" && data.media !== "video") ||
      typeof data.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(data.requestId)
    ) return null;

    return {
      type: "media-request",
      media: data.media,
      requestId: data.requestId,
    };
  }

  if (data.type === "media-stop") {
    if (
      typeof data.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(data.requestId)
    ) return null;

    return { type: "media-stop", requestId: data.requestId };
  }

  if (data.type === "media-status") {
    const allowedStatuses = [
      "approval-required",
      "approved",
      "denied",
      "starting",
      "active",
      "stopped",
      "error",
    ];

    if (
      typeof data.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(data.requestId) ||
      typeof data.status !== "string" ||
      !allowedStatuses.includes(data.status)
    ) return null;

    if (
      data.media !== undefined &&
      data.media !== "audio" &&
      data.media !== "video"
    ) return null;

    if (
      data.message !== undefined &&
      (typeof data.message !== "string" || data.message.length > 500)
    ) return null;

    return {
      type: "media-status",
      requestId: data.requestId,
      status: data.status,
      ...(data.media !== undefined ? { media: data.media } : {}),
      ...(data.message !== undefined ? { message: data.message } : {}),
    };
  }

  return null;
}
