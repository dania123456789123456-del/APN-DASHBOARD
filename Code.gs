/**
 * ============================================================================
 *  APN · BACKEND ÚNICO (Google Apps Script) — v2
 * ============================================================================
 *  Los HTML de registro ESCRIBEN aquí. El dashboard LEE y EDITA aquí.
 *  Todo se guarda en la hoja de cálculo a la que está vinculado este script.
 *
 *  PASOS (una sola vez)
 *   1. Crea una hoja de Google Sheets nueva > Extensiones > Apps Script.
 *   2. Pega este archivo como Code.gs y el appsscript.json (Configuración del
 *      proyecto > "Mostrar archivo de manifiesto").
 *   3. Cambia ADMIN_CLAVE y PIN_INICIAL aquí abajo.
 *   4. Ejecuta la función setup() una vez (te pedirá permisos).
 *   5. Implementar > Nueva implementación > Aplicación web
 *        Ejecutar como: Yo   |   Quién tiene acceso: Cualquier usuario
 *      Copia el link /exec: ese es el ÚNICO API_URL para los HTML y el dashboard.
 *   6. Cada vez que cambies este código: Implementar > Administrar
 *      implementaciones > editar > Nueva versión.
 *
 *  HOJAS (se crean solas)
 *   Personas   · agentes, limpieza, trabajadores, conductores (creados desde el dashboard)
 *   Vehiculos  · vehículos (creados desde el dashboard)
 *   Servicios  · qué agente está en cada turno (fecha + día/noche)
 *   Cuadernos  · opciones y ediciones del cuaderno por fecha+turno
 *   Config     · logo, firma del supervisor, textos, PIN
 *   Ediciones  · bitácora de cambios hechos desde el dashboard
 *   reg_<módulo> · un registro por módulo (reg_personal, reg_vehicular, reg_visitas...)
 *                  Se crean solas la primera vez que un HTML envía datos de ese módulo.
 *
 *  MÓDULO VISITAS (para el cuaderno): reg_visitas con los campos
 *   nombre, dni, entidad, motivo, observaciones, fecha, hora (ingreso), horaSalida, fechaSalida
 * ============================================================================
 */

const CFG = {
  TZ: 'America/Lima',
  ADMIN_USUARIO: 'admin',
  ADMIN_CLAVE: 'CAMBIAME-123',   // solo se usa en setup()
  PIN_INICIAL: '1234',           // solo se usa en setup()
  TOKEN_DIAS: 30,
  DIAS_POR_DEFECTO: 62,          // cuántos días hacia atrás devuelve getData
  TURNOS: { dia: { ini: 7, fin: 19, nombre: 'DÍA' }, noche: { ini: 19, fin: 7, nombre: 'NOCHE' } }
};

// Valores por defecto de la hoja Config (se editan desde el dashboard)
const CONFIG_DEFECTO = {
  unidad: 'Autoridad Portuaria Nacional',
  tituloEmpresa: 'SERVICIO DE SEGURIDAD PRIVADA P.R.C S.A.C',
  logoUrl: '',
  logoPieUrl: '',
  firmaSupervisorUrl: '',
  supervisorNombre: '',
  fotoEmpresaUrl: '',
  portadaPersonalUrl: '',
  portadaVehicularUrl: '',
  portadaVisitasUrl: '',
  portadaCuadernoUrl: '',
  descripcionEmpresa: '',
  textoInicio: 'Se inicia el servicio con el agente saliente {saliente}, encontrando todo conforme y S/N.',
  textoFin: 'Se finaliza el servicio con el agente entrante {entrante}, dejando todo conforme y S/N.',
  textoSinNovedad: 'Se mantiene el servicio, todo conforme y S/N.',
  textoSupervision: 'Ronda y supervisión S/N.',
  textoLimpieza: 'Personal de limpieza',
  textoInicioLabores: 'Inicio de labores {nombre}',
  textoTerminoLabores: 'Término de labores {nombre}',
  textoLimpiezaFila: '{nombre} personal de limpieza',
  textoVisita: 'Ingresa {nombre} DNI: {dni}, {entidad}, {motivo}'
};

const COLUMNAS = {
  Personas: ['id', 'rol', 'nombre', 'usuario', 'salt', 'hash', 'fotoUrl', 'firmaUrl', 'activo', 'creadoEn'],
  Vehiculos: ['id', 'placa', 'descripcion', 'activo', 'creadoEn'],
  Servicios: ['id', 'fecha', 'turno', 'agenteId', 'agenteNombre', 'horaInicio', 'actualizadoEn'],
  Cuadernos: ['id', 'fecha', 'turno', 'limpiezaActiva', 'supervisionHora', 'ediciones', 'actualizadoEn'],
  Config: ['clave', 'valor'],
  Ediciones: ['fecha', 'quien', 'modulo', 'id', 'cambios']
};

const ROLES = ['admin', 'agente', 'limpieza', 'trabajador', 'conductor'];
const CLAVES_NUMERICAS = ['kmSalida', 'kmLlegada', 'kmRecorridos'];

