const PHOTO_SIZE = 256;
const PHOTO_QUALITY = 0.82;

// Crops the image to a centered square and shrinks it so roster photos stay small enough to store with the member.
export function resizeMemberPhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    return Promise.reject(new Error('Choose an image file for the member photo.'));
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = PHOTO_SIZE;
      canvas.height = PHOTO_SIZE;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('This browser cannot process images.'));
        return;
      }
      context.drawImage(
        image,
        (image.naturalWidth - side) / 2,
        (image.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        PHOTO_SIZE,
        PHOTO_SIZE
      );
      resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That image could not be read. Try a JPG or PNG.'));
    };
    image.src = url;
  });
}
