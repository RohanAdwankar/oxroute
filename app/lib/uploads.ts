"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Upload = { file: File; preview: string };

export const acceptsFileDrop = (transfer: DataTransfer) =>
  transfer.types.includes("Files") || transfer.types.includes("text/uri-list");

/**
 * Files waiting to be sent with whatever you are typing.
 *
 * Every box you can type into takes them the same way -- pasted, dropped or
 * picked -- so the holding of them belongs here rather than in one composer.
 */
export function useUploads() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState("");
  const held = useRef<Upload[]>([]);

  useEffect(() => {
    held.current = uploads;
  }, [uploads]);

  // The browser keeps a preview alive until it is told not to.
  useEffect(() => () => {
    held.current.forEach((upload) => URL.revokeObjectURL(upload.preview));
  }, []);

  const add = useCallback((files: File[]) => {
    setError("");
    setUploads((current) => [
      ...current,
      ...files.map((file) => ({ file, preview: URL.createObjectURL(file) })),
    ]);
  }, []);

  const addFromDrop = useCallback(async (transfer: DataTransfer) => {
    const files = Array.from(transfer.files);
    if (files.length > 0) {
      add(files);
      return;
    }
    const address = transfer.getData("text/uri-list").split("\n").find((line) => line && !line.startsWith("#"));
    if (!address) return;
    try {
      const url = new URL(address);
      if (!["https:", "http:", "blob:", "data:"].includes(url.protocol)) throw new Error("unsupported image URL");
      const response = await fetch(address);
      if (!response.ok) throw new Error("image download failed");
      const image = await response.blob();
      if (!image.type.startsWith("image/")) throw new Error("not an image");
      const name = url.protocol === "data:" ? "image" : url.pathname.split("/").pop() || "image";
      add([new File([image], name, { type: image.type })]);
    } catch {
      setError("Could not attach that image. Save it and drag the file in.");
    }
  }, [add]);

  const drop = useCallback((upload: Upload) => {
    URL.revokeObjectURL(upload.preview);
    setUploads((current) => current.filter((item) => item !== upload));
  }, []);

  const clear = useCallback(() => {
    setUploads((current) => {
      current.forEach((upload) => URL.revokeObjectURL(upload.preview));
      return [];
    });
    setError("");
  }, []);

  return { uploads, error, add, addFromDrop, drop, clear, files: uploads.map((upload) => upload.file) };
}
