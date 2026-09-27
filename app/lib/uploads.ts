"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Upload = { file: File; preview: string };

/**
 * Pictures waiting to be sent with whatever you are typing.
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
    const images = files.filter((file) => file.type.startsWith("image/"));
    setError(images.length === files.length ? "" : "Only image files are supported.");
    setUploads((current) => [
      ...current,
      ...images.map((file) => ({ file, preview: URL.createObjectURL(file) })),
    ]);
  }, []);

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

  return { uploads, error, add, drop, clear, files: uploads.map((upload) => upload.file) };
}