// ============================================================================
//  PUNTO DE ENTRADA
// ============================================================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  let data = {};
  try { if (p.data) data = JSON.parse(p.data); } catch (err) { /* ignorar */ }
  return responder(procesar({ action: p.action, token: p.token, since: p.since, desde: p.desde, data: data }));
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return responder({ status: 'error', message: 'JSON inválido' }); }
  return responder(procesar(body));
}

function responder(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// auth: false = público | 'any' = cualquier usuario con sesión | 'admin' = solo admin
// pin: true = además exige el PIN del dashboard
const ACCIONES = {
  ping:            { auth: false },
  login:           { auth: false },
  getData:         { auth: 'any' },
  addRegistro:     { auth: 'any', escribe: true },
  iniciarServicio: { auth: 'any', escribe: true },
  getCuaderno:     { auth: 'any' },
  getCuadernos:    { auth: 'any' },
  verifyPin:       { auth: 'admin' },
  updateRegistro:  { auth: 'admin', pin: true, escribe: true },
  deleteRegistro:  { auth: 'admin', pin: true, escribe: true },
  savePersona:     { auth: 'admin', escribe: true },
  deletePersona:   { auth: 'admin', escribe: true },
  setClave:        { auth: 'admin', escribe: true },
  saveVehiculo:    { auth: 'admin', escribe: true },
  deleteVehiculo:  { auth: 'admin', escribe: true },
  saveCuaderno:    { auth: 'admin', escribe: true },
  saveConfig:      { auth: 'admin', escribe: true },
  setPin:          { auth: 'admin', pin: true, escribe: true }
};

function procesar(req) {
  const def = ACCIONES[req.action];
  if (!def) return { status: 'error', message: 'Acción desconocida: ' + req.action };
  const lock = LockService.getScriptLock();
  try {
    if (def.escribe) lock.waitLock(20000);
    let user = null;
    if (def.auth) {
      user = validarToken(req.token);
      if (!user) return { status: 'auth', message: 'Sesión inválida o vencida. Inicia sesión de nuevo.' };
      if (def.auth === 'admin' && user.rol !== 'admin') return { status: 'error', message: 'Solo el administrador puede hacer esto.' };
    }
    if (def.pin && !pinCorrecto((req.data || {}).pin)) return { status: 'pin', message: 'PIN incorrecto.' };
    const out = EJECUTORES[req.action](req.data || {}, user, req);
    if (def.escribe && out && out.status === 'success') tocar();
    return out;
  } catch (err) {
    return { status: 'error', message: String(err && err.message || err) };
  } finally {
    try { lock.releaseLock(); } catch (e2) { /* sin lock */ }
  }
}

// ============================================================================
//  EJECUTORES
// ============================================================================
const EJECUTORES = {
  ping: () => ({ status: 'success', pong: true, ahora: ahora().texto }),

  login: (d) => {
    const u = String(d.usuario || '').trim().toLowerCase();
    const p = leerTodo('Personas').find(x => String(x.usuario || '').toLowerCase() === u && esActivo(x));
    if (!p || !p.hash || hashClave(p.salt, d.clave) !== p.hash) return { status: 'error', message: 'Usuario o contraseña incorrectos.' };
    return { status: 'success', token: crearToken(p), user: { id: p.id, rol: p.rol, nombre: p.nombre, firmaUrl: p.firmaUrl || '' } };
  },

  getData: (d, user, req) => {
    const mod = propiedad('MOD') || '0';
    if (req.since && String(req.since) === mod) return { status: 'success', unchanged: true, modifiedAt: mod };
    const desde = req.desde || sumarDias(ahora().fecha, -CFG.DIAS_POR_DEFECTO);
    const modulos = {};
    nombresHojas().filter(n => n.indexOf('reg_') === 0).forEach(n => {
      modulos[n.slice(4)] = leerTodo(n).filter(r => !esTrue(r.eliminado) && (!(r.fecha || r.fechaSalida) || String(r.fecha || r.fechaSalida) >= desde));
    });
    // Las salidas/retornos en vehículo cuentan también como salida/ingreso del conductor y de los pasajeros
    modulos.personal = (modulos.personal || []).filter(r => !r.derivado).concat(derivarPersonal(modulos.vehicular || []));
    return {
      status: 'success', modifiedAt: mod, ahora: ahora().texto, yo: { id: user.id, rol: user.rol, nombre: user.nombre },
      personas: leerTodo('Personas').map(sinSecretos),
      vehiculos: leerTodo('Vehiculos'),
      servicios: leerTodo('Servicios').filter(s => String(s.fecha) >= desde),
      cuadernos: leerTodo('Cuadernos').filter(s => String(s.fecha) >= desde),
      config: leerConfig(),
      modulos: modulos
    };
  },

  addRegistro: (d, user) => {
    const modulo = limpiarModulo(d.modulo);
    const reg = Object.assign({}, d.registro || {});
    if (!reg.id) reg.id = 'r_' + idUnico();
    reg.registradoPor = reg.registradoPor || user.nombre;
    reg.registradoPorId = user.id;
    reg.creadoEn = reg.creadoEn || ahora().texto;
    upsert('reg_' + modulo, reg, 'id');   // upsert = reenviar lo mismo (cola sin conexión) NO duplica
    return { status: 'success', id: reg.id };
  },

  iniciarServicio: (d, user) => {
    const turno = d.turno === 'noche' ? 'noche' : 'dia';
    const n = ahora();
    let fecha = d.fecha || n.fecha;
    // Pasada la medianoche el turno noche sigue siendo de la fecha en que empezó
    if (!d.fecha && turno === 'noche' && n.hora < CFG.TURNOS.noche.fin * 60) fecha = sumarDias(n.fecha, -1);
    let agente = user;
    if (d.agenteId && user.rol === 'admin') agente = leerTodo('Personas').find(p => p.id === d.agenteId) || user;
    const s = { id: fecha + '|' + turno, fecha: fecha, turno: turno, agenteId: agente.id, agenteNombre: agente.nombre,
                horaInicio: d.hora || n.texto.slice(11, 16), actualizadoEn: n.texto };
    upsert('Servicios', s, 'id');
    return { status: 'success', servicio: s };
  },

  getCuaderno: (d) => {
    const turno = d.turno === 'noche' ? 'noche' : 'dia';
    return { status: 'success', cuaderno: armarCuaderno(String(d.fecha), turno, contextoCuaderno(String(d.fecha))) };
  },

  // Varias fechas de una vez (día y noche de cada una) para el libro del dashboard: lee las hojas una sola vez
  getCuadernos: (d) => {
    const ctx = contextoCuaderno('');
    const out = [];
    (d.fechas || []).slice(0, 7).forEach(f => { ['dia', 'noche'].forEach(t => out.push(armarCuaderno(String(f), t, ctx))); });
    return { status: 'success', cuadernos: out };
  },

  verifyPin: (d) => ({ status: 'success' }),

  updateRegistro: (d, user) => {
    const modulo = limpiarModulo(d.modulo);
    const hoja = 'reg_' + modulo;
    const antes = leerTodo(hoja).find(r => String(r.id) === String(d.registro.id));
    if (!antes) return { status: 'error', message: 'No existe ese registro.' };
    const cambios = {};
    Object.keys(d.registro).forEach(k => { if (String(valorPlano(antes[k])) !== String(valorPlano(d.registro[k]))) cambios[k] = [antes[k], d.registro[k]]; });
    const nuevo = Object.assign({}, d.registro, { editadoPor: user.nombre, editadoEn: ahora().texto });
    upsert(hoja, nuevo, 'id');
    registrarEdicion(user, modulo, d.registro.id, cambios);
    return { status: 'success' };
  },

  deleteRegistro: (d, user) => {
    const modulo = limpiarModulo(d.modulo);
    upsert('reg_' + modulo, { id: d.id, eliminado: 'true', editadoPor: user.nombre, editadoEn: ahora().texto }, 'id');
    registrarEdicion(user, modulo, d.id, { eliminado: ['', 'true'] });
    return { status: 'success' };
  },

  savePersona: (d) => {
    const p = Object.assign({}, d.persona || {});
    if (ROLES.indexOf(p.rol) === -1) return { status: 'error', message: 'Rol inválido.' };
    if (!p.nombre) return { status: 'error', message: 'Falta el nombre.' };
    const existe = p.id ? leerTodo('Personas').find(x => x.id === p.id) : null;
    if (!p.id) { p.id = 'p_' + idUnico(); p.creadoEn = ahora().texto; p.activo = 'true'; }
    if (p.usuario) {
      const otro = leerTodo('Personas').find(x => String(x.usuario).toLowerCase() === String(p.usuario).toLowerCase() && x.id !== p.id);
      if (otro) return { status: 'error', message: 'Ese usuario ya existe.' };
    }
    if (p.clave) { p.salt = Utilities.getUuid(); p.hash = hashClave(p.salt, p.clave); }
    delete p.clave;
    upsert('Personas', p, 'id');
    return { status: 'success', id: p.id, nuevo: !existe };
  },

  deletePersona: (d) => { upsert('Personas', { id: d.id, activo: 'false' }, 'id'); return { status: 'success' }; },

  setClave: (d) => {
    if (!d.id || !d.clave || String(d.clave).length < 4) return { status: 'error', message: 'Clave muy corta (mínimo 4).' };
    const salt = Utilities.getUuid();
    upsert('Personas', { id: d.id, salt: salt, hash: hashClave(salt, d.clave) }, 'id');
    return { status: 'success' };
  },

  saveVehiculo: (d) => {
    const v = Object.assign({}, d.vehiculo || {});
    if (!v.placa) return { status: 'error', message: 'Falta la placa.' };
    if (!v.id) { v.id = 'v_' + idUnico(); v.creadoEn = ahora().texto; v.activo = 'true'; }
    upsert('Vehiculos', v, 'id');
    return { status: 'success', id: v.id };
  },

  deleteVehiculo: (d) => { upsert('Vehiculos', { id: d.id, activo: 'false' }, 'id'); return { status: 'success' }; },

  // Opciones del cuaderno y ediciones por hora.
  // ediciones = { textos:{clave:{texto,hi,hs}}, extras:[{id,hi,hs,texto,tipo}], ocultas:[clave] }
  saveCuaderno: (d) => {
    const turno = d.turno === 'noche' ? 'noche' : 'dia';
    const id = d.fecha + '|' + turno;
    const fila = { id: id, fecha: d.fecha, turno: turno, actualizadoEn: ahora().texto };
    if ('limpiezaActiva' in d) fila.limpiezaActiva = d.limpiezaActiva ? 'true' : 'false';
    if ('supervisionHora' in d) fila.supervisionHora = d.supervisionHora || '';
    if (d.ediciones) fila.ediciones = limpiarEdiciones(d.ediciones);
    upsert('Cuadernos', fila, 'id');
    return { status: 'success' };
  },

  saveConfig: (d) => {
    Object.keys(d.config || {}).forEach(k => { if (k in CONFIG_DEFECTO) upsert('Config', { clave: k, valor: d.config[k] }, 'clave'); });
    return { status: 'success' };
  },

  setPin: (d) => {
    if (!d.nuevoPin || String(d.nuevoPin).length < 4) return { status: 'error', message: 'PIN muy corto (mínimo 4).' };
    PropertiesService.getScriptProperties().setProperty('PIN_HASH', hashClave('pin', d.nuevoPin));
    return { status: 'success' };
  }
};

// ============================================================================
//  SETUP (ejecutar una vez a mano)
// ============================================================================
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  Object.keys(COLUMNAS).forEach(n => { asegurarEncabezados(hoja(n), COLUMNAS[n]); });
  Object.keys(CONFIG_DEFECTO).forEach(k => {
    if (!leerTodo('Config').some(c => c.clave === k)) upsert('Config', { clave: k, valor: CONFIG_DEFECTO[k] }, 'clave');
  });
  if (!leerTodo('Personas').some(p => p.rol === 'admin')) {
    const salt = Utilities.getUuid();
    upsert('Personas', { id: 'p_admin', rol: 'admin', nombre: 'Administrador', usuario: CFG.ADMIN_USUARIO, salt: salt,
      hash: hashClave(salt, CFG.ADMIN_CLAVE), activo: 'true', creadoEn: ahora().texto }, 'id');
  }
  if (!props.getProperty('PIN_HASH')) props.setProperty('PIN_HASH', hashClave('pin', CFG.PIN_INICIAL));
  tocar();
  Logger.log('Listo. Usuario admin: ' + CFG.ADMIN_USUARIO + ' — ahora implementa como Aplicación web.');
}

