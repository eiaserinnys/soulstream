export function hostOsConditionValue(osType: string): string {
  switch (osType) {
    case "Windows_NT":
      return "windows";
    case "Linux":
      return "linux";
    case "Darwin":
      return "darwin";
    default:
      return osType.toLowerCase();
  }
}
