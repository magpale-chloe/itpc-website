export const PHOTO_API_BASE_URL = resolvePhotoApiBaseUrl(
  typeof window !== 'undefined' ? window.location.hostname : 'localhost'
);

export function resolvePhotoApiBaseUrl(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) {
    return 'http://localhost:3000';
  }

  return 'https://itpc-photobooth.onrender.com';
}