// ============================================================================
//  CUADERNO DE OCURRENCIAS (se arma solo con los registros)
// ============================================================================
function contextoCuaderno(fecha) {
  const existe = n => nombresHojas().indexOf(n) !== -1;
  return {
    personas: leerTodo('Personas'),
    servicios: leerTodo('Servicios'),
    cuadernos: leerTodo('Cuadernos'),
    config: leerConfig(),
    regPersonal: (existe('reg_personal') ? leerTodo('reg_personal').filter(r => !esTrue(r.eliminado)) : [])
      .concat(derivarPersonal(existe('reg_vehicular') ? leerTodo('reg_vehicular') : [])),
    regVehicular: existe('reg_vehicular') ? leerTodo('reg_vehicular').filter(r => !esTrue(r.eliminado)) : [],
    regVisitas: existe('reg_visitas') ? leerTodo('reg_visitas').filter(r => !esTrue(r.eliminado)) : []
  };
}

/**
 * Reglas de las filas:
 *  - Siempre están las 12 horas del turno (HH:00). Si un dato cae justo a la hora en punto, ocupa esa fila.
 *  - Trabajadores: "Inicio de labores X" en H.I y "Término de labores X" en H.S (filas distintas).
 *  - Personal de limpieza (solo si la casilla está activa) y visitas: H.I y H.S en la MISMA fila.
 *  - Vehículos: salida en H.S, retorno en H.I.
 *  - tipo 'sistema' (texto fijo: azul) / 'dato' (registrado: rojo-salmón).
 *  - Cada fila trae una "key" estable para poder editarla desde el dashboard.
 */
