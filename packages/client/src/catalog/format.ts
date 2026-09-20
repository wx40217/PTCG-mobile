/** 目录版本/修订的短显示。 */
export function shortVersion(version: string): string {
  return version.length > 12 ? `${version.slice(0, 12)}…` : version;
}
