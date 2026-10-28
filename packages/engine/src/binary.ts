// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Binary data in a node output. zerodot has no separate binary store, so the bytes are base64
 * text under `binary.<property>` in the JSON output. The size limit of a node output applies.
 */
export type BinaryData = { data: string; mimeType: string; fileName?: string };

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  tgs: "application/x-tgsticker",
};

export function mimeTypeOf(fileName: string): string {
  return MIME[fileName.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export function toBinary(bytes: Uint8Array, fileName: string, mimeType?: string): BinaryData {
  return {
    data: Buffer.from(bytes).toString("base64"),
    mimeType: mimeType ?? mimeTypeOf(fileName),
    fileName,
  };
}

/** The binary data that an earlier node put under `input.binary[property]`. */
export function readBinary(input: unknown, property: string): BinaryData {
  const binary = (input as { binary?: Record<string, unknown> } | null)?.binary;
  const found = binary?.[property] as Partial<BinaryData> | undefined;
  if (!found || typeof found.data !== "string") {
    throw new Error(`The input has no binary data in the property "${property}"`);
  }
  return {
    data: found.data,
    mimeType: found.mimeType ?? "application/octet-stream",
    fileName: found.fileName,
  };
}
