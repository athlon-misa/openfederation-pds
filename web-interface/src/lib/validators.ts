export function isValidHandle(handle: string): boolean {
  if (handle.length < 3 || handle.length > 30) return false;
  if (handle.startsWith('-') || handle.endsWith('-')) return false;
  if (handle.includes('--')) return false;
  return /^[a-z0-9-]+$/.test(handle);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isStrongPassword(password: string): boolean {
  if (password.length < 10 || password.length > 128) return false;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  const categoryCount = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  return categoryCount >= 3;
}

export function passwordValidationMessage(): string {
  return 'Password must be 10-128 characters and contain at least 3 of: lowercase, uppercase, digit, special character';
}