function armarCuaderno(fecha, turno, ctx) {
  const T = CFG.TURNOS[turno];
  const cfg = Object.assign({}, CONFIG_DEFECTO, ctx.config || {});
  const ini = T.ini * 60;
  const hh = s => String(s || '').slice(0, 5);
  const lleno = s => !!(s && String(s).indexOf(':') !== -1);

  // minutos desde el inicio del turno para una (fecha, hora)
  const offsetDe = (f, hhmm) => {
    const m = aMin(hhmm);
    if (turno === 'dia') return String(f) === fecha ? m - ini : null;
    if (String(f) === fecha) return m - ini;                              // 19:00–23:59
    if (String(f) === sumarDias(fecha, 1)) return m + 1440 - ini;         // 00:00–06:59
    return null;
  };
  // para horas escritas a mano (sin fecha): se asume dentro del turno
  const offsetLibre = hhmm => { const m = aMin(hhmm); return turno === 'dia' ? m - ini : (m >= ini ? m - ini : m + 1440 - ini); };
  const dentro = off => off !== null && off >= 0 && off < 720;

  // --- agentes: anterior, actual, siguiente
  const serv = (f, t2) => (ctx.servicios || []).find(s => String(s.fecha) === f && s.turno === t2);
  const prevS = turno === 'dia' ? serv(sumarDias(fecha, -1), 'noche') : serv(fecha, 'dia');
  const actS = serv(fecha, turno);
  const nextS = turno === 'dia' ? serv(fecha, 'noche') : serv(sumarDias(fecha, 1), 'dia');
  const firmaDe = s => { const p = s && (ctx.personas || []).find(x => x.id === s.agenteId); return p ? (p.firmaUrl || '') : ''; };
  const ficha = s => ({ nombre: s ? s.agenteNombre : '', firmaUrl: firmaDe(s) });
  const saliente = ficha(prevS), actual = ficha(actS), entrante = ficha(nextS);

  const opc = (ctx.cuadernos || []).find(c => String(c.fecha) === fecha && c.turno === turno) || {};
  const limpiezaActiva = esTrue(opc.limpiezaActiva);
  const supHora = opc.supervisionHora ? String(opc.supervisionHora) : '';
  const ed = limpiarEdiciones(opc.ediciones);

  // Minutos transcurridos desde el inicio del turno (negativo: aún no empieza; >= 720: ya terminó)
  const nw = ahora();
  const dd = String(nw.fecha).split('-'), df = fecha.split('-');
  const difDias = Math.round((Date.UTC(+dd[0], +dd[1] - 1, +dd[2]) - Date.UTC(+df[0], +df[1] - 1, +df[2])) / 86400000);
  const nowOff = difDias * 1440 + nw.hora - ini;
  const horaPasada = i => nowOff >= (i + 1) * 60;      // la hora i ya terminó: recién ahí se escribe "se mantiene el servicio…"

  const rolDe = nombre => { const p = (ctx.personas || []).find(x => String(x.nombre).trim() === String(nombre).trim()); return p ? p.rol : ''; };
  const fmt = (plantilla, o) => String(plantilla).replace(/\{(\w+)\}/g, (m, k) => (o[k] !== undefined && o[k] !== '' && o[k] !== null ? String(o[k]).trim() : '________'));

  // ------------------------------------------------------------------ eventos
  let eventos = [];

  // Personal: ordenado por hora para poder emparejar
  const regsP = (ctx.regPersonal || []).map(r => ({ r: r, off: offsetDe(r.fecha, r.hora), nombre: String(r.nombre || '').trim() }))
    .filter(x => dentro(x.off)).sort((a, b) => a.off - b.off);
  const porNombre = {};
  regsP.forEach(x => { (porNombre[x.nombre] = porNombre[x.nombre] || []).push(x); });
  Object.keys(porNombre).forEach(nombre => {
    const lista = porNombre[nombre];
    if (rolDe(nombre) === 'limpieza') {
      if (!limpiezaActiva) return;                                   // sin casilla: no se muestra
      let abierta = null;
      const cerrar = () => { if (abierta) { eventos.push(abierta); abierta = null; } };
      lista.forEach(x => {
        const ing = String(x.r.tipo).toLowerCase() === 'ingreso';
        const texto = fmt(cfg.textoLimpiezaFila, { nombre: nombre });
        if (ing) { cerrar(); abierta = { key: 'l:' + x.r.id, off: x.off, hi: hh(x.r.hora), hs: '', tipo: 'dato', origen: 'limpieza', texto: texto }; }
        else if (abierta) { abierta.hs = hh(x.r.hora); cerrar(); }
        else eventos.push({ key: 'l:' + x.r.id, off: x.off, hi: '', hs: hh(x.r.hora), tipo: 'dato', origen: 'limpieza', texto: texto });
      });
      cerrar();
    } else {
      let yaIngreso = false;
      lista.forEach(x => {
        const ing = String(x.r.tipo).toLowerCase() === 'ingreso';
        const mot = String(x.r.motivo || '').trim();
        if (ing) {
          eventos.push({ key: 'p:' + x.r.id, off: x.off, hi: hh(x.r.hora), hs: '', tipo: 'dato', origen: 'personal',
            texto: (yaIngreso || x.r.derivado) ? 'Reingresa ' + nombre : fmt(cfg.textoInicioLabores, { nombre: nombre }) });
          yaIngreso = true;
        } else {
          const termino = !mot || /t[eé]rmino/i.test(mot);
          eventos.push({ key: 'p:' + x.r.id, off: x.off, hi: '', hs: hh(x.r.hora), tipo: 'dato', origen: 'personal',
            texto: termino ? fmt(cfg.textoTerminoLabores, { nombre: nombre }) : 'Salida ' + nombre + ' (' + mot + ')' });
        }
      });
    }
  });

  // Visitas: una sola fila con H.I y H.S
  (ctx.regVisitas || []).forEach(r => {
    const hIn = r.horaIngreso || r.hora;
    if (!lleno(hIn)) return;
    const off = offsetDe(r.fecha, hIn);
    if (!dentro(off)) return;
    let hs = '';
    if (lleno(r.horaSalida)) {
      const o2 = offsetDe(r.fechaSalida || r.fecha, r.horaSalida);
      if (o2 === null || dentro(o2)) hs = hh(r.horaSalida);
    }
    eventos.push({ key: 'v:' + r.id, off: off, hi: hh(hIn), hs: hs, tipo: 'dato', origen: 'visita',
      texto: fmt(cfg.textoVisita, { nombre: r.nombre, dni: r.dni || r.documento, entidad: r.entidad || r.empresa, motivo: r.motivo }) });
  });

  // Vehículos: salida en H.S, retorno en H.I
  (ctx.regVehicular || []).forEach(r => {
    const base = 'la unidad ' + (r.vehiculoPlaca || '') + (r.conductor ? ' conducida por ' + String(r.conductor).trim() : '');
    if (r.fechaSalida && lleno(r.horaSalida)) {
      const off = offsetDe(r.fechaSalida, r.horaSalida);
      if (dentro(off)) eventos.push({ key: 'vs:' + r.id, off: off, hi: '', hs: hh(r.horaSalida), tipo: 'dato', origen: 'vehiculo',
        texto: 'Sale ' + base + (r.destino ? ', con destino a ' + r.destino : '') + (r.motivo ? ', por motivo de ' + r.motivo : '') +
          (r.kmSalida !== '' && r.kmSalida != null ? ', km. ' + r.kmSalida : '') + pasajerosTxt(r.pasajeros) + (r.obsSalida ? '. Obs.: ' + r.obsSalida : '') + '.' });
    }
    if (r.fechaIngreso && lleno(r.horaIngreso)) {
      const off = offsetDe(r.fechaIngreso, r.horaIngreso);
      if (dentro(off)) eventos.push({ key: 'vi:' + r.id, off: off, hi: hh(r.horaIngreso), hs: '', tipo: 'dato', origen: 'vehiculo',
        texto: 'Retorna ' + base + (r.kmLlegada !== '' && r.kmLlegada != null ? ', km. ' + r.kmLlegada : '') +
          (r.kmRecorridos !== '' && r.kmRecorridos != null ? ' (recorrió ' + r.kmRecorridos + ' km)' : '') + (r.obsIngreso ? '. Obs.: ' + r.obsIngreso : '') + '.' });
    }
  });

  // Supervisión
  if (supHora) {
    const off = offsetLibre(supHora);
    if (dentro(off)) eventos.push({ key: 'sup', off: off, hi: hh(supHora), hs: '', tipo: 'dato', origen: 'supervision', firma: true, texto: cfg.textoSupervision });
  }

  // Filas agregadas a mano desde el dashboard
  (ed.extras || []).forEach(x => {
    const ref = lleno(x.hi) ? x.hi : x.hs;
    if (!lleno(ref)) return;
    const off = offsetLibre(ref);
    if (dentro(off)) eventos.push({ key: 'x:' + x.id, off: off, hi: hh(x.hi), hs: hh(x.hs), tipo: x.tipo === 'sistema' ? 'sistema' : 'dato', origen: 'manual', texto: String(x.texto || '') });
  });

  // Ocultar eventos (las 12 horas nunca se ocultan) y aplicar textos editados
  eventos = eventos.filter(e => (ed.ocultas || []).indexOf(e.key) === -1);
  eventos.forEach(e => aplicarEdicion(e, ed));
  eventos.sort((a, b) => a.off - b.off);

  // ------------------------------------------------------------------ filas
  const horaTxt = i => pad2((T.ini + i) % 24) + ':00';
  const filas = [];
  for (let i = 0; i < 12; i++) {
    const delSlot = eventos.filter(e => e.off >= i * 60 && e.off < (i + 1) * 60);
    const ocupaHora = delSlot.some(e => e.off === i * 60);
    if (i === 0) {
      const f0 = { key: 'inicio', hi: horaTxt(0), hs: '', tipo: 'sistema', origen: 'inicio', texto: nowOff >= 0 ? fmt(cfg.textoInicio, { saliente: saliente.nombre }) : '' };
      aplicarEdicion(f0, ed); filas.push(f0);
    } else if (!ocupaHora) {
      const fh = { key: 'h:' + pad2((T.ini + i) % 24), hi: horaTxt(i), hs: '', tipo: 'sistema', origen: 'hora', texto: horaPasada(i) ? cfg.textoSinNovedad : '' };
      aplicarEdicion(fh, ed); filas.push(fh);
    }
    delSlot.forEach(e => filas.push({ key: e.key, hi: e.hi, hs: e.hs, tipo: e.tipo, origen: e.origen, texto: e.texto, firma: !!e.firma, editada: !!e.editada }));
  }
  const ff = { key: 'fin', hi: '', hs: horaTxt(12), tipo: 'sistema', origen: 'fin', texto: nowOff >= 720 ? fmt(cfg.textoFin, { entrante: entrante.nombre }) : '' };
  aplicarEdicion(ff, ed); filas.push(ff);

  const f = fecha.split('-');
  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  return {
    fecha: fecha, fechaTexto: f[2] + '-' + f[1] + '-' + f[0],
    diaSemana: dias[new Date(Number(f[0]), Number(f[1]) - 1, Number(f[2])).getDay()],
    turno: turno, turnoTexto: T.nombre, unidad: cfg.unidad, tituloEmpresa: cfg.tituloEmpresa, logoUrl: cfg.logoUrl,
    agente: actual.nombre, saliente: saliente, actual: actual, entrante: entrante,
    firmas: { agenteSaliente: actual, agenteEntrante: entrante,
              supervisor: { nombre: cfg.supervisorNombre, firmaUrl: cfg.firmaSupervisorUrl, hora: supHora } },
    limpiezaActiva: limpiezaActiva, supervisionHora: supHora, ediciones: ed, filas: filas
  };
}

