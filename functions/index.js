'use strict';

const crypto = require('crypto');
const {onRequest} = require('firebase-functions/v2/https');
const {onValueWritten} = require('firebase-functions/v2/database');
const {initializeApp} = require('firebase-admin/app');
const {getAuth} = require('firebase-admin/auth');
const {getDatabase} = require('firebase-admin/database');

const REGION = 'us-central1';
const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'baba-veteranos';
const DATABASE_URL = process.env.BOLAO_DATABASE_URL || `https://${PROJECT_ID}-default-rtdb.firebaseio.com`;
const DATABASE_INSTANCE = `${PROJECT_ID}-default-rtdb`;
const BOOTSTRAP_ADMIN_UID = process.env.BOLAO_BOOTSTRAP_ADMIN_UID || '38bRRVjvfnQwjp2HyMGq3ExLs2C3';
const LOCK_MS = 4 * 60 * 1000;

initializeApp({databaseURL: DATABASE_URL});
const db = getDatabase();
const auth = getAuth();
const ROOT = 'bolao';

function ref(path) {
  return db.ref(`${ROOT}/${path}`);
}
function assertId(value, label) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error(`${label} inválido.`);
  return id;
}
function entries(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.map((v, i) => [String(i), v]).filter((x) => x[1] && typeof x[1] === 'object');
  return Object.keys(value).map((key) => [key, value[key]]).filter((x) => x[1] && typeof x[1] === 'object');
}
function isIntScore(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}
function assertSchedule(startAt, endAt) {
  const start = Number(startAt);
  const end = Number(endAt);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    throw new Error('Período de palpites inválido.');
  }
  return {start, end};
}
function validateMatches(rawMatches) {
  if (!Array.isArray(rawMatches) || rawMatches.length < 1 || rawMatches.length > 100) {
    throw new Error('Cadastre de 1 a 100 partidas.');
  }
  const matches = {};
  rawMatches.forEach((match, index) => {
    const home = String((match && match.mandante) || '').trim();
    const away = String((match && match.visitante) || '').trim();
    if (!home || !away || home.length > 80 || away.length > 80) throw new Error('Nome de partida inválido.');
    const id = `partida_${index + 1}`;
    matches[id] = {id, mandante: home, visitante: away};
  });
  return matches;
}
function safeError(res, status, message) {
  res.status(status).json({error: {message}});
}
async function isAdmin(uid) {
  if (uid === BOOTSTRAP_ADMIN_UID) return true;
  const snap = await db.ref(`baba/roles/admins/${uid}`).get();
  return snap.val() === true;
}
function makeAudit(updates, scope, action, uid, details) {
  const eventId = db.ref().push().key;
  updates[`private/auditoria/${scope}/${eventId}`] = {
    action,
    actorUid: uid,
    occurredAt: Date.now(),
    ...(details || {})
  };
  return eventId;
}
async function withAdminLock(uid, work) {
  const lockRef = ref('private/adminLock');
  const operationId = crypto.randomUUID();
  const now = Date.now();
  const tx = await lockRef.transaction((current) => {
    if (current && Number(current.expiresAt) > now) return;
    return {operationId, actorUid: uid, expiresAt: now + LOCK_MS};
  }, undefined, false);
  if (!tx.committed) throw Object.assign(new Error('Outra operação administrativa está em andamento. Tente novamente.'), {status: 409});
  try {
    return await work(operationId);
  } finally {
    await lockRef.transaction((current) => current && current.operationId === operationId ? null : current, undefined, false);
  }
}
async function ensureParticipantToken(poolId, uid) {
  const pool = assertId(poolId, 'ID do Bolão');
  const user = assertId(uid, 'UID');
  const mapping = ref(`private/participantes/${pool}/${user}`);
  const candidate = {token: db.ref(`bolao/public/participantes/${pool}`).push().key, createdAt: Date.now()};
  const result = await mapping.transaction((current) => current || candidate, undefined, false);
  const value = result.snapshot.val();
  if (!value || typeof value.token !== 'string') throw new Error('Não foi possível preparar o identificador privado do participante.');
  return value.token;
}
function scoreMapsEqual(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => {
    const a = left[key];
    const b = right[rightKeys[index]];
    return key === rightKeys[index] && a && b && a.mandante === b.mandante && a.visitante === b.visitante;
  });
}
function checkPredictionRecord(record, round) {
  if (!record || typeof record !== 'object' || !record.palpites || typeof record.palpites !== 'object' || Array.isArray(record.palpites)) return false;
  if (Object.keys(record).length !== 2 || !Number.isSafeInteger(record.enviadoEm)) return false;
  const start = Number(round && round.inicioPalpites);
  const end = Number(round && round.fimPalpites);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || record.enviadoEm < start || record.enviadoEm > end) return false;
  const fixtures = entries(round && round.partidas);
  const guesses = record.palpites;
  if (!fixtures.length || Object.keys(guesses).length !== fixtures.length) return false;
  return fixtures.every(([key, fixture]) => {
    const matchId = String((fixture && fixture.id) || key);
    const score = guesses[matchId];
    return score && typeof score === 'object' && !Array.isArray(score) && Object.keys(score).length === 2 && isIntScore(score.mandante) && isIntScore(score.visitante);
  });
}

