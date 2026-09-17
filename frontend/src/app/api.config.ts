const LOCAL_BACKEND_URL = 'http://localhost:3000';
const PRODUCTION_BACKEND_URL = 'https://itpc-photobooth.onrender.com';

// Add your exact deployed frontend hostname here if you want to match a custom domain explicitly.
const DEPLOYED_FRONTEND_HOSTS = [
  'magpale-chloe.github.io'
];

export const PHOTO_API_BASE_URL = resolvePhotoApiBaseUrl(
  typeof window !== 'undefined' ? window.location.hostname : 'localhost'
);

export function resolvePhotoApiBaseUrl(hostname: string): string {
  const host = hostname.toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) {
    return LOCAL_BACKEND_URL;
  }

  if (DEPLOYED_FRONTEND_HOSTS.includes(host)) {
    return PRODUCTION_BACKEND_URL;
  }

  return PRODUCTION_BACKEND_URL;
}