"use client";

import { useEffect, useState } from "react";
import { apiBaseUrl, apiFetch } from "@/lib/api/backend-client";
import { cleanKeyPart } from "../utils/dashboard-utils";

export function ProductImage({
  src,
  alt,
  size,
}: {
  src?: string | null;
  alt: string;
  size: "small" | "large";
}) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() =>
    cleanKeyPart(src) && !src?.startsWith("/products/") ? src ?? null : null
  );
  const className =
    size === "large"
      ? "h-56 w-full max-w-sm rounded-md border border-zinc-200 object-contain"
      : "h-14 w-14 rounded-md border border-zinc-200 object-contain";

  useEffect(() => {
    let disposed = false;
    let objectUrl = "";
    const value = cleanKeyPart(src) ? src ?? "" : "";

    if (!value) {
      setResolvedSrc(null);
      return;
    }

    if (!value.startsWith("/products/")) {
      setResolvedSrc(value);
      return;
    }

    setResolvedSrc(null);
    void apiFetch(`${apiBaseUrl}${value}`)
      .then((response) => {
        if (!response.ok) throw new Error("Product picture is unavailable.");
        return response.blob();
      })
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setResolvedSrc(objectUrl);
      })
      .catch(() => {
        if (!disposed) setResolvedSrc(null);
      });

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (resolvedSrc) {
    return (
      <img
        alt={alt}
        className={`${className} bg-white`}
        loading="lazy"
        src={resolvedSrc}
      />
    );
  }

  return (
    <div
      aria-label="No product image"
      className={`${className} flex items-center justify-center bg-zinc-50 text-xs font-medium text-zinc-400`}
      role="img"
    >
      No image
    </div>
  );
}