function limpiarEdiciones(e) {
  let o = e;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (x) { o = {}; } }
  o = o && typeof o === 'object' ? o : {};
  const textos = {};
  Object.keys(o.textos || {}).slice(0, 300).forEach(k => {
    const v = o.textos[k] || {};
    const item = {};
    if (v.texto !== undefined && v.texto !== null) item.texto = String(v.texto).slice(0, 600);
    if (v.hi !== undefined && v.hi !== null) item.hi = String(v.hi).slice(0, 5);
    if (v.hs !== undefined && v.hs !== null) item.hs = String(v.hs).slice(0, 5);
    textos[String(k).slice(0, 60)] = item;
  });
  const extras = (Array.isArray(o.extras) ? o.extras : []).slice(0, 150).map(x => ({
    id: String(x.id || idUnico()).slice(0, 40), hi: String(x.hi || '').slice(0, 5), hs: String(x.hs || '').slice(0, 5),
    texto: String(x.texto || '').slice(0, 600), tipo: x.tipo === 'sistema' ? 'sistema' : 'dato' }));
  const ocultas = (Array.isArray(o.ocultas) ? o.ocultas : []).slice(0, 300).map(k => String(k).slice(0, 60));
  return { textos: textos, extras: extras, ocultas: ocultas };
}

