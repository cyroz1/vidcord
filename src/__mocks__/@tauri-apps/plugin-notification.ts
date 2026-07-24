export async function isPermissionGranted(): Promise<boolean> {
  return true;
}

export async function requestPermission(): Promise<"granted" | "denied"> {
  return "granted";
}

export function sendNotification(_options: { title: string; body?: string }): void {
  // Mock stub for Vitest unit tests
}
