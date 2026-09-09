let token;
async function apiAuth(method, path, body) {
  const res = await fetch(`http://localhost:3000/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

const login = (await apiAuth('POST', '/auth/login', { username: 'admin', password: 'Akri123*' })).json;
token = login.data.token;
const site = (await apiAuth('POST', '/auth/select-site', { id_sede: 3 })).json;
token = site.data.token;
const alm = (await apiAuth('POST', '/auth/select-almacen', { id_almacen: 6 })).json;
token = alm.data.token;
console.log('Sesion activa:', alm.data.user.sede, '/', alm.data.user.almacen_principal);

// ---------- 1) MOVIMIENTO DE ENTRADA, modo "lote existente" ----------
// Usamos un lote real que ya sabemos que existe: FIBRILOK lote 5D670
// (id_lote se busca por producto+lote conocidos de sesiones anteriores).
const stockAntes = (await apiAuth('GET', '/inventory/stock/product/24')).json.data;
console.log('\n[ENTRADA existente] stock ANTES producto 24 (FIBRILOK):', JSON.stringify(stockAntes));
const loteFibrilok = stockAntes.find(l => l.numero_lote === '5D670');
if (!loteFibrilok) throw new Error('No se encontró el lote 5D670 de referencia');
const cantidadAntes = Number(loteFibrilok.cantidad_disponible);

const entradaExistente = await apiAuth('POST', '/inventory/movements', {
  tipo: 'inventario_sobrante_fisico',
  id_lote: loteFibrilok.id_lote,
  id_almacen_destino: 6,
  id_ubicacion_destino: 7,
  cantidad: 7,
  motivo: 'TEST validacion entrada modo existente (se revierte)'
});
console.log('[ENTRADA existente] POST /inventory/movements ->', entradaExistente.status, JSON.stringify(entradaExistente.json));

const stockDespues1 = (await apiAuth('GET', '/inventory/stock/product/24')).json.data;
const loteFibrilokDespues = stockDespues1.find(l => l.id_lote === loteFibrilok.id_lote);
console.log('[ENTRADA existente] cantidad_disponible antes:', cantidadAntes, '-> despues:', loteFibrilokDespues.cantidad_disponible, '(esperado: +7)');

// ---------- 2) MOVIMIENTO DE ENTRADA, modo "producto/lote nuevo" ----------
const stockNuevoAntes = (await apiAuth('GET', '/inventory/stock/product/25')).json.data;
console.log('\n[ENTRADA nuevo] stock ANTES producto 25 (TRANEXAM, sin stock):', JSON.stringify(stockNuevoAntes));

const entradaNueva = await apiAuth('POST', '/inventory/movements', {
  tipo: 'inventario_sobrante_fisico',
  id_producto: 25,
  numero_lote: 'TEST-VALIDACION-001',
  fecha_vencimiento: '2028-06-30',
  id_almacen_destino: 6,
  id_ubicacion_destino: 7,
  cantidad: 4,
  costo_unitario: 99.5,
  motivo: 'TEST validacion entrada modo nuevo (se revierte)'
});
console.log('[ENTRADA nuevo] POST /inventory/movements ->', entradaNueva.status, JSON.stringify(entradaNueva.json));

const stockNuevoDespues = (await apiAuth('GET', '/inventory/stock/product/25')).json.data;
console.log('[ENTRADA nuevo] stock DESPUES producto 25:', JSON.stringify(stockNuevoDespues, null, 2));

// ---------- 3) MOVIMIENTO DE SALIDA sobre el lote recién creado ----------
const loteNuevo = stockNuevoDespues.find(l => l.numero_lote === 'TEST-VALIDACION-001');
const salida = await apiAuth('POST', '/inventory/movements', {
  tipo: 'merma',
  id_lote: loteNuevo.id_lote,
  id_almacen_origen: 6,
  id_ubicacion_origen: 7,
  cantidad: 1,
  motivo: 'TEST validacion salida (se revierte)'
});
console.log('\n[SALIDA] POST /inventory/movements ->', salida.status, JSON.stringify(salida.json));

const stockTrasSalida = (await apiAuth('GET', '/inventory/stock/product/25')).json.data;
const loteTrasSalida = stockTrasSalida.find(l => l.id_lote === loteNuevo.id_lote);
console.log('[SALIDA] cantidad_disponible antes:', loteNuevo.cantidad_disponible, '-> despues:', loteTrasSalida.cantidad_disponible, '(esperado: -1)');

// ---------- 4) SALIDA que debe rechazarse por stock insuficiente ----------
const salidaExcesiva = await apiAuth('POST', '/inventory/movements', {
  tipo: 'merma',
  id_lote: loteNuevo.id_lote,
  id_almacen_origen: 6,
  id_ubicacion_origen: 7,
  cantidad: 999999,
  motivo: 'TEST debe fallar por stock insuficiente'
});
console.log('\n[SALIDA excesiva] status esperado 400 ->', salidaExcesiva.status, JSON.stringify(salidaExcesiva.json));

console.log('\nIDs para limpieza: id_lote_nuevo=' + loteNuevo.id_lote + ' id_lote_fibrilok=' + loteFibrilok.id_lote);
