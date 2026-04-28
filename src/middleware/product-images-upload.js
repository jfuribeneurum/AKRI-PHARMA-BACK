import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env.js';

export const productUploadsDir = path.join(env.UPLOAD_DIR, 'products');
fs.mkdirSync(productUploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, productUploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  }
});

function fileFilter(_req, file, cb) {
  if (!String(file.mimetype ?? '').startsWith('image/')) {
    const error = new Error('Solo se permiten archivos de imagen');
    error.status = 400;
    cb(error);
    return;
  }
  cb(null, true);
}

export const uploadProductImages = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 6 * 1024 * 1024,
    files: 8
  }
});
