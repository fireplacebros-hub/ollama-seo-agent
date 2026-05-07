export function isAlreadyWebP(imageUrl) {
  try {
    const pathname = new URL(imageUrl).pathname.toLowerCase().split("?")[0];
    return pathname.endsWith(".webp");
  } catch {
    return false;
  }
}

export function formatBytes(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