exports.recordValidBolaoParticipant = onValueWritten({
  ref: '/bolao/private/palpites/{uid}/{roundId}',
  instance: DATABASE_INSTANCE,
  region: REGION,
  retry: true
}, async (event) => {
  const after = event.data.after.val();
  if (!after) return;
  const {uid, roundId} = event.params;
  const roundSnap = await ref(`public/rodadas/${assertId(roundId, 'ID da rodada')}`).get();
  const round = roundSnap.val();
  if (!round || !round.bolaoId || !checkPredictionRecord(after, round)) return;
  const poolId = assertId(round.bolaoId, 'ID do Bolão');
  const token = await ensureParticipantToken(poolId, uid);
  await ref(`public/participantes/${poolId}/${token}`).set(true);
});

function scoreOutcome(home, away) {
  return home > away ? 1 : (home < away ? -1 : 0);
}
function scoreOnePrediction(prediction, official) {
  if (!prediction || !official) return 0;
  if (prediction.mandante === official.mandante && prediction.visitante === official.visitante) return 3;
  return scoreOutcome(prediction.mandante, prediction.visitante) === scoreOutcome(official.mandante, official.visitante) ? 1 : 0;
}
function cleanOfficialScores(round, rawScores) {
  const matches = entries(round.partidas);
  if (!matches.length || !rawScores || typeof rawScores !== 'object') throw new Error('A rodada não possui partidas válidas.');
  const cleaned = {};
  matches.forEach(([key, match]) => {
    const id = assertId((match && match.id) || key, 'ID da partida');
    const score = rawScores[id];
    if (!score || !isIntScore(score.mandante) || !isIntScore(score.visitante)) throw new Error('Informe gols inteiros e não negativos em todas as partidas.');
    cleaned[id] = {mandante: score.mandante, visitante: score.visitante};
  });
  if (Object.keys(rawScores).some((id) => !Object.prototype.hasOwnProperty.call(cleaned, id))) throw new Error('O resultado contém uma partida que não pertence à rodada.');
  return cleaned;
}
async function buildRankingAndReveals(poolId, rounds, results, predictions, overrideRoundId, overrideResult) {
  const ranking = {};
  const updates = {};
  const reveals = {};
  const eligibleRounds = entries(rounds).filter(([roundId, round]) => {
    if (!round || round.bolaoId !== poolId) return false;
    if (roundId === overrideRoundId) return Boolean(overrideResult && overrideResult.partidas);
    return round.resultadoRevelado === true && Boolean(results[roundId] && results[roundId].partidas);
  });
  for (const [roundId, round] of eligibleRounds) {
    const official = roundId === overrideRoundId ? overrideResult : results[roundId];
    const roundRecords = {};
    for (const uid of Object.keys(predictions || {})) {
      const userRound = predictions[uid] && predictions[uid][roundId];
      if (!userRound || !userRound.palpites || !checkPredictionRecord(userRound, round)) continue;
      const token = await ensureParticipantToken(poolId, uid);
      updates[`public/participantes/${poolId}/${token}`] = true;
      roundRecords[token] = {palpites: userRound.palpites};
      let points = 0;
      Object.keys(official.partidas).forEach((matchId) => {
        points += scoreOnePrediction(userRound.palpites[matchId], official.partidas[matchId]);
      });
      if (!ranking[token]) ranking[token] = {bolaoId: poolId, pontos: 0, rodadasPontuadas: 0};
      ranking[token].pontos += points;
      ranking[token].rodadasPontuadas += 1;
    }
    reveals[roundId] = roundRecords;
  }
  Object.keys(ranking).forEach((token) => { ranking[token].atualizadoEm = Date.now(); });
  Object.keys(reveals).forEach((roundId) => { updates[`public/revelados/${roundId}`] = reveals[roundId]; });
  updates['public/ranking'] = Object.keys(ranking).length ? ranking : null;
  return {ranking, reveals, updates};
}

