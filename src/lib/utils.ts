import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Converts a Data URI string to a Blob object.
 * @param dataURI The Data URI string (e.g., "data:application/pdf;base64,...").
 * @returns A Blob object representing the data.
 */
export function dataUriToBlob(dataURI: string): Blob {
  // Split the data URI to get the content type and the base64 data
  const byteString = atob(dataURI.split(',')[1]);
  const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];

  // Write the bytes of the string to an ArrayBuffer
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }

  // Create a Blob from the ArrayBuffer
  return new Blob([ab], { type: mimeString });
}
