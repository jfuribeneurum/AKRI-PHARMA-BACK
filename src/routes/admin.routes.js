import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { requireAnyUsability } from '../middleware/usabilities.js';
import {
  assignProfileToUser,
  createProfile,
  createSite,
  createUser,
  deleteProfile,
  deleteSite,
  deleteUser,
  getAdminLookups,
  getSiteAuditTimeline,
  listAdminAudit,
  listProfiles,
  listSites,
  listUsers,
  listRoleUsabilities,
  reassignUsersAndDeleteProfile,
  replaceRoleUsabilities,
  updateProfile,
  updateSite,
  updateUser
} from '../services/admin.service.js';

const siteSchema = z.object({
  codigo: z.string().min(2),
  nombre: z.string().min(2),
  ciudad: z.string().optional().nullable(),
  direccion: z.string().optional().nullable(),
  telefono: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  responsable: z.string().optional().nullable(),
  es_principal: z.boolean().optional(),
  activo: z.boolean().optional()
});

const profileSchema = z.object({
  nombre: z.string().min(2),
  descripcion: z.string().optional().nullable(),
  nivel_jerarquia: z.number().int().min(1).max(9).optional(),
  perm_inventario_consulta: z.boolean().optional(),
  perm_inventario_movimiento: z.boolean().optional(),
  perm_inventario_ajuste: z.boolean().optional(),
  perm_compras_solicitar: z.boolean().optional(),
  perm_compras_aprobar: z.boolean().optional(),
  perm_compras_recibir: z.boolean().optional(),
  perm_ventas_dispensar: z.boolean().optional(),
  perm_ventas_facturar: z.boolean().optional(),
  perm_ventas_devolucion: z.boolean().optional(),
  perm_controlados_dispensar: z.boolean().optional(),
  perm_controlados_libro: z.boolean().optional(),
  perm_cadena_frio_consulta: z.boolean().optional(),
  perm_cadena_frio_registro: z.boolean().optional(),
  perm_cadena_frio_aprobar_excursion: z.boolean().optional(),
  perm_farmacovigilancia: z.boolean().optional(),
  perm_reportes_operativos: z.boolean().optional(),
  perm_reportes_financieros: z.boolean().optional(),
  perm_configuracion: z.boolean().optional(),
  perm_usuarios_gestionar: z.boolean().optional(),
  perm_auditoria_consulta: z.boolean().optional(),
  perm_destruccion_autorizar: z.boolean().optional(),
  permisos_extra: z.record(z.any()).optional().nullable(),
  es_activo: z.boolean().optional()
});

const roleUsabilitySchema = z.object({
  clave: z.string().min(2),
  nombre: z.string().min(2),
  descripcion: z.string().optional().nullable(),
  categoria: z.string().min(2),
  habilitado: z.boolean().optional(),
  metadata: z.record(z.any()).optional().nullable()
});

const reassignDeleteProfileSchema = z.object({
  replacement_role_id: z.number().int().positive()
});

const userSchema = z.object({
  username: z.string().min(2),
  password: z.string().min(6),
  nombre: z.string().min(2),
  apellido_paterno: z.string().min(2),
  apellido_materno: z.string().optional().nullable(),
  email: z.string().email(),
  telefono_movil: z.string().optional().nullable(),
  id_rol: z.number().int(),
  id_sede: z.number().int(),
  id_almacen_principal: z.number().int().optional().nullable(),
  numero_empleado: z.string().optional().nullable(),
  cedula_profesional: z.string().optional().nullable(),
  fecha_ingreso: z.string().optional().nullable(),
  turno: z.enum(['matutino', 'vespertino', 'nocturno', 'mixto', 'rotativo']).optional(),
  es_activo: z.boolean().optional(),
  requiere_cambio_password: z.boolean().optional(),
  site_ids: z.array(z.number().int()).optional(),
  puede_admin_sede: z.boolean().optional()
});

const userUpdateSchema = userSchema.partial().extend({
  username: z.string().min(2).optional(),
  password: z.string().min(6).optional(),
  nombre: z.string().min(2).optional(),
  apellido_paterno: z.string().min(2).optional(),
  email: z.string().email().optional()
});

const assignProfileSchema = z.object({
  id_rol: z.number().int().positive(),
  id_sede: z.number().int().positive().optional(),
  site_ids: z.array(z.number().int().positive()).optional(),
  puede_admin_sede: z.boolean().optional()
});

const sitesAccess = requireAnyUsability('sites.manage');
const siteDeleteAccess = requireAnyUsability('sites.delete', 'sites.manage');
const profileAccess = requireAnyUsability('profiles.manage');
const assignmentAccess = requireAnyUsability('users.manage', 'profiles.assign', 'profiles.manage');
const userDeleteAccess = requireAnyUsability('users.delete', 'users.manage', 'profiles.manage');
const adminLookupsAccess = requireAnyUsability('sites.manage', 'profiles.manage', 'profiles.assign', 'users.manage');
const auditAccess = requireAnyUsability('traceability.process_finished', 'sites.manage', 'profiles.manage', 'users.manage', 'dashboard.control.center');

