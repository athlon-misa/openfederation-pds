export function isValidHandle(handle: string): boolean {
  return /^[a-z0-9-]{3,255}$/.test(handle);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isStrongPassword(password: string): boolean {
  return password.length >= 8;
}