async function adminAction(uid, action, payload) {
  return withAdminLock(uid, async () => {
    const updates = {};
    if (action === 'openPool') {
      const title = String(payload.title || '').trim();
      if (!title || title.length > 80) throw new Error('Informe um nome válido para o Bolão.');
      const poolId = assertId(`b_${db.ref('bolao/public/config').push().key}`, 'ID do Bolão');
      const previous = (await ref('public/config').get()).val() || null;
      updates['public/config/bolaoId'] = poolId;
      updates['public/config/titulo'] = title;
      updates['public/config/status'] = 'aberto';
      updates['public/config/rankingLiberado'] = false;
      updates['public/config/rankingLiberadoRodadaId'] = null;
      updates['public/config/abertoEm'] = Date.now();
      updates['public/ranking'] = null;
      makeAudit(updates, `boloes/${poolId}`, 'bolao_aberto', uid, {before: previous, after: {bolaoId: poolId, titulo: title}});
      await ref('').update(updates);
      return {bolaoId: poolId};
    }

    if (action === 'createRound') {
      const config = (await ref('public/config').get()).val();
      if (!config || !config.bolaoId || config.status !== 'aberto') throw new Error('Abra um Bolão antes de cadastrar rodadas.');
      const title = String(payload.title || '').trim();
      if (!title || title.length > 80) throw new Error('Informe um título válido.');
      const {start, end} = assertSchedule(payload.startAt, payload.endAt);
      const matches = validateMatches(payload.matches);
      const roundId = assertId(`r_${db.ref('bolao/public/rodadas').push().key}`, 'ID da rodada');
      const createdAt = Date.now();
      updates[`public/rodadas/${roundId}`] = {
        titulo: title, bolaoId: config.bolaoId, partidas: matches,
        inicioPalpites: start, fimPalpites: end, status: 'aberta',
        encerrada: false, resultadoRevelado: false, criadaEm: createdAt
      };
      makeAudit(updates, `rodadas/${roundId}`, 'rodada_criada', uid, {bolaoId: config.bolaoId, title});
      await ref('').update(updates);
      return {roundId};
    }

    if (action === 'updateSchedule') {
      const roundId = assertId(payload.roundId, 'ID da rodada');
      const round = (await ref(`public/rodadas/${roundId}`).get()).val();
      if (!round) throw new Error('A rodada não foi encontrada.');
      const result = (await ref(`private/resultados/${roundId}`).get()).val();
      if (result || round.resultadoRevelado === true || round.status !== 'aberta' || round.encerrada === true) throw new Error('Não é possível alterar o período de uma rodada em processamento, encerrada ou revelada.');
      const {start, end} = assertSchedule(payload.startAt, payload.endAt);
      updates[`public/rodadas/${roundId}/inicioPalpites`] = start;
      updates[`public/rodadas/${roundId}/fimPalpites`] = end;
      makeAudit(updates, `rodadas/${roundId}`, 'periodo_alterado', uid, {inicioPalpites: start, fimPalpites: end});
      await ref('').update(updates);
      return {roundId};
    }

    if (action === 'saveResult') {
      const roundId = assertId(payload.roundId, 'ID da rodada');
      const [roundSnap, configSnap, initialResultsSnap] = await Promise.all([
        ref(`public/rodadas/${roundId}`).get(), ref('public/config').get(),
        ref(`private/resultados/${roundId}`).get()
      ]);
      let round = roundSnap.val();
      const config = configSnap.val() || {};
      if (!round) throw new Error('A rodada não foi encontrada.');
      if (config.bolaoId !== round.bolaoId) throw new Error('Só é possível publicar resultados do Bolão ativo.');
      let oldResult = initialResultsSnap.val();
      const now = Date.now();
      if (!oldResult && (!Number.isSafeInteger(Number(round.fimPalpites)) || now <= Number(round.fimPalpites))) throw new Error('O resultado só pode ser registrado após o encerramento do período de palpites.');
      const scores = cleanOfficialScores(round, payload.scores);
      if (oldResult && scoreMapsEqual(oldResult.partidas, scores)) {
        return {roundId, closed: true, corrected: false, idempotent: true};
      }
      if (oldResult && (!payload.correction || String(payload.reason || '').trim().length < 8)) throw new Error('Para corrigir um resultado publicado, informe o motivo da correção.');

      if (!oldResult) {
        // Close the prediction window before taking the prediction snapshot. The
        // transaction is the barrier: a direct client write is either committed
        // before it (and included below) or rejected after it. A retry can resume
        // a stranded processing state after a transient function failure.
        const roundRef = ref(`public/rodadas/${roundId}`);
        const barrier = await roundRef.transaction((current) => {
          if (!current) return;
          if (current.status === 'processando' && current.processamentoResultado === true) return current;
          if (current.status !== 'aberta' || current.encerrada === true || current.resultadoRevelado === true) return;
          return {...current, status: 'processando', processamentoResultado: true};
        }, undefined, false);
        if (!barrier.committed) throw new Error('A rodada mudou de estado; atualize o painel antes de tentar novamente.');
        round = barrier.snapshot.val();
      }

      const [roundsSnap, resultsSnap, predictionsSnap] = await Promise.all([
        ref('public/rodadas').get(), ref('private/resultados').get(), ref('private/palpites').get()
      ]);
      const rounds = roundsSnap.val() || {};
      const results = resultsSnap.val() || {};
      const predictions = predictionsSnap.val() || {};
      oldResult = results[roundId] || null;
      if (oldResult && scoreMapsEqual(oldResult.partidas, scores)) {
        return {roundId, closed: true, corrected: false, idempotent: true};
      }
      if (oldResult && (!payload.correction || String(payload.reason || '').trim().length < 8)) throw new Error('Para corrigir um resultado publicado, informe o motivo da correção.');
      const result = {partidas: scores, atualizadoEm: now, atualizadoPor: uid};
      rounds[roundId] = {...round, status: 'encerrada', encerrada: true, resultadoRevelado: true, processamentoResultado: false, encerradaEm: round.encerradaEm || now};
      results[roundId] = result;
      const computed = await buildRankingAndReveals(config.bolaoId, rounds, results, predictions, roundId, result);
      Object.assign(updates, computed.updates);
      updates[`private/resultados/${roundId}`] = result;
      updates[`public/rodadas/${roundId}/status`] = 'encerrada';
      updates[`public/rodadas/${roundId}/encerrada`] = true;
      updates[`public/rodadas/${roundId}/encerradaEm`] = round.encerradaEm || now;
      updates[`public/rodadas/${roundId}/resultadoRevelado`] = true;
      updates[`public/rodadas/${roundId}/processamentoResultado`] = null;
      updates['public/config/rankingLiberado'] = true;
      updates['public/config/rankingLiberadoRodadaId'] = roundId;
      updates['public/config/rankingBolaoId'] = config.bolaoId;
      makeAudit(updates, `rodadas/${roundId}`, oldResult ? 'resultado_corrigido' : 'resultado_publicado', uid, {
        bolaoId: config.bolaoId, before: oldResult, after: result,
        reason: oldResult ? String(payload.reason).trim() : null
      });
      await ref('').update(updates);
      return {roundId, closed: true, corrected: Boolean(oldResult)};
    }

    if (action === 'closeRound') {
      const roundId = assertId(payload.roundId, 'ID da rodada');
      const [roundSnap, resultSnap, configSnap] = await Promise.all([
        ref(`public/rodadas/${roundId}`).get(), ref(`private/resultados/${roundId}`).get(), ref('public/config').get()
      ]);
      const round = roundSnap.val();
      const result = resultSnap.val();
      const config = configSnap.val() || {};
      if (!round || !result || !result.partidas || round.resultadoRevelado !== true) throw new Error('Não é permitido encerrar sem resultado oficial revelado.');
      if (round.bolaoId !== config.bolaoId) throw new Error('A rodada não pertence ao Bolão ativo.');
      if (round.status === 'encerrada' && round.encerrada === true) return {roundId, closed: true};
      const now = Date.now();
      updates[`public/rodadas/${roundId}/status`] = 'encerrada';
      updates[`public/rodadas/${roundId}/encerrada`] = true;
      updates[`public/rodadas/${roundId}/encerradaEm`] = now;
      updates['public/config/rankingLiberado'] = true;
      updates['public/config/rankingLiberadoRodadaId'] = roundId;
      updates['public/config/rankingBolaoId'] = config.bolaoId;
      makeAudit(updates, `rodadas/${roundId}`, 'rodada_encerrada', uid, {bolaoId: config.bolaoId, result});
      await ref('').update(updates);
      return {roundId, closed: true};
    }

    if (action === 'reopenRound') {
      const roundId = assertId(payload.roundId, 'ID da rodada');
      const reason = String(payload.reason || '').trim();
      if (reason.length < 8) throw new Error('Informe o motivo da reabertura.');
      const [roundSnap, resultSnap, configSnap] = await Promise.all([
        ref(`public/rodadas/${roundId}`).get(), ref(`private/resultados/${roundId}`).get(), ref('public/config').get()
      ]);
      const round = roundSnap.val();
      const config = configSnap.val() || {};
      if (!round || round.bolaoId !== config.bolaoId) throw new Error('A rodada não pertence ao Bolão ativo.');
      if (resultSnap.exists() || round.resultadoRevelado === true) throw new Error('Uma rodada já revelada não pode ser reaberta; use a correção auditada do resultado.');
      if (round.status !== 'encerrada' && round.encerrada !== true) throw new Error('A rodada não está encerrada.');
      const schedule = assertSchedule(payload.startAt, payload.endAt);
      if (schedule.start < Date.now()) throw new Error('O novo período deve começar no futuro.');
      updates[`public/rodadas/${roundId}/status`] = 'aberta';
      updates[`public/rodadas/${roundId}/encerrada`] = false;
      updates[`public/rodadas/${roundId}/encerradaEm`] = null;
      updates[`public/rodadas/${roundId}/inicioPalpites`] = schedule.start;
      updates[`public/rodadas/${roundId}/fimPalpites`] = schedule.end;
      makeAudit(updates, `rodadas/${roundId}`, 'rodada_reaberta', uid, {
        bolaoId: config.bolaoId,
        before: {status: round.status, inicioPalpites: round.inicioPalpites, fimPalpites: round.fimPalpites},
        after: {status: 'aberta', inicioPalpites: schedule.start, fimPalpites: schedule.end},
        reason
      });
      await ref('').update(updates);
      return {roundId, reopened: true};
    }

    throw new Error('Operação administrativa desconhecida.');
  });
}

exports.bolaoAdminAction = onRequest({
  region: REGION,
  timeoutSeconds: 120,
  memory: '512MiB',
  maxInstances: 1,
  concurrency: 1,
  cors: ['https://veteranosbaba-commits.github.io', 'http://localhost:5000', 'http://127.0.0.1:5000']
}, async (req, res) => {
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return safeError(res, 405, 'Método não permitido.');
  try {
    const authHeader = String(req.get('authorization') || '');
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return safeError(res, 401, 'Autenticação obrigatória.');
    const decoded = await auth.verifyIdToken(token);
    if (!await isAdmin(decoded.uid)) return safeError(res, 403, 'Acesso exclusivo para administradores.');
    const body = req.body && req.body.data ? req.body.data : req.body;
    const action = String((body && body.action) || '');
    const payload = body && body.payload && typeof body.payload === 'object' ? body.payload : {};
    const result = await adminAction(decoded.uid, action, payload);
    return res.status(200).json({result});
  } catch (error) {
    const status = Number(error && error.status) || (error && error.code === 'auth/id-token-expired' ? 401 : 400);
    return safeError(res, status, (error && error.message) || 'Falha na operação do Bolão.');
  }
});
