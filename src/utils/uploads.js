import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env.js';

export const uploadBaseDir = path.resolve(process.cwd(), env.UPLOAD_DIR);
export const productUploadsDir = path.join(uploadBaseDir, 'products');

fs.mkdirSync(productUploadsDir, { recursive: true });

function inferExtension(file) {
  const directExtension = path.extname(file.originalname ?? '').toLowerCase();
  if (directExtension) {
    return directExtension;
  }

  const byMimeType = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/heic': '.heic',
    'image/heif': '.heif'
  };

  return byMimeType[file.mimetype] ?? '.bin';
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, productUploadsDir),
  filename: (_req, file, callback) => {
    const extension = inferExtension(file);
    const filename = `${Date.now()}-${crypto.randomUUID()}${extension}`;
    callback(null, filename);
  }
});

function imageFileFilter(_req, file, callback) {
  if (String(file.mimetype ?? '').startsWith('image/')) {
    callback(null, true);
    return;
  }

  callback(new Error('Solo se permiten archivos de imagen'));
}

export const productImageUpload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: env.MAX_IMAGE_SIZE_MB * 1024 * 1024
  }
});

export function toRelativeUploadPath(absoluteFilePath) {
  return path.relative(uploadBaseDir, absoluteFilePath).replace(/\\/g, '/');
}

export function toPublicUploadUrl(relativePath) {
  if (!relativePath) {
    return null;
  }

  return `/uploads/${String(relativePath).replace(/\\/g, '/')}`;
}

export function toAbsoluteUploadPath(relativePath) {
  return path.join(uploadBaseDir, String(relativePath));
}

export async function removeUploadByPath(absoluteFilePath) {
  if (!absoluteFilePath) {
    return;
  }

  try {
    await fs.promises.unlink(absoluteFilePath);
  } catch {
    // noop
  }
}