function aplicarEdicion(fila, ed) {
  const v = (ed.textos || {})[fila.key];
  if (!v) return;
  if (v.texto !== undefined) { fila.texto = v.texto; fila.editada = true; }
  if (v.hi !== undefined) { fila.hi = v.hi; fila.editada = true; }
  if (v.hs !== undefined) { fila.hs = v.hs; fila.editada = true; }
}

/**
 * El conductor y los pasajeros que salen en un vehículo cuentan como SALIDA de personal
 * (y como INGRESO cuando el vehículo retorna). El motivo es el del control vehicular.
 * Son registros "virtuales": no se guardan en reg_personal.
 */
function derivarPersonal(viajes) {
  const lista = v => {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = v ? [v] : []; } }
    return (Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean);
  };
  const uniq = a => a.filter((n, i) => n && a.indexOf(n) === i);
  const out = [];
  (viajes || []).forEach(r => {
    if (!r || esTrue(r.eliminado)) return;
    const cond = String(r.conductor || '').trim();
    const ida = uniq([cond].concat(lista(r.pasajeros)));
    const ret = uniq([cond].concat(r.pasajerosRetorno === undefined || r.pasajerosRetorno === '' ? lista(r.pasajeros) : lista(r.pasajerosRetorno)));
    const motivo = String(r.motivo || r.destino || 'En vehículo').trim();
    if (r.fechaSalida && r.horaSalida) ida.forEach((n, i) => out.push({ id: 'dv_' + r.id + '_s_' + i, nombre: n, tipo: 'Salida', fecha: r.fechaSalida, hora: String(r.horaSalida).slice(0, 5),
      motivo: motivo, derivado: 'vehicular', viajeId: r.id, registradoPor: 'Control vehicular' }));
    if (r.fechaIngreso && r.horaIngreso) ret.forEach((n, i) => out.push({ id: 'dv_' + r.id + '_i_' + i, nombre: n, tipo: 'Ingreso', fecha: r.fechaIngreso, hora: String(r.horaIngreso).slice(0, 5),
      motivo: '', derivado: 'vehicular', viajeId: r.id, registradoPor: 'Control vehicular' }));
  });
  return out;
}

