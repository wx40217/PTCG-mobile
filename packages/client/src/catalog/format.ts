/** 目录版本/修订的短显示。 */
export function shortVersion(version: string): string {
  return version.length > 12 ? `${version.slice(0, 12)}…` : version;
}

/** 人类可读的字节数：用于图片缓存占用显示。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '未知';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] as string;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}
