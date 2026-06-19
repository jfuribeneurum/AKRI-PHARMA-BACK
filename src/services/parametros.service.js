import { query } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';

const SEED = [
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'medicamento',          etiqueta: 'Medicamento',                  orden: 1 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'insumo',               etiqueta: 'Insumo',                       orden: 2 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'controlado',           etiqueta: 'Controlado',                   orden: 3 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'vacuna',               etiqueta: 'Vacuna',                       orden: 4 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'dispositivo',          etiqueta: 'Dispositivo médico',           orden: 5 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'otro',                 etiqueta: 'Otro',                         orden: 6 },

  { grupo: 'tipo_identificacion',      grupo_label: 'Tipo de Identificación',     valor: 'NIT',                  etiqueta: 'NIT',                                            orden: 1 },
  { grupo: 'tipo_identificacion',      grupo_label: 'Tipo de Identificación',     valor: 'CC',                   etiqueta: 'Cédula de ciudadanía',                           orden: 2 },
  { grupo: 'tipo_identificacion',      grupo_label: 'Tipo de Identificación',     valor: 'CE',                   etiqueta: 'Cédula de extranjería',                          orden: 3 },
  { grupo: 'tipo_identificacion',      grupo_label: 'Tipo de Identificación',     valor: 'Pasaporte',            etiqueta: 'Pasaporte',                                      orden: 4 },
  { grupo: 'tipo_identificacion',      grupo_label: 'Tipo de Identificación',     valor: 'DIE',                  etiqueta: 'Documento de identificación de extranjería',     orden: 5 },

  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Producto no requerido',                etiqueta: 'Producto no requerido',                orden: 1 },
  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Producto averiado',                    etiqueta: 'Producto averiado',                    orden: 2 },
  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Cantidad mayor a la solicitada',       etiqueta: 'Cantidad mayor a la solicitada',       orden: 3 },
  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Otro',                                 etiqueta: 'Otro',                                 orden: 4 },

  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'Sin stock',                            etiqueta: 'Sin stock',                            orden: 1 },
  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'Lote no disponible',                   etiqueta: 'Lote no disponible',                   orden: 2 },
  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'Pendiente autorización',               etiqueta: 'Pendiente autorización',               orden: 3 },
  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'No entregado por novedad',             etiqueta: 'No entregado por novedad',             orden: 4 },
  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'Otro',                                 etiqueta: 'Otro',                                 orden: 5 },

  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Ajuste por conteo físico',             etiqueta: 'Ajuste por conteo físico',             orden: 1 },
  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Avería o pérdida',                     etiqueta: 'Avería o pérdida',                     orden: 2 },
  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Vencimiento',                          etiqueta: 'Vencimiento',                          orden: 3 },
  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Diferencia de inventario',             etiqueta: 'Diferencia de inventario',             orden: 4 },
  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Otro ajuste',                          etiqueta: 'Otro ajuste',                          orden: 5 },

  { grupo: 'estado_ingreso',           grupo_label: 'Estado de Ingreso',          valor: 'recibido',     etiqueta: 'Recibido',     orden: 1 },
  { grupo: 'estado_ingreso',           grupo_label: 'Estado de Ingreso',          valor: 'cancelado',    etiqueta: 'Cancelado',    orden: 2 },

  { grupo: 'tipo_movimiento_entrada',  grupo_label: 'Tipo Movimiento Entrada',    valor: 'inventario_sobrante_fisico', etiqueta: 'Inventario sobrante físico', orden: 1 },
  { grupo: 'tipo_movimiento_entrada',  grupo_label: 'Tipo Movimiento Entrada',    valor: 'bonificacion',               etiqueta: 'Bonificación',               orden: 2 },

  { grupo: 'tipo_movimiento_salida',   grupo_label: 'Tipo Movimiento Salida',     valor: 'inventario_faltante_fisico', etiqueta: 'Inventario faltante físico', orden: 1 },
  { grupo: 'tipo_movimiento_salida',   grupo_label: 'Tipo Movimiento Salida',     valor: 'disposicion_final',          etiqueta: 'Disposición final',          orden: 2 },
  { grupo: 'tipo_movimiento_salida',   grupo_label: 'Tipo Movimiento Salida',     valor: 'movimiento_interno',         etiqueta: 'Autoconsumo',                orden: 3 },

  { grupo: 'tipo_receptor',            grupo_label: 'Tipo de Receptor',           valor: 'paciente',        etiqueta: 'Paciente',        orden: 1 },
  { grupo: 'tipo_receptor',            grupo_label: 'Tipo de Receptor',           valor: 'representante',   etiqueta: 'Representante',   orden: 2 },
  { grupo: 'tipo_receptor',            grupo_label: 'Tipo de Receptor',           valor: 'domiciliario',    etiqueta: 'Domiciliario',    orden: 3 },

  { grupo: 'genero',                   grupo_label: 'Género',                     valor: 'F',   etiqueta: 'Femenino',    orden: 1 },
  { grupo: 'genero',                   grupo_label: 'Género',                     valor: 'M',   etiqueta: 'Masculino',   orden: 2 },
  { grupo: 'genero',                   grupo_label: 'Género',                     valor: 'O',   etiqueta: 'Otro',        orden: 3 },

  { grupo: 'clasificacion_producto',   grupo_label: 'Clasificación de Producto',  valor: 'RIESGO I',    etiqueta: 'RIESGO I',    orden: 1 },
  { grupo: 'clasificacion_producto',   grupo_label: 'Clasificación de Producto',  valor: 'RIESGO IIa',  etiqueta: 'RIESGO IIa',  orden: 2 },
  { grupo: 'clasificacion_producto',   grupo_label: 'Clasificación de Producto',  valor: 'RIESGO IIb',  etiqueta: 'RIESGO IIb',  orden: 3 },
  { grupo: 'clasificacion_producto',   grupo_label: 'Clasificación de Producto',  valor: 'RIESGO III',  etiqueta: 'RIESGO III',  orden: 4 },

  { grupo: 'regimen_proveedor', grupo_label: 'Régimen Proveedor', valor: 'regimen_tributario', etiqueta: 'Régimen tributario', orden: 1 },
  { grupo: 'regimen_proveedor', grupo_label: 'Régimen Proveedor', valor: 'autorretenedor',     etiqueta: 'Régimen autorretenedor', orden: 2 },
  { grupo: 'regimen_proveedor', grupo_label: 'Régimen Proveedor', valor: 'regimen_ordinario',  etiqueta: 'Régimen ordinario',  orden: 3 },
  { grupo: 'regimen_proveedor', grupo_label: 'Régimen Proveedor', valor: 'regimen_simple',     etiqueta: 'Régimen simple',     orden: 4 },
  { grupo: 'regimen_proveedor', grupo_label: 'Régimen Proveedor', valor: 'regimen_especial',   etiqueta: 'Régimen especial',   orden: 5 },

  { grupo: 'iva', grupo_label: 'IVA (%)', valor: '0',    etiqueta: 'Excluido',  orden: 1 },
  { grupo: 'iva', grupo_label: 'IVA (%)', valor: '0.01', etiqueta: 'IVA (0%)',  orden: 2 },
  { grupo: 'iva', grupo_label: 'IVA (%)', valor: '5',    etiqueta: 'IVA (5%)',  orden: 3 },
  { grupo: 'iva', grupo_label: 'IVA (%)', valor: '19',   etiqueta: 'IVA (19%)', orden: 4 },

  { grupo: 'pais', grupo_label: 'País', valor: 'Colombia',                          etiqueta: 'Colombia',                          orden: 1   },
  { grupo: 'pais', grupo_label: 'País', valor: 'Afganistán',                        etiqueta: 'Afganistán',                        orden: 2   },
  { grupo: 'pais', grupo_label: 'País', valor: 'Albania',                           etiqueta: 'Albania',                           orden: 3   },
  { grupo: 'pais', grupo_label: 'País', valor: 'Alemania',                          etiqueta: 'Alemania',                          orden: 4   },
  { grupo: 'pais', grupo_label: 'País', valor: 'Andorra',                           etiqueta: 'Andorra',                           orden: 5   },
  { grupo: 'pais', grupo_label: 'País', valor: 'Angola',                            etiqueta: 'Angola',                            orden: 6   },
  { grupo: 'pais', grupo_label: 'País', valor: 'Antigua y Barbuda',                 etiqueta: 'Antigua y Barbuda',                 orden: 7   },
  { grupo: 'pais', grupo_label: 'País', valor: 'Arabia Saudita',                    etiqueta: 'Arabia Saudita',                    orden: 8   },
  { grupo: 'pais', grupo_label: 'País', valor: 'Argelia',                           etiqueta: 'Argelia',                           orden: 9   },
  { grupo: 'pais', grupo_label: 'País', valor: 'Argentina',                         etiqueta: 'Argentina',                         orden: 10  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Armenia',                           etiqueta: 'Armenia',                           orden: 11  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Australia',                         etiqueta: 'Australia',                         orden: 12  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Austria',                           etiqueta: 'Austria',                           orden: 13  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Azerbaiyán',                        etiqueta: 'Azerbaiyán',                        orden: 14  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Bahamas',                           etiqueta: 'Bahamas',                           orden: 15  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Bangladés',                         etiqueta: 'Bangladés',                         orden: 16  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Barbados',                          etiqueta: 'Barbados',                          orden: 17  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Baréin',                            etiqueta: 'Baréin',                            orden: 18  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Bélgica',                           etiqueta: 'Bélgica',                           orden: 19  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Belice',                            etiqueta: 'Belice',                            orden: 20  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Benín',                             etiqueta: 'Benín',                             orden: 21  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Bielorrusia',                       etiqueta: 'Bielorrusia',                       orden: 22  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Bolivia',                           etiqueta: 'Bolivia',                           orden: 23  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Bosnia y Herzegovina',              etiqueta: 'Bosnia y Herzegovina',              orden: 24  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Botsuana',                          etiqueta: 'Botsuana',                          orden: 25  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Brasil',                            etiqueta: 'Brasil',                            orden: 26  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Brunéi',                            etiqueta: 'Brunéi',                            orden: 27  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Bulgaria',                          etiqueta: 'Bulgaria',                          orden: 28  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Burkina Faso',                      etiqueta: 'Burkina Faso',                      orden: 29  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Burundi',                           etiqueta: 'Burundi',                           orden: 30  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Bután',                             etiqueta: 'Bután',                             orden: 31  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Cabo Verde',                        etiqueta: 'Cabo Verde',                        orden: 32  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Camboya',                           etiqueta: 'Camboya',                           orden: 33  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Camerún',                           etiqueta: 'Camerún',                           orden: 34  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Canadá',                            etiqueta: 'Canadá',                            orden: 35  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Catar',                             etiqueta: 'Catar',                             orden: 36  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Chad',                              etiqueta: 'Chad',                              orden: 37  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Chile',                             etiqueta: 'Chile',                             orden: 38  },
  { grupo: 'pais', grupo_label: 'País', valor: 'China',                             etiqueta: 'China',                             orden: 39  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Chipre',                            etiqueta: 'Chipre',                            orden: 40  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Comoras',                           etiqueta: 'Comoras',                           orden: 41  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Congo',                             etiqueta: 'Congo',                             orden: 42  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Congo (Rep. Democrática)',           etiqueta: 'Congo (Rep. Democrática)',           orden: 43  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Corea del Norte',                   etiqueta: 'Corea del Norte',                   orden: 44  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Corea del Sur',                     etiqueta: 'Corea del Sur',                     orden: 45  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Costa de Marfil',                   etiqueta: 'Costa de Marfil',                   orden: 46  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Costa Rica',                        etiqueta: 'Costa Rica',                        orden: 47  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Croacia',                           etiqueta: 'Croacia',                           orden: 48  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Cuba',                              etiqueta: 'Cuba',                              orden: 49  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Dinamarca',                         etiqueta: 'Dinamarca',                         orden: 50  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Dominica',                          etiqueta: 'Dominica',                          orden: 51  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Ecuador',                           etiqueta: 'Ecuador',                           orden: 52  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Egipto',                            etiqueta: 'Egipto',                            orden: 53  },
  { grupo: 'pais', grupo_label: 'País', valor: 'El Salvador',                       etiqueta: 'El Salvador',                       orden: 54  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Emiratos Árabes Unidos',            etiqueta: 'Emiratos Árabes Unidos',            orden: 55  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Eritrea',                           etiqueta: 'Eritrea',                           orden: 56  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Eslovaquia',                        etiqueta: 'Eslovaquia',                        orden: 57  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Eslovenia',                         etiqueta: 'Eslovenia',                         orden: 58  },
  { grupo: 'pais', grupo_label: 'País', valor: 'España',                            etiqueta: 'España',                            orden: 59  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Estados Unidos',                    etiqueta: 'Estados Unidos',                    orden: 60  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Estonia',                           etiqueta: 'Estonia',                           orden: 61  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Etiopía',                           etiqueta: 'Etiopía',                           orden: 62  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Filipinas',                         etiqueta: 'Filipinas',                         orden: 63  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Finlandia',                         etiqueta: 'Finlandia',                         orden: 64  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Fiyi',                              etiqueta: 'Fiyi',                              orden: 65  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Francia',                           etiqueta: 'Francia',                           orden: 66  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Gabón',                             etiqueta: 'Gabón',                             orden: 67  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Gambia',                            etiqueta: 'Gambia',                            orden: 68  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Georgia',                           etiqueta: 'Georgia',                           orden: 69  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Ghana',                             etiqueta: 'Ghana',                             orden: 70  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Granada',                           etiqueta: 'Granada',                           orden: 71  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Grecia',                            etiqueta: 'Grecia',                            orden: 72  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Guatemala',                         etiqueta: 'Guatemala',                         orden: 73  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Guinea',                            etiqueta: 'Guinea',                            orden: 74  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Guinea Ecuatorial',                 etiqueta: 'Guinea Ecuatorial',                 orden: 75  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Guinea-Bisáu',                      etiqueta: 'Guinea-Bisáu',                      orden: 76  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Guyana',                            etiqueta: 'Guyana',                            orden: 77  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Haití',                             etiqueta: 'Haití',                             orden: 78  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Honduras',                          etiqueta: 'Honduras',                          orden: 79  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Hungría',                           etiqueta: 'Hungría',                           orden: 80  },
  { grupo: 'pais', grupo_label: 'País', valor: 'India',                             etiqueta: 'India',                             orden: 81  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Indonesia',                         etiqueta: 'Indonesia',                         orden: 82  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Irak',                              etiqueta: 'Irak',                              orden: 83  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Irán',                              etiqueta: 'Irán',                              orden: 84  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Irlanda',                           etiqueta: 'Irlanda',                           orden: 85  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Islandia',                          etiqueta: 'Islandia',                          orden: 86  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Islas Marshall',                    etiqueta: 'Islas Marshall',                    orden: 87  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Islas Salomón',                     etiqueta: 'Islas Salomón',                     orden: 88  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Israel',                            etiqueta: 'Israel',                            orden: 89  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Italia',                            orden: 90,  etiqueta: 'Italia'                            },
  { grupo: 'pais', grupo_label: 'País', valor: 'Jamaica',                           etiqueta: 'Jamaica',                           orden: 91  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Japón',                             etiqueta: 'Japón',                             orden: 92  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Jordania',                          etiqueta: 'Jordania',                          orden: 93  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Kazajistán',                        etiqueta: 'Kazajistán',                        orden: 94  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Kenia',                             etiqueta: 'Kenia',                             orden: 95  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Kirguistán',                        etiqueta: 'Kirguistán',                        orden: 96  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Kiribati',                          etiqueta: 'Kiribati',                          orden: 97  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Kuwait',                            etiqueta: 'Kuwait',                            orden: 98  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Laos',                              etiqueta: 'Laos',                              orden: 99  },
  { grupo: 'pais', grupo_label: 'País', valor: 'Lesoto',                            etiqueta: 'Lesoto',                            orden: 100 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Letonia',                           etiqueta: 'Letonia',                           orden: 101 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Líbano',                            etiqueta: 'Líbano',                            orden: 102 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Liberia',                           etiqueta: 'Liberia',                           orden: 103 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Libia',                             etiqueta: 'Libia',                             orden: 104 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Liechtenstein',                     etiqueta: 'Liechtenstein',                     orden: 105 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Lituania',                          etiqueta: 'Lituania',                          orden: 106 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Luxemburgo',                        etiqueta: 'Luxemburgo',                        orden: 107 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Madagascar',                        etiqueta: 'Madagascar',                        orden: 108 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Malaui',                            etiqueta: 'Malaui',                            orden: 109 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Malasia',                           etiqueta: 'Malasia',                           orden: 110 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Maldivas',                          etiqueta: 'Maldivas',                          orden: 111 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Malí',                              etiqueta: 'Malí',                              orden: 112 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Malta',                             etiqueta: 'Malta',                             orden: 113 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Marruecos',                         etiqueta: 'Marruecos',                         orden: 114 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Mauricio',                          etiqueta: 'Mauricio',                          orden: 115 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Mauritania',                        etiqueta: 'Mauritania',                        orden: 116 },
  { grupo: 'pais', grupo_label: 'País', valor: 'México',                            etiqueta: 'México',                            orden: 117 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Micronesia',                        etiqueta: 'Micronesia',                        orden: 118 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Moldavia',                          etiqueta: 'Moldavia',                          orden: 119 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Mónaco',                            etiqueta: 'Mónaco',                            orden: 120 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Mongolia',                          etiqueta: 'Mongolia',                          orden: 121 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Montenegro',                        etiqueta: 'Montenegro',                        orden: 122 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Mozambique',                        etiqueta: 'Mozambique',                        orden: 123 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Namibia',                           etiqueta: 'Namibia',                           orden: 124 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Nauru',                             etiqueta: 'Nauru',                             orden: 125 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Nepal',                             etiqueta: 'Nepal',                             orden: 126 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Nicaragua',                         etiqueta: 'Nicaragua',                         orden: 127 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Níger',                             etiqueta: 'Níger',                             orden: 128 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Nigeria',                           etiqueta: 'Nigeria',                           orden: 129 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Noruega',                           etiqueta: 'Noruega',                           orden: 130 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Nueva Zelanda',                     etiqueta: 'Nueva Zelanda',                     orden: 131 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Omán',                              etiqueta: 'Omán',                              orden: 132 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Países Bajos',                      etiqueta: 'Países Bajos',                      orden: 133 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Pakistán',                          etiqueta: 'Pakistán',                          orden: 134 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Palaos',                            etiqueta: 'Palaos',                            orden: 135 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Palestina',                         etiqueta: 'Palestina',                         orden: 136 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Panamá',                            etiqueta: 'Panamá',                            orden: 137 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Papúa Nueva Guinea',                etiqueta: 'Papúa Nueva Guinea',                orden: 138 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Paraguay',                          etiqueta: 'Paraguay',                          orden: 139 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Perú',                              etiqueta: 'Perú',                              orden: 140 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Polonia',                           etiqueta: 'Polonia',                           orden: 141 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Portugal',                          etiqueta: 'Portugal',                          orden: 142 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Reino Unido',                       etiqueta: 'Reino Unido',                       orden: 143 },
  { grupo: 'pais', grupo_label: 'País', valor: 'República Centroafricana',           etiqueta: 'República Centroafricana',           orden: 144 },
  { grupo: 'pais', grupo_label: 'País', valor: 'República Checa',                   etiqueta: 'República Checa',                   orden: 145 },
  { grupo: 'pais', grupo_label: 'País', valor: 'República Dominicana',              etiqueta: 'República Dominicana',              orden: 146 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Ruanda',                            etiqueta: 'Ruanda',                            orden: 147 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Rumania',                           etiqueta: 'Rumania',                           orden: 148 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Rusia',                             etiqueta: 'Rusia',                             orden: 149 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Samoa',                             etiqueta: 'Samoa',                             orden: 150 },
  { grupo: 'pais', grupo_label: 'País', valor: 'San Cristóbal y Nieves',            etiqueta: 'San Cristóbal y Nieves',            orden: 151 },
  { grupo: 'pais', grupo_label: 'País', valor: 'San Marino',                        etiqueta: 'San Marino',                        orden: 152 },
  { grupo: 'pais', grupo_label: 'País', valor: 'San Vicente y las Granadinas',      etiqueta: 'San Vicente y las Granadinas',      orden: 153 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Santa Lucía',                       etiqueta: 'Santa Lucía',                       orden: 154 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Santo Tomé y Príncipe',             etiqueta: 'Santo Tomé y Príncipe',             orden: 155 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Senegal',                           etiqueta: 'Senegal',                           orden: 156 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Serbia',                            etiqueta: 'Serbia',                            orden: 157 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Seychelles',                        etiqueta: 'Seychelles',                        orden: 158 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Sierra Leona',                      etiqueta: 'Sierra Leona',                      orden: 159 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Singapur',                          etiqueta: 'Singapur',                          orden: 160 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Siria',                             etiqueta: 'Siria',                             orden: 161 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Somalia',                           etiqueta: 'Somalia',                           orden: 162 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Sri Lanka',                         etiqueta: 'Sri Lanka',                         orden: 163 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Sudáfrica',                         etiqueta: 'Sudáfrica',                         orden: 164 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Sudán',                             etiqueta: 'Sudán',                             orden: 165 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Sudán del Sur',                     etiqueta: 'Sudán del Sur',                     orden: 166 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Suecia',                            etiqueta: 'Suecia',                            orden: 167 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Suiza',                             etiqueta: 'Suiza',                             orden: 168 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Surinam',                           etiqueta: 'Surinam',                           orden: 169 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Tailandia',                         etiqueta: 'Tailandia',                         orden: 170 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Tanzania',                          etiqueta: 'Tanzania',                          orden: 171 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Tayikistán',                        etiqueta: 'Tayikistán',                        orden: 172 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Timor Oriental',                    etiqueta: 'Timor Oriental',                    orden: 173 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Togo',                              etiqueta: 'Togo',                              orden: 174 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Tonga',                             etiqueta: 'Tonga',                             orden: 175 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Trinidad y Tobago',                 etiqueta: 'Trinidad y Tobago',                 orden: 176 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Túnez',                             etiqueta: 'Túnez',                             orden: 177 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Turkmenistán',                      etiqueta: 'Turkmenistán',                      orden: 178 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Turquía',                           etiqueta: 'Turquía',                           orden: 179 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Tuvalu',                            etiqueta: 'Tuvalu',                            orden: 180 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Ucrania',                           etiqueta: 'Ucrania',                           orden: 181 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Uganda',                            etiqueta: 'Uganda',                            orden: 182 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Uruguay',                           etiqueta: 'Uruguay',                           orden: 183 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Uzbekistán',                        etiqueta: 'Uzbekistán',                        orden: 184 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Vanuatu',                           etiqueta: 'Vanuatu',                           orden: 185 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Vaticano',                          etiqueta: 'Vaticano',                          orden: 186 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Venezuela',                         etiqueta: 'Venezuela',                         orden: 187 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Vietnam',                           etiqueta: 'Vietnam',                           orden: 188 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Yemen',                             etiqueta: 'Yemen',                             orden: 189 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Yibuti',                            etiqueta: 'Yibuti',                            orden: 190 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Zambia',                            etiqueta: 'Zambia',                            orden: 191 },
  { grupo: 'pais', grupo_label: 'País', valor: 'Zimbabue',                          etiqueta: 'Zimbabue',                          orden: 192 },
];

export async function initParametrosTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS parametros_sistema (
      id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      grupo       VARCHAR(80)  NOT NULL,
      grupo_label VARCHAR(120) NOT NULL,
      valor       VARCHAR(200) NOT NULL,
      etiqueta    VARCHAR(200) NOT NULL,
      orden       SMALLINT     NOT NULL DEFAULT 0,
      activo      TINYINT(1)   NOT NULL DEFAULT 1,
      UNIQUE KEY uq_grupo_valor (grupo, valor)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  for (const row of SEED) {
    await query(
      `INSERT IGNORE INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo) VALUES (?, ?, ?, ?, ?, 1)`,
      [row.grupo, row.grupo_label, row.valor, row.etiqueta, row.orden]
    );
  }

  const LABEL_FIXES = [
    { grupo: 'regimen_proveedor', valor: 'autorretenedor', etiqueta: 'Régimen autorretenedor' },
  ];
  for (const fix of LABEL_FIXES) {
    await query(
      `UPDATE parametros_sistema SET etiqueta = ? WHERE grupo = ? AND valor = ? AND etiqueta != ?`,
      [fix.etiqueta, fix.grupo, fix.valor, fix.etiqueta]
    );
  }
}

export async function listGrupos() {
  return query(`
    SELECT grupo, grupo_label, COUNT(*) AS total, SUM(activo) AS activos
    FROM parametros_sistema
    GROUP BY grupo, grupo_label
    ORDER BY grupo_label ASC
  `);
}

export async function listByGrupo(grupo) {
  return query(
    `SELECT id, grupo, grupo_label, valor, etiqueta, orden, activo
     FROM parametros_sistema
     WHERE grupo = ?
     ORDER BY orden ASC, etiqueta ASC`,
    [grupo]
  );
}

export async function listActivosByGrupo(grupo) {
  return query(
    `SELECT valor, etiqueta FROM parametros_sistema
     WHERE grupo = ? AND activo = 1
     ORDER BY orden ASC, etiqueta ASC`,
    [grupo]
  );
}

export async function getParametroById(id) {
  const [row] = await query(`SELECT * FROM parametros_sistema WHERE id = ?`, [id]);
  return row ?? null;
}

export async function createParametro(data) {
  const grupo       = (data.grupo ?? '').trim();
  const grupo_label = (data.grupo_label ?? '').trim();
  const valor       = (data.valor ?? '').trim();
  const etiqueta    = (data.etiqueta ?? '').trim();
  const orden       = Number(data.orden ?? 0);

  if (!grupo)       throw new HttpError(400, 'El grupo es requerido');
  if (!valor)       throw new HttpError(400, 'El valor es requerido');
  if (!etiqueta)    throw new HttpError(400, 'La etiqueta es requerida');

  const [existing] = await query(
    `SELECT id FROM parametros_sistema WHERE grupo = ? AND valor = ?`,
    [grupo, valor]
  );
  if (existing) throw new HttpError(409, `Ya existe una opción con valor "${valor}" en este grupo`);

  const result = await query(
    `INSERT INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo) VALUES (?, ?, ?, ?, ?, 1)`,
    [grupo, grupo_label || grupo, valor, etiqueta, orden]
  );
  return { id: result.insertId };
}

export async function updateParametro(id, data) {
  const row = await getParametroById(id);
  if (!row) throw new HttpError(404, 'Parámetro no encontrado');

  const etiqueta = (data.etiqueta ?? row.etiqueta).trim();
  const orden    = data.orden !== undefined ? Number(data.orden) : row.orden;

  if (!etiqueta) throw new HttpError(400, 'La etiqueta es requerida');

  await query(
    `UPDATE parametros_sistema SET etiqueta = ?, orden = ? WHERE id = ?`,
    [etiqueta, orden, id]
  );
}

export async function toggleParametro(id) {
  const row = await getParametroById(id);
  if (!row) throw new HttpError(404, 'Parámetro no encontrado');
  await query(`UPDATE parametros_sistema SET activo = ? WHERE id = ?`, [row.activo ? 0 : 1, id]);
  return { activo: !row.activo };
}

export async function deleteParametro(id) {
  const row = await getParametroById(id);
  if (!row) throw new HttpError(404, 'Parámetro no encontrado');
  await query(`DELETE FROM parametros_sistema WHERE id = ?`, [id]);
}