function pasajerosTxt(p) {
  let arr = p;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = [arr]; } }
  return Array.isArray(arr) && arr.length ? ', pasajeros: ' + arr.join(', ') : '';
}

// ============================================================================
//  SEGURIDAD
// ============================================================================
function hex(bytes) { return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); }
function hashClave(salt, clave) { return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + '::' + String(clave))); }
function firmar(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, PropertiesService.getScriptProperties().getProperty('SECRET')));
}
function crearToken(p) {
  const payload = [p.id, p.rol, Date.now() + CFG.TOKEN_DIAS * 86400000].join('~');
  return Utilities.base64EncodeWebSafe(payload) + '.' + firmar(payload);
}
function validarToken(token) {
  if (!token) return null;
  try {
    const partes = String(token).split('.');
    const payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[0])).getDataAsString();
    if (firmar(payload) !== partes[1]) return null;
    const x = payload.split('~');
    if (Number(x[2]) < Date.now()) return null;
    const p = leerTodo('Personas').find(q => q.id === x[0]);
    return p && esActivo(p) ? p : null;
  } catch (e) { return null; }
}
function pinCorrecto(pin) {
  const h = PropertiesService.getScriptProperties().getProperty('PIN_HASH');
  return !!pin && !!h && hashClave('pin', pin) === h;
}
function sinSecretos(p) { const o = Object.assign({}, p); delete o.salt; delete o.hash; return o; }

