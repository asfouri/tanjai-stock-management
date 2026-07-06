import { cleanKeyPart } from "../utils";

export function ProductImage({
  src,
  alt,
  size,
}: {
  src?: string | null;
  alt: string;
  size: "small" | "large";
}) {
  const hasImage = Boolean(cleanKeyPart(src));
  const className =
    size === "large"
      ? "h-56 w-full max-w-sm rounded-md border border-zinc-200 object-contain"
      : "h-14 w-14 rounded-md border border-zinc-200 object-contain";

  if (hasImage) {
    return (
      <img
        alt={alt}
        className={`${className} bg-white`}
        loading="lazy"
        src={src ?? undefined}
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