export const adminRouter = Router();
adminRouter.use(authRequired);

adminRouter.get('/lookups', adminLookupsAccess, asyncHandler(async (_req, res) => {
  const data = await getAdminLookups();
  res.json({ success: true, data });
}));

adminRouter.get('/audit', auditAccess, asyncHandler(async (req, res) => {
  const data = await listAdminAudit({
    scope: String(req.query.scope ?? 'all'),
    search: String(req.query.search ?? ''),
    id_sede: req.query.id_sede ? Number(req.query.id_sede) : null,
    limit: Number(req.query.limit ?? 120)
  });
  res.json({ success: true, data });
}));

adminRouter.get('/sites', sitesAccess, asyncHandler(async (_req, res) => {
  const data = await listSites();
  res.json({ success: true, data });
}));

adminRouter.get('/sites/:id/audit', auditAccess, asyncHandler(async (req, res) => {
  const data = await getSiteAuditTimeline(Number(req.params.id), Number(req.query.limit ?? 120));
  res.json({ success: true, data });
}));

adminRouter.post('/sites', sitesAccess, validate(siteSchema), asyncHandler(async (req, res) => {
  const data = await createSite({ ...req.body, creado_por: req.user.sub, actor: req.user });
  res.status(201).json({ success: true, data });
}));

adminRouter.put('/sites/:id', sitesAccess, validate(siteSchema.partial()), asyncHandler(async (req, res) => {
  const data = await updateSite(Number(req.params.id), { ...req.body, actor: req.user });
  res.json({ success: true, data });
}));

adminRouter.delete('/sites/:id', siteDeleteAccess, asyncHandler(async (req, res) => {
  const data = await deleteSite(Number(req.params.id), req.user);
  res.json({ success: true, data });
}));

adminRouter.get('/profiles', profileAccess, asyncHandler(async (_req, res) => {
  const data = await listProfiles();
  res.json({ success: true, data });
}));

adminRouter.post('/profiles', profileAccess, validate(profileSchema), asyncHandler(async (req, res) => {
  const data = await createProfile(req.body, req.user);
  res.status(201).json({ success: true, data });
}));

adminRouter.put('/profiles/:id', profileAccess, validate(profileSchema.partial()), asyncHandler(async (req, res) => {
  const data = await updateProfile(Number(req.params.id), req.body, req.user);
  res.json({ success: true, data });
}));

adminRouter.delete('/profiles/:id', profileAccess, asyncHandler(async (req, res) => {
  const replacementRoleId = req.query.reassign_to ? Number(req.query.reassign_to) : null;
  const data = replacementRoleId
    ? await reassignUsersAndDeleteProfile(Number(req.params.id), replacementRoleId, req.user)
    : await deleteProfile(Number(req.params.id), req.user);
  res.json({ success: true, data });
}));

adminRouter.post('/profiles/:id/reassign-delete', profileAccess, validate(reassignDeleteProfileSchema), asyncHandler(async (req, res) => {
  const data = await reassignUsersAndDeleteProfile(Number(req.params.id), Number(req.body.replacement_role_id), req.user);
  res.json({ success: true, data });
}));

adminRouter.get('/profiles/:id/usabilities', profileAccess, asyncHandler(async (req, res) => {
  const data = await listRoleUsabilities(Number(req.params.id));
  res.json({ success: true, data });
}));

adminRouter.put('/profiles/:id/usabilities', profileAccess, validate(z.object({ items: z.array(roleUsabilitySchema) })), asyncHandler(async (req, res) => {
  const data = await replaceRoleUsabilities(Number(req.params.id), req.body.items, req.user);
  res.json({ success: true, data });
}));

adminRouter.get('/users', assignmentAccess, asyncHandler(async (req, res) => {
  const data = await listUsers({
    search: String(req.query.search ?? ''),
    id_sede: req.query.id_sede ? Number(req.query.id_sede) : null,
    id_rol: req.query.id_rol ? Number(req.query.id_rol) : null,
    active: req.query.active ?? ''
  });
  res.json({ success: true, data });
}));

adminRouter.post('/users', assignmentAccess, validate(userSchema), asyncHandler(async (req, res) => {
  const data = await createUser({ ...req.body, creado_por: req.user.sub, actor: req.user });
  res.status(201).json({ success: true, data });
}));

adminRouter.put('/users/:id', assignmentAccess, validate(userUpdateSchema), asyncHandler(async (req, res) => {
  const data = await updateUser(Number(req.params.id), { ...req.body, modificado_por: req.user.sub, actor: req.user });
  res.json({ success: true, data });
}));

adminRouter.patch('/users/:id/assignment', assignmentAccess, validate(assignProfileSchema), asyncHandler(async (req, res) => {
  const data = await assignProfileToUser(Number(req.params.id), { ...req.body, modificado_por: req.user.sub, actor: req.user }, req.user);
  res.json({ success: true, data });
}));

adminRouter.delete('/users/:id', userDeleteAccess, asyncHandler(async (req, res) => {
  const data = await deleteUser(Number(req.params.id), req.user);
  res.json({ success: true, data });
}));