// ============================================================================
//  HOJAS (lectura / escritura genérica)
// ============================================================================
function hoja(nombre) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(nombre);
  if (!s) { s = ss.insertSheet(nombre); s.getRange(1, 1, s.getMaxRows(), s.getMaxColumns()).setNumberFormat('@'); }
  return s;
}
function nombresHojas() { return SpreadsheetApp.getActiveSpreadsheet().getSheets().map(s => s.getName()); }

function asegurarEncabezados(s, claves) {
  let enc = s.getLastColumn() ? s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].filter(String) : [];
  const faltan = claves.filter((k, i) => enc.indexOf(k) === -1 && claves.indexOf(k) === i);
  if (!faltan.length) return enc;
  const desde = enc.length + 1;
  if (s.getMaxColumns() < desde + faltan.length - 1) s.insertColumnsAfter(s.getMaxColumns(), desde + faltan.length - 1 - s.getMaxColumns());
  s.getRange(1, desde, s.getMaxRows(), faltan.length).setNumberFormat('@');
  s.getRange(1, desde, 1, faltan.length).setValues([faltan]).setFontWeight('bold');
  return enc.concat(faltan);
}

function leerTodo(nombre) {
  const s = hoja(nombre);
  if (s.getLastRow() < 2 || !s.getLastColumn()) return [];
  const v = s.getRange(1, 1, s.getLastRow(), s.getLastColumn()).getValues();
  const enc = v[0];
  return v.slice(1).filter(r => r.some(c => c !== '')).map(r => {
    const o = {};
    enc.forEach((k, i) => { o[k] = deserializar(k, r[i]); });
    return o;
  });
}

function upsert(nombre, obj, clave) {
  const s = hoja(nombre);
  const enc = asegurarEncabezados(s, (COLUMNAS[nombre] || []).concat(Object.keys(obj)));
  const total = s.getLastRow();
  const col = enc.indexOf(clave);
  let fila = -1, actual = {};
  if (total > 1) {
    const v = s.getRange(2, 1, total - 1, enc.length).getValues();
    for (let i = 0; i < v.length; i++) {
      if (String(v[i][col]) === String(obj[clave])) { fila = i + 2; enc.forEach((k, j) => { actual[k] = v[i][j]; }); break; }
    }
  }
  const final = Object.assign({}, actual, obj);
  const valores = enc.map(k => serializar(final[k]));
  const destino = fila > 0 ? fila : Math.max(total, 1) + 1;
  if (s.getMaxRows() < destino) s.insertRowsAfter(s.getMaxRows(), destino - s.getMaxRows());
  const rango = s.getRange(destino, 1, 1, enc.length);
  rango.setNumberFormat('@');
  rango.setValues([valores]);
}

function serializar(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function deserializar(k, v) {
  if (v === '' || v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd');
  const s = String(v);
  if (s.charAt(0) === '[' || s.charAt(0) === '{') { try { return JSON.parse(s); } catch (e) { return s; } }
  if (CLAVES_NUMERICAS.indexOf(k) !== -1 && !isNaN(Number(s))) return Number(s);
  return s;
}
function valorPlano(v) { return typeof v === 'object' ? JSON.stringify(v) : v; }
function esTrue(v) { return v === true || String(v).toLowerCase() === 'true'; }
function esActivo(p) { return String(p.activo).toLowerCase() !== 'false'; }
function limpiarModulo(m) {
  const x = String(m || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!x) throw new Error('Falta el módulo.');
  return x;
}

function leerConfig() {
  const c = Object.assign({}, CONFIG_DEFECTO);
  leerTodo('Config').forEach(f => { if (f.clave in CONFIG_DEFECTO) c[f.clave] = f.valor; });
  return c;
}
function registrarEdicion(user, modulo, id, cambios) {
  upsert('Ediciones', { fecha: ahora().texto, quien: user.nombre, modulo: modulo, id: id + '@' + Date.now(), cambios: cambios }, 'id');
}
function propiedad(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function tocar() { PropertiesService.getScriptProperties().setProperty('MOD', String(Date.now())); }

// ============================================================================
//  FECHAS (todas en la zona horaria CFG.TZ; la fecha del turno noche NO cambia a medianoche)
// ============================================================================
function ahora() {
  const t = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
  return { texto: t, fecha: t.slice(0, 10), hora: aMin(t.slice(11, 16)) };
}
function sumarDias(fecha, n) {
  const p = String(fecha).split('-');
  const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}
function aMin(hhmm) { const p = String(hhmm).split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); }
function pad2(n) { return ('0' + n).slice(-2); }
function idUnico() { return Date.now().toString(36) + Utilities.getUuid().slice(0, 6); }
