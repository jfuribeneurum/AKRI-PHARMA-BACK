export function errorHandler(error, _req, res, _next) {
  const multerFileTooLarge = error.code === 'LIMIT_FILE_SIZE';
  const status = error.status ?? (multerFileTooLarge ? 400 : 500);
  const payload = {
    success: false,
    message: multerFileTooLarge
      ? 'El archivo supera el tamaño máximo permitido.'
      : (error.message ?? 'Error interno del servidor')
  };

  if (error.details) {
    payload.details = error.details;
  }

  if (process.env.NODE_ENV !== 'production' && error.stack) {
    payload.stack = error.stack;
  }

  res.status(status).json(payload);
}
