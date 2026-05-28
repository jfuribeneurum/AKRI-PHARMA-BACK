import { HttpError } from '../utils/http-error.js';

export function validate(schema, property = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[property]);
    if (!result.success) {
      return next(new HttpError(400, 'Validación fallida', result.error.flatten()));
    }
    req[property] = result.data;
    return next();
  };
}
