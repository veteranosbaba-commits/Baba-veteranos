/* Dados e tela pública isolados do Bolão. Não altera módulos existentes. */
(function () {
    'use strict';

    var ROOT = 'public/bolao';
    var PRIVATE_PREDICTIONS = 'private/bolao/palpites';
    var PRIVATE_RESULTS = 'private/bolao/resultados';
    var PUBLIC_PARTICIPANTS = ROOT + '/participantes';
    var PATHS = Object.freeze({
        config: ROOT + '/config',
        rodadas: ROOT + '/rodadas',
        ranking: ROOT + '/ranking',
        participantes: PUBLIC_PARTICIPANTS,
        palpites: PRIVATE_PREDICTIONS,
        resultados: PRIVATE_RESULTS
    });
    var activeListeners = new Set();
    var view = {config: null, rodadas: null, participantes: null, ranking: null, palpitesRevelados: {}, erro: ''};
    var participantsUnsubscribe = null;
    var rankingUnsubscribe = null;
    var revealedLoads = Object.create(null);
    var publicLoadGeneration = 0;
    var newBolaoFormBound = false;
    var viewListenersStarted = false;
    var viewUnsubscribers = [];
    var authUnsubscribe = null;
    var bolaoTabObserver = null;
    var bolaoAdminTabObserver = null;
    var adminView = {config: null, rodadas: null, resultados: null, erro: ''};
    var adminListenersStarted = false;
    var adminUnsubscribers = [];

    function getBabaRef() {
        if (window.dbRef && typeof window.dbRef.child === 'function') return window.dbRef;
        if (window.firebase && window.firebase.apps && window.firebase.apps.length) {
            return window.firebase.database().ref('baba');
        }
        throw new Error('O Firebase do app ainda não foi inicializado.');
    }

    function getRef(path) {
        return getBabaRef().child(path);
    }

    function currentUser() {
        return (window.authRef && window.authRef.currentUser) || window.firebaseUser || null;
    }

    function requireVerifiedUser() {
        var user = currentUser();
        if (!user || user.emailVerified !== true) {
            throw new Error('Entre com uma conta e confirme o e-mail para registrar um palpite.');
        }
        return user;
    }

    function assertAdminWrite() {
        if (!currentUser() || !window.isAdminLogado) {
            throw new Error('Somente um administrador autenticado pode alterar os dados do Bolão.');
        }
    }

    function assertObject(value, label) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new TypeError(label + ' deve ser um objeto.');
        }
        return value;
    }

    function assertKey(value, label) {
        var key = String(value || '');
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new TypeError(label + ' inválido.');
        return key;
    }

    async function readPath(path) {
        var snapshot = await getRef(path).once('value');
        return snapshot.exists() ? snapshot.val() : null;
    }

    async function writePath(path, value, mode) {
        assertAdminWrite();
        var object = assertObject(value, 'Os dados');
        var ref = getRef(path);
        if (mode === 'update') await ref.update(object);
        else await ref.set(object);
        return true;
    }

    function listenPath(path, callback, onError) {
        if (typeof callback !== 'function') throw new TypeError('O callback de leitura é obrigatório.');
        var ref = getRef(path);
        var valueHandler = function (snapshot) {
            callback(snapshot.exists() ? snapshot.val() : null, snapshot.numChildren());
        };
        var errorHandler = function (error) {
            if (typeof onError === 'function') onError(error);
            else console.error('Falha no listener do Bolão.', (error && error.code) || '');
        };
        ref.on('value', valueHandler, errorHandler);
        var entry = {ref: ref, valueHandler: valueHandler};
        activeListeners.add(entry);
        var stopped = false;
        return function () {
            if (stopped) return;
            stopped = true;
            ref.off('value', valueHandler);
            activeListeners.delete(entry);
        };
    }

    function validatePredictions(value, matches) {
        var guesses = assertObject(value, 'Os palpites');
        var ids = Object.keys(guesses);
        var expectedIds = toEntries(matches).map(function (entry) { return String((entry[1] && entry[1].id) || entry[0]); });
        if (!expectedIds.length || ids.length !== expectedIds.length || expectedIds.some(function (id) { return !Object.prototype.hasOwnProperty.call(guesses, id); })) {
            throw new TypeError('Registre um palpite válido para cada partida da rodada.');
        }
        ids.forEach(function (id) {
            assertKey(id, 'ID da partida');
            if (expectedIds.indexOf(id) === -1) throw new TypeError('O palpite contém uma partida que não pertence a esta rodada.');
            var score = assertObject(guesses[id], 'O placar previsto');
            ['mandante', 'visitante'].forEach(function (side) {
                if (!Number.isInteger(score[side]) || score[side] < 0) {
                    throw new TypeError('Informe gols inteiros iguais ou maiores que zero.');
                }
            });
        });
        return guesses;
    }

    async function savePrediction(roundId, guesses) {
        var user = requireVerifiedUser();
        var rid = assertKey(roundId, 'ID da rodada');
        var round = await readPath(PATHS.rodadas + '/' + rid);
        var config = await readPath(PATHS.config);
        var cleanGuesses = validatePredictions(guesses, round && round.partidas);
        var now = Date.now();
        if (!round || !config || !config.bolaoId || round.bolaoId !== config.bolaoId || round.status !== 'aberta' || round.encerrada === true || round.resultadoRevelado === true || !Number.isFinite(Number(round.inicioPalpites)) || !Number.isFinite(Number(round.fimPalpites)) || now < Number(round.inicioPalpites) || now > Number(round.fimPalpites)) {
            throw new TypeError('Os palpites desta rodada ainda não estão abertos ou o prazo terminou.');
        }
        var bolaoId = assertKey(round.bolaoId, 'ID do Bolão');
        var updates = {};
        updates[PRIVATE_PREDICTIONS + '/' + user.uid + '/' + rid] = {
            palpites: cleanGuesses,
            enviadoEm: window.firebase.database.ServerValue.TIMESTAMP
        };
        updates[PUBLIC_PARTICIPANTS + '/' + bolaoId + '/' + assertKey(user.uid, 'UID')] = true;
        await getBabaRef().update(updates);
        return true;
    }

    function toEntries(value) {
        if (Array.isArray(value)) {
            return value.map(function (item, index) {
                return [String((item && item.id) || index), item];
            }).filter(function (item) { return item[1] && typeof item[1] === 'object'; });
        }
        if (value && typeof value === 'object') return Object.entries(value);
        return [];
    }

    function makeText(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        el.textContent = text;
        return el;
    }

    var participantsBolaoId = '';

    function syncParticipantsListener(config) {
        var nextId = config && config.bolaoId ? String(config.bolaoId) : '';
        if (nextId === participantsBolaoId) return;
        if (participantsUnsubscribe) { participantsUnsubscribe(); participantsUnsubscribe = null; }
        participantsBolaoId = nextId;
        view.participantes = null;
        view.palpitesRevelados = {};
        revealedLoads = Object.create(null);
        publicLoadGeneration += 1;
        if (!nextId) return;
        participantsUnsubscribe = listenPath(PUBLIC_PARTICIPANTS + '/' + assertKey(nextId, 'ID do Bolão'), function (value) {
            view.participantes = value || {};
            loadRevealedPredictions();
            renderBolao();
        }, function () { view.erro = 'Não foi possível carregar a quantidade de participantes.'; renderBolao(); });
    }

    function syncRankingListener(config) {
        var canRead = Boolean(config && config.bolaoId && config.rankingLiberado === true);
        if (!canRead) {
            if (rankingUnsubscribe) { rankingUnsubscribe(); rankingUnsubscribe = null; }
            view.ranking = null;
            return;
        }
        if (rankingUnsubscribe) return;
        rankingUnsubscribe = listenPath(PATHS.ranking, function (value) { view.ranking = value || {}; renderBolao(); }, function () { view.ranking = null; renderBolao(); });
    }

    function loadRevealedPredictions() {
        var config = view.config || {};
        var bolaoId = config.bolaoId;
        var participants = view.participantes || {};
        if (!bolaoId || !view.rodadas || !Object.keys(participants).length) return;
        var generation = publicLoadGeneration;
        toEntries(view.rodadas).forEach(function (roundEntry) {
            var roundId = roundEntry[0];
            var round = roundEntry[1] || {};
            if (round.bolaoId !== bolaoId || round.resultadoRevelado !== true) return;
            if (!view.palpitesRevelados[roundId]) view.palpitesRevelados[roundId] = {};
            Object.keys(participants).forEach(function (uid) {
                var key = roundId + '|' + uid;
                if (revealedLoads[key]) return;
                revealedLoads[key] = true;
                readPath(PATHS.palpites + '/' + assertKey(uid, 'UID') + '/' + assertKey(roundId, 'ID da rodada')).then(function (record) {
                    if (generation !== publicLoadGeneration || !record) return;
                    view.palpitesRevelados[roundId][uid] = record;
                    renderBolao();
                }).catch(function () {
                    delete revealedLoads[key];
                });
            });
        });
    }

    function participantLabel(uid) {
        var hash = 2166136261;
        for (var i = 0; i < uid.length; i += 1) {
            hash ^= uid.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return 'Participante ' + ('000000' + (hash >>> 0).toString(16)).slice(-6).toUpperCase();
    }

    function appendRevealedPredictions(card, roundId, round) {
        if (round.resultadoRevelado !== true) return;
        var guesses = view.palpitesRevelados[roundId];
        card.appendChild(makeText('h4', 'border-t border-stone-800 pt-3 text-xs font-black uppercase text-amber-200', 'Palpites revelados'));
        if (!guesses) {
            card.appendChild(makeText('p', 'text-xs text-stone-400', 'Carregando palpites revelados…'));
            return;
        }
        var ids = Object.keys(guesses).filter(function (uid) { return guesses[uid] && guesses[uid].palpites; }).sort();
        if (!ids.length) {
            card.appendChild(makeText('p', 'text-xs text-stone-400', 'Nenhum palpite registrado nesta rodada.'));
            return;
        }
        var matches = toEntries(round.partidas);
        ids.forEach(function (uid) {
            var participant = makeText('div', 'rounded-xl border border-stone-800 bg-stone-950/60 p-3 space-y-2', '');
            participant.appendChild(makeText('p', 'text-xs font-black text-stone-200', participantLabel(uid)));
            matches.forEach(function (entry) {
                var matchId = String((entry[1] && entry[1].id) || entry[0]);
                var match = entry[1] || {};
                var score = guesses[uid].palpites[matchId];
                if (!score) return;
                participant.appendChild(makeText('p', 'text-[11px] text-stone-300', String(match.mandante || 'Mandante') + ' ' + score.mandante + ' × ' + score.visitante + ' ' + String(match.visitante || 'Visitante')));
            });
            card.appendChild(participant);
        });
    }

    function renderPublicRanking() {
        var host = document.getElementById('bolao-ranking-publico');
        if (!host) return;
        host.replaceChildren();
        if (!view.config || view.config.rankingLiberado !== true) return;
        host.appendChild(makeText('h3', 'mb-2 text-xs font-black uppercase tracking-wide text-amber-200', 'Ranking do Bolão'));
        var entries = Object.keys(view.ranking || {}).map(function (uid) { return {uid: uid, record: view.ranking[uid] || {}}; });
        entries.sort(function (a, b) { return Number(b.record.pontos || 0) - Number(a.record.pontos || 0) || a.uid.localeCompare(b.uid); });
        if (!entries.length) {
            host.appendChild(makeText('p', 'text-xs text-stone-400', 'Ainda não há pontuação computada.'));
            return;
        }
        var position = 0; var lastPoints = null;
        entries.forEach(function (entry, index) {
            var points = Number(entry.record.pontos || 0);
            if (lastPoints === null || points !== lastPoints) position = index + 1;
            lastPoints = points;
            var label = participantLabel(entry.uid);
            var row = makeText('div', 'flex items-center justify-between gap-3 border-b border-stone-800 py-2 text-xs', '');
            row.appendChild(makeText('span', 'font-bold text-stone-200', position + 'º · ' + label));
            row.appendChild(makeText('span', 'font-black text-emerald-300', points + ' pts'));
            host.appendChild(row);
        });
    }

    function renderBolao() {
        var host = document.getElementById('bolao-rodadas-lista');
        var count = document.getElementById('bolao-participantes-count');
        var loginPrompt = document.getElementById('bolao-login-prompt');
        var status = document.getElementById('bolao-status');
        var adminButton = document.getElementById('bolao-admin-open');
        var poolTitle = document.getElementById('bolao-titulo-atual');
        if (poolTitle) poolTitle.textContent = view.config && view.config.titulo ? String(view.config.titulo) : '';
        if (adminButton) adminButton.classList.toggle('hidden', !window.isAdminLogado);
        if (!host || !count) return;

        count.textContent = String(Object.keys(view.participantes || {}).length);
        var user = currentUser();
        var podePalpitar = Boolean(user && user.emailVerified === true);
        if (loginPrompt) loginPrompt.classList.toggle('hidden', podePalpitar);
        host.replaceChildren();

        if (view.erro) {
            view.ranking = null;
            renderPublicRanking();
            host.appendChild(makeText('p', 'rounded-xl border border-red-800 bg-red-950/40 p-3 text-sm text-red-200', view.erro));
            return;
        }

        var activeBolaoId = view.config && view.config.bolaoId;
        if (!activeBolaoId) {
            host.appendChild(makeText('p', 'rounded-xl border border-stone-700 bg-stone-900 p-4 text-sm text-stone-300', 'Ainda não há um Bolão aberto.'));
            renderPublicRanking();
            return;
        }
        var rounds = toEntries(view.rodadas).filter(function (entry) { return entry[1] && entry[1].bolaoId === activeBolaoId; });
        if (!rounds.length) {
            host.appendChild(makeText('p', 'rounded-xl border border-stone-700 bg-stone-900 p-4 text-sm text-stone-300', 'Ainda não há rodadas cadastradas para este Bolão.'));
            renderPublicRanking();
            return;
        }

        rounds.forEach(function (roundEntry) {
            var roundId = roundEntry[0];
            var round = roundEntry[1] || {};
            var card = makeText('section', 'rounded-2xl border border-stone-700 bg-stone-900 p-4 space-y-4', '');
            var title = makeText('h3', 'font-black text-emerald-300 uppercase tracking-wide', String(round.titulo || round.nome || ('Rodada ' + roundId)));
            card.appendChild(title);

            var matches = toEntries(round.partidas);
            if (!matches.length) {
                card.appendChild(makeText('p', 'text-sm text-stone-400', 'Esta rodada ainda não tem partidas cadastradas.'));
                host.appendChild(card);
                return;
            }

            var now = Date.now();
            var startAt = Number(round.inicioPalpites);
            var endAt = Number(round.fimPalpites);
            var windowOpen = round.status === 'aberta' && round.encerrada !== true && round.resultadoRevelado !== true && Number.isFinite(startAt) && Number.isFinite(endAt) && now >= startAt && now <= endAt;
            if (round.resultadoRevelado === true) {
                card.appendChild(makeText('p', 'text-xs text-amber-200', 'Palpites liberados após o resultado oficial.'));
            } else if (!windowOpen) {
                card.appendChild(makeText('p', 'text-xs text-stone-400', 'O período para registrar palpites está fechado.'));
            } else {
                var form = document.createElement('form');
                form.className = 'space-y-3';
            matches.forEach(function (matchEntry) {
                var matchId = String((matchEntry[1] && matchEntry[1].id) || matchEntry[0]);
                var match = matchEntry[1] || {};
                var row = makeText('div', 'rounded-xl border border-stone-800 bg-stone-950/70 p-3', '');
                var teams = makeText('p', 'mb-3 text-xs font-bold text-stone-200', String(match.mandante || match.casa || 'Mandante') + ' × ' + String(match.visitante || match.fora || 'Visitante'));
                row.appendChild(teams);
                var fields = makeText('div', 'grid grid-cols-[1fr_auto_1fr] items-center gap-2', '');
                [['mandante', 'Gols do mandante'], ['visitante', 'Gols do visitante']].forEach(function (sideInfo, index) {
                    var input = document.createElement('input');
                    input.type = 'number';
                    input.min = '0';
                    input.step = '1';
                    input.required = true;
                    input.inputMode = 'numeric';
                    input.dataset.matchId = matchId;
                    input.dataset.side = sideInfo[0];
                    input.setAttribute('aria-label', sideInfo[1]);
                    input.className = 'w-full rounded-lg border border-stone-700 bg-stone-800 p-2 text-center text-white';
                    if (index === 0) fields.appendChild(input);
                    else {
                        fields.appendChild(makeText('span', 'text-center text-stone-500', '—'));
                        fields.appendChild(input);
                    }
                });
                row.appendChild(fields);
                form.appendChild(row);
            });

            var submit = makeText('button', 'w-full rounded-xl bg-emerald-600 px-4 py-3 text-xs font-black uppercase text-white disabled:opacity-50', 'Registrar palpite');
            submit.type = 'submit';
            submit.disabled = !podePalpitar;
            form.appendChild(submit);
            form.addEventListener('submit', async function (event) {
                event.preventDefault();
                if (status) status.textContent = '';
                try {
                    var guesses = {};
                    form.querySelectorAll('input[data-match-id]').forEach(function (input) {
                        var matchId = input.dataset.matchId;
                        if (!guesses[matchId]) guesses[matchId] = {};
                        guesses[matchId][input.dataset.side] = Number(input.value);
                    });
                    await savePrediction(roundId, guesses);
                    form.reset();
                    if (status) status.textContent = 'Palpite registrado.';
                } catch (error) {
                    if (status) status.textContent = error instanceof TypeError ? error.message : 'Não foi possível registrar o palpite.';
                }
            });
                card.appendChild(form);
            }
            appendRevealedPredictions(card, roundId, round);
            host.appendChild(card);
        });
        renderPublicRanking();
    }

    function numericTimestamp(value, label) {
        var timestamp = Number(value);
        if (!Number.isFinite(timestamp)) throw new TypeError(label + ' inválido.');
        return timestamp;
    }

    function validateSchedule(startAt, endAt) {
        var start = numericTimestamp(startAt, 'Início dos palpites');
        var end = numericTimestamp(endAt, 'Fim dos palpites');
        if (end <= start) throw new TypeError('O fim dos palpites deve ser posterior ao início.');
        return {startAt: start, endAt: end};
    }

    function validateMatches(matches) {
        if (!Array.isArray(matches) || !matches.length) throw new TypeError('Cadastre pelo menos uma partida.');
        var result = {};
        matches.forEach(function (match, index) {
            var mandante = String((match && match.mandante) || '').trim();
            var visitante = String((match && match.visitante) || '').trim();
            if (!mandante || !visitante) throw new TypeError('Preencha os dois times de cada partida.');
            var id = 'partida_' + (index + 1);
            result[id] = {id: id, mandante: mandante, visitante: visitante};
        });
        return result;
    }

    async function adminOpenBolao(titulo) {
        assertAdminWrite();
        var name = String(titulo || '').trim();
        if (!name) throw new TypeError('Informe o nome do novo Bolão.');
        var suffix = window.crypto && typeof window.crypto.randomUUID === 'function'
            ? window.crypto.randomUUID().replace(/-/g, '')
            : (Date.now() + '_' + Math.floor(Math.random() * 1000000));
        var bolaoId = assertKey('b_' + suffix, 'ID do Bolão');
        var updates = {};
        updates[PATHS.config + '/bolaoId'] = bolaoId;
        updates[PATHS.config + '/titulo'] = name;
        updates[PATHS.config + '/status'] = 'aberto';
        updates[PATHS.config + '/rankingLiberado'] = false;
        updates[PATHS.config + '/abertoEm'] = window.firebase.database.ServerValue.TIMESTAMP;
        updates[PATHS.ranking] = null;
        await getBabaRef().update(updates);
        return bolaoId;
    }

    async function adminCreateRound(input) {
        assertAdminWrite();
        var title = String((input && input.titulo) || '').trim();
        if (!title) throw new TypeError('Informe o nome da rodada.');
        var config = await readPath(PATHS.config);
        if (!config || !config.bolaoId || config.status !== 'aberto') throw new TypeError('Abra um novo Bolão antes de cadastrar rodadas.');
        var bolaoId = assertKey(config.bolaoId, 'ID do Bolão');
        var schedule = validateSchedule(input.inicioPalpites, input.fimPalpites);
        var matches = validateMatches(input.partidas);
        var suffix = window.crypto && typeof window.crypto.randomUUID === 'function'
            ? window.crypto.randomUUID().replace(/-/g, '')
            : (Date.now() + '_' + Math.floor(Math.random() * 1000000));
        var roundId = assertKey('r_' + suffix, 'ID da rodada');
        await getRef(PATHS.rodadas + '/' + roundId).set({
            titulo: title,
            bolaoId: bolaoId,
            partidas: matches,
            inicioPalpites: schedule.startAt,
            fimPalpites: schedule.endAt,
            status: 'aberta',
            encerrada: false,
            resultadoRevelado: false,
            criadaEm: window.firebase.database.ServerValue.TIMESTAMP
        });
        return roundId;
    }

    async function adminUpdateSchedule(roundId, startAt, endAt) {
        assertAdminWrite();
        var rid = assertKey(roundId, 'ID da rodada');
        var existing = await readPath(PATHS.rodadas + '/' + rid);
        if (!existing) throw new TypeError('A rodada não foi encontrada.');
        if (existing.encerrada === true || existing.status === 'encerrada' || existing.resultadoRevelado === true) throw new TypeError('O período desta rodada não pode mais ser alterado.');
        var schedule = validateSchedule(startAt, endAt);
        await getRef(PATHS.rodadas + '/' + rid).update({inicioPalpites: schedule.startAt, fimPalpites: schedule.endAt});
        return true;
    }

    function scoreOutcome(home, away) {
        return home > away ? 1 : (home < away ? -1 : 0);
    }

    function scoreOnePrediction(prediction, official) {
        if (!prediction || !official) return 0;
        if (prediction.mandante === official.mandante && prediction.visitante === official.visitante) return 3;
        return scoreOutcome(prediction.mandante, prediction.visitante) === scoreOutcome(official.mandante, official.visitante) ? 1 : 0;
    }

    async function buildCurrentRanking(bolaoId, resultOverride, revealRoundId) {
        var data = await Promise.all([
            readPath(PATHS.rodadas),
            readPath(PATHS.resultados),
            readPath(PATHS.palpites)
        ]);
        var rounds = data[0] || {};
        var results = data[1] || {};
        var predictions = data[2] || {};
        var ranking = {};
        toEntries(rounds).forEach(function (roundEntry) {
            var roundId = roundEntry[0];
            var round = roundEntry[1] || {};
            if (round.bolaoId !== bolaoId) return;
            if (round.resultadoRevelado !== true && roundId !== revealRoundId) return;
            var official = (resultOverride && resultOverride[roundId]) || results[roundId];
            if (!official || !official.partidas) return;
            Object.keys(predictions).forEach(function (uid) {
                var userRound = predictions[uid] && predictions[uid][roundId];
                if (!userRound || !userRound.palpites) return;
                var points = 0;
                Object.keys(official.partidas).forEach(function (matchId) {
                    points += scoreOnePrediction(userRound.palpites[matchId], official.partidas[matchId]);
                });
                if (!ranking[uid]) ranking[uid] = {bolaoId: bolaoId, pontos: 0, rodadasPontuadas: 0};
                ranking[uid].pontos += points;
                ranking[uid].rodadasPontuadas += 1;
            });
        });
        Object.keys(ranking).forEach(function (uid) {
            ranking[uid].atualizadoEm = window.firebase.database.ServerValue.TIMESTAMP;
        });
        return ranking;
    }

    async function adminSaveOfficialResult(roundId, scores) {
        assertAdminWrite();
        var rid = assertKey(roundId, 'ID da rodada');
        var round = await readPath(PATHS.rodadas + '/' + rid);
        if (!round) throw new TypeError('A rodada não foi encontrada.');
        var matches = toEntries(round.partidas);
        if (!matches.length) throw new TypeError('A rodada não tem partidas cadastradas.');
        var cleanScores = {};
        matches.forEach(function (entry) {
            var matchId = assertKey((entry[1] && entry[1].id) || entry[0], 'ID da partida');
            var score = scores && scores[matchId];
            if (!score || !Number.isInteger(score.mandante) || score.mandante < 0 || !Number.isInteger(score.visitante) || score.visitante < 0) {
                throw new TypeError('Preencha o resultado oficial de todas as partidas.');
            }
            cleanScores[matchId] = {mandante: score.mandante, visitante: score.visitante};
        });
        var resultRecord = {partidas: cleanScores, atualizadoEm: window.firebase.database.ServerValue.TIMESTAMP};
        var config = await readPath(PATHS.config);
        var activePool = Boolean(config && config.bolaoId && config.bolaoId === round.bolaoId);
        var lockAndHide = {};
        lockAndHide[PATHS.resultados + '/' + rid] = resultRecord;
        lockAndHide[PATHS.rodadas + '/' + rid + '/resultadoRevelado'] = false;
        if (activePool) lockAndHide[PATHS.config + '/rankingLiberado'] = false;
        await getBabaRef().update(lockAndHide);

        var publish = {};
        publish[PATHS.rodadas + '/' + rid + '/resultadoRevelado'] = true;
        if (activePool) {
            var updatedRanking = await buildCurrentRanking(config.bolaoId, null, rid);
            publish[PATHS.ranking] = Object.keys(updatedRanking).length ? updatedRanking : null;
            publish[PATHS.config + '/rankingLiberado'] = true;
        }
        await getBabaRef().update(publish);
        return true;
    }

    async function adminCloseRound(roundId) {
        assertAdminWrite();
        var rid = assertKey(roundId, 'ID da rodada');
        var existing = await readPath(PATHS.rodadas + '/' + rid);
        if (!existing) throw new TypeError('A rodada não foi encontrada.');
        var official = await readPath(PATHS.resultados + '/' + rid);
        var roundMatches = toEntries(existing.partidas);
        if (existing.resultadoRevelado !== true || !official || !official.partidas || !roundMatches.length || roundMatches.some(function (entry) {
            var matchId = String((entry[1] && entry[1].id) || entry[0]);
            var score = official.partidas[matchId];
            return !score || !Number.isInteger(score.mandante) || score.mandante < 0 || !Number.isInteger(score.visitante) || score.visitante < 0;
        })) throw new TypeError('Não é possível encerrar sem resultado oficial completo e revelado.');
        if (existing.encerrada === true || existing.status === 'encerrada') return true;
        var updates = {};
        updates[PATHS.rodadas + '/' + rid + '/status'] = 'encerrada';
        updates[PATHS.rodadas + '/' + rid + '/encerrada'] = true;
        updates[PATHS.rodadas + '/' + rid + '/encerradaEm'] = window.firebase.database.ServerValue.TIMESTAMP;
        await getBabaRef().update(updates);
        return true;
    }

    function localDateTimeInput(value) {
        var date = new Date(Number(value));
        if (!Number.isFinite(date.getTime())) return '';
        function pad(part) { return String(part).padStart(2, '0'); }
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function labelledInput(labelText, type, value, className) {
        var label = makeText('label', 'block space-y-1 text-xs font-bold text-stone-300', '');
        label.appendChild(makeText('span', 'block', labelText));
        var input = document.createElement('input');
        input.type = type;
        input.value = value === undefined || value === null ? '' : String(value);
        input.required = true;
        input.className = className || 'w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-white';
        label.appendChild(input);
        return {label: label, input: input};
    }

    function setAdminStatus(message, isError) {
        var status = document.getElementById('bolao-admin-status');
        if (!status) return;
        status.textContent = message || '';
        status.className = 'min-h-5 text-xs ' + (isError ? 'text-red-300' : 'text-emerald-300');
    }

    var newMatchCounter = 0;
    var adminFormBound = false;
    function addNewMatchRow() {
        var container = document.getElementById('bolao-admin-novas-partidas');
        if (!container) return;
        newMatchCounter += 1;
        var row = makeText('div', 'grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] items-center gap-2 rounded-xl border border-stone-800 bg-stone-950/60 p-3', '');
        row.dataset.newMatch = 'true';
        var home = document.createElement('input');
        home.type = 'text'; home.required = true; home.maxLength = 80; home.placeholder = 'Time mandante';
        home.className = 'min-w-0 rounded-lg border border-stone-700 bg-stone-800 px-3 py-2 text-sm text-white';
        home.dataset.mandante = 'true'; home.setAttribute('aria-label', 'Time mandante da partida ' + newMatchCounter);
        var divider = makeText('span', 'hidden sm:block text-center text-stone-500', '×');
        var away = document.createElement('input');
        away.type = 'text'; away.required = true; away.maxLength = 80; away.placeholder = 'Time visitante';
        away.className = 'min-w-0 rounded-lg border border-stone-700 bg-stone-800 px-3 py-2 text-sm text-white';
        away.dataset.visitante = 'true'; away.setAttribute('aria-label', 'Time visitante da partida ' + newMatchCounter);
        var remove = makeText('button', 'rounded-lg border border-red-900/60 px-3 py-2 text-xs font-bold text-red-300', 'Remover');
        remove.type = 'button'; remove.addEventListener('click', function () {
            if (container.querySelectorAll('[data-new-match]').length > 1) row.remove();
        });
        row.appendChild(home); row.appendChild(divider); row.appendChild(away); row.appendChild(remove);
        container.appendChild(row);
    }

    function bindNewBolaoForm() {
        var form = document.getElementById('bolao-admin-novo-bolao');
        if (!form || newBolaoFormBound) return;
        newBolaoFormBound = true;
        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            var input = document.getElementById('bolao-admin-nome-bolao');
            if (!input || !window.confirm('Abrir outro Bolão reinicia o ranking público atual. Continuar?')) return;
            try {
                var id = await adminOpenBolao(input.value);
                form.reset();
                setAdminStatus('Novo Bolão aberto; o ranking foi reiniciado. Código: ' + id, false);
                renderAdminPanel();
            } catch (error) {
                setAdminStatus(error instanceof TypeError ? error.message : 'Não foi possível abrir o novo Bolão.', true);
            }
        });
    }

    function bindAdminCreateForm() {
        var form = document.getElementById('bolao-admin-nova-rodada');
        var addButton = document.getElementById('bolao-admin-add-match');
        var container = document.getElementById('bolao-admin-novas-partidas');
        if (!form || !container || adminFormBound) return;
        adminFormBound = true;
        if (container.children.length === 0) addNewMatchRow();
        if (addButton) addButton.addEventListener('click', addNewMatchRow);
        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            setAdminStatus('', false);
            try {
                var rows = Array.from(container.querySelectorAll('[data-new-match]'));
                var matches = rows.map(function (row) {
                    return {
                        mandante: row.querySelector('[data-mandante]').value,
                        visitante: row.querySelector('[data-visitante]').value
                    };
                });
                var start = Date.parse(document.getElementById('bolao-admin-inicio-novo').value);
                var end = Date.parse(document.getElementById('bolao-admin-fim-novo').value);
                var id = await adminCreateRound({
                    titulo: document.getElementById('bolao-admin-titulo-novo').value,
                    inicioPalpites: start,
                    fimPalpites: end,
                    partidas: matches
                });
                form.reset();
                container.replaceChildren();
                newMatchCounter = 0;
                addNewMatchRow();
                setAdminStatus('Rodada aberta. Código interno: ' + id, false);
            } catch (error) {
                setAdminStatus(error instanceof TypeError ? error.message : 'Não foi possível abrir a rodada.', true);
            }
        });
    }

    function renderAdminRoundCard(roundId, round, savedResult) {
        var card = makeText('section', 'space-y-4 rounded-2xl border border-amber-800/50 bg-stone-900 p-4', '');
        var closed = round.encerrada === true || round.status === 'encerrada';
        card.appendChild(makeText('h3', 'text-sm font-black uppercase text-amber-300', String(round.titulo || round.nome || ('Rodada ' + roundId))));
        card.appendChild(makeText('p', 'text-[11px] text-stone-400', (closed ? 'Encerrada' : 'Aberta') + ' · ' + roundId));

        var scheduleForm = document.createElement('form');
        scheduleForm.className = 'grid grid-cols-1 gap-3 rounded-xl border border-stone-800 bg-stone-950/50 p-3 sm:grid-cols-2';
        var startField = labelledInput('Início dos palpites', 'datetime-local', localDateTimeInput(round.inicioPalpites));
        var endField = labelledInput('Fim dos palpites', 'datetime-local', localDateTimeInput(round.fimPalpites));
        scheduleForm.appendChild(startField.label); scheduleForm.appendChild(endField.label);
        var updateTimes = makeText('button', 'sm:col-span-2 rounded-lg bg-stone-700 px-3 py-2 text-xs font-black uppercase text-white disabled:opacity-50', 'Salvar período de palpites');
        updateTimes.type = 'submit'; updateTimes.disabled = closed;
        scheduleForm.appendChild(updateTimes);
        scheduleForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            try {
                await adminUpdateSchedule(roundId, Date.parse(startField.input.value), Date.parse(endField.input.value));
                setAdminStatus('Período de palpites atualizado.', false);
            } catch (error) {
                setAdminStatus(error instanceof TypeError ? error.message : 'Não foi possível atualizar o período.', true);
            }
        });
        card.appendChild(scheduleForm);

        var matches = toEntries(round.partidas);
        if (!matches.length) {
            card.appendChild(makeText('p', 'text-xs text-stone-400', 'Esta rodada não tem partidas cadastradas.'));
        } else {
            var resultForm = document.createElement('form');
            resultForm.className = 'space-y-3 rounded-xl border border-stone-800 bg-stone-950/50 p-3';
            resultForm.appendChild(makeText('h4', 'text-xs font-black uppercase text-stone-200', 'Resultado oficial (somente administração)'));
            var storedScores = (savedResult && savedResult.partidas) || {};
            matches.forEach(function (entry) {
                var matchId = String((entry[1] && entry[1].id) || entry[0]);
                var match = entry[1] || {};
                var score = storedScores[matchId] || {};
                var row = makeText('div', 'rounded-lg border border-stone-800 p-3', '');
                row.appendChild(makeText('p', 'mb-2 text-xs font-bold text-stone-200', String(match.mandante || 'Mandante') + ' × ' + String(match.visitante || 'Visitante')));
                var fields = makeText('div', 'grid grid-cols-[1fr_auto_1fr] items-center gap-2', '');
                [['mandante', score.mandante], ['visitante', score.visitante]].forEach(function (side, index) {
                    var input = document.createElement('input');
                    input.type = 'number'; input.min = '0'; input.step = '1'; input.required = true;
                    input.className = 'w-full rounded-lg border border-stone-700 bg-stone-800 p-2 text-center text-white';
                    input.dataset.matchId = matchId; input.dataset.side = side[0]; input.setAttribute('aria-label', 'Resultado oficial: gols ' + side[0]);
                    if (side[1] !== undefined && side[1] !== null) input.value = String(side[1]);
                    if (index === 0) fields.appendChild(input);
                    else { fields.appendChild(makeText('span', 'text-center text-stone-500', '—')); fields.appendChild(input); }
                });
                row.appendChild(fields); resultForm.appendChild(row);
            });
            var saveResult = makeText('button', 'w-full rounded-lg bg-emerald-700 px-3 py-3 text-xs font-black uppercase text-white', 'Cadastrar resultado oficial');
            saveResult.type = 'submit'; resultForm.appendChild(saveResult);
            resultForm.addEventListener('submit', async function (event) {
                event.preventDefault();
                try {
                    var scores = {};
                    resultForm.querySelectorAll('input[data-match-id]').forEach(function (input) {
                        var id = input.dataset.matchId;
                        if (!scores[id]) scores[id] = {};
                        scores[id][input.dataset.side] = Number(input.value);
                    });
                    await adminSaveOfficialResult(roundId, scores);
                    setAdminStatus('Resultado oficial salvo em área privada.', false);
                } catch (error) {
                    setAdminStatus(error instanceof TypeError ? error.message : 'Não foi possível salvar o resultado oficial.', true);
                }
            });
            card.appendChild(resultForm);
        }

        if (!closed) {
            var closeButton = makeText('button', 'w-full rounded-lg border border-red-800 bg-red-950/40 px-3 py-3 text-xs font-black uppercase text-red-200', 'Encerrar rodada');
            closeButton.type = 'button';
            closeButton.addEventListener('click', async function () {
                if (!window.confirm('Encerrar esta rodada? Novos palpites deixarão de ser aceitos.')) return;
                try {
                    await adminCloseRound(roundId);
                    setAdminStatus('Rodada encerrada.', false);
                } catch (error) {
                    setAdminStatus(error instanceof TypeError ? error.message : 'Não foi possível encerrar a rodada.', true);
                }
            });
            card.appendChild(closeButton);
        }
        return card;
    }

    function renderAdminPanel() {
        var host = document.getElementById('bolao-admin-rodadas');
        var poolInfo = document.getElementById('bolao-admin-bolao-atual');
        if (poolInfo) poolInfo.textContent = adminView.config && adminView.config.bolaoId ? 'Bolão atual: ' + String(adminView.config.titulo || adminView.config.bolaoId) : 'Nenhum Bolão aberto.';
        if (!host) return;
        host.replaceChildren();
        if (!window.isAdminLogado) {
            host.appendChild(makeText('p', 'rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm text-red-200', 'Acesso exclusivo para administradores.'));
            return;
        }
        if (adminView.erro) host.appendChild(makeText('p', 'rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm text-red-200', adminView.erro));
        if (adminView.rodadas === null) {
            host.appendChild(makeText('p', 'text-sm text-stone-400', 'Carregando rodadas…'));
            return;
        }
        var rounds = toEntries(adminView.rodadas);
        if (!rounds.length) host.appendChild(makeText('p', 'rounded-xl border border-stone-700 bg-stone-900 p-4 text-sm text-stone-300', 'Nenhuma rodada cadastrada. Abra a primeira acima.'));
        rounds.forEach(function (entry) {
            host.appendChild(renderAdminRoundCard(entry[0], entry[1] || {}, (adminView.resultados || {})[entry[0]] || null));
        });
    }

    function startAdminListeners() {
        if (adminListenersStarted || !window.isAdminLogado) return;
        adminListenersStarted = true;
        adminView.erro = '';
        try {
            adminUnsubscribers.push(listenPath(PATHS.config, function (value) { adminView.config = value; renderAdminPanel(); }, function () { adminView.erro = 'Não foi possível carregar o Bolão atual.'; renderAdminPanel(); }));
            adminUnsubscribers.push(listenPath(PATHS.rodadas, function (value) { adminView.rodadas = value; renderAdminPanel(); }, function () { adminView.erro = 'Não foi possível carregar as rodadas para administração.'; renderAdminPanel(); }));
            adminUnsubscribers.push(listenPath(PATHS.resultados, function (value) { adminView.resultados = value; renderAdminPanel(); }, function () { adminView.erro = 'Não foi possível carregar os resultados oficiais.'; renderAdminPanel(); }));
        } catch (error) {
            adminListenersStarted = false;
            adminView.erro = 'Não foi possível iniciar o painel do Bolão.';
            renderAdminPanel();
        }
    }

    function stopPublicListeners() {
        viewUnsubscribers.forEach(function (unsubscribe) { unsubscribe(); });
        viewUnsubscribers = [];
        if (participantsUnsubscribe) { participantsUnsubscribe(); participantsUnsubscribe = null; }
        if (rankingUnsubscribe) { rankingUnsubscribe(); rankingUnsubscribe = null; }
        if (authUnsubscribe) { authUnsubscribe(); authUnsubscribe = null; }
        participantsBolaoId = '';
        view.participantes = null;
        view.ranking = null;
        view.palpitesRevelados = {};
        publicLoadGeneration += 1;
        revealedLoads = Object.create(null);
        viewListenersStarted = false;
    }

    function stopAdminListeners() {
        adminUnsubscribers.forEach(function (unsubscribe) { unsubscribe(); });
        adminUnsubscribers = [];
        adminListenersStarted = false;
    }

    function startViewListeners() {
        if (viewListenersStarted) return;
        viewListenersStarted = true;
        view.erro = '';
        try {
            viewUnsubscribers.push(listenPath(PATHS.config, function (value) {
                var previousId = view.config && view.config.bolaoId;
                view.config = value;
                if (previousId !== (value && value.bolaoId)) {
                    view.palpitesRevelados = {};
                    view.ranking = null;
                }
                syncParticipantsListener(value);
                syncRankingListener(value);
                loadRevealedPredictions();
                renderBolao();
            }, function () { view.erro = 'Não foi possível carregar a configuração do Bolão.'; renderBolao(); }));
            viewUnsubscribers.push(listenPath(PATHS.rodadas, function (value) { view.rodadas = value; loadRevealedPredictions(); renderBolao(); }, function () { view.erro = 'Não foi possível carregar as rodadas do Bolão.'; renderBolao(); }));
        } catch (error) {
            viewListenersStarted = false;
            view.erro = error && error.message ? error.message : 'Não foi possível iniciar o Bolão.';
            renderBolao();
        }
        if (!authUnsubscribe && window.authRef && typeof window.authRef.onAuthStateChanged === 'function') {
            authUnsubscribe = window.authRef.onAuthStateChanged(function () { renderBolao(); });
        }
    }

    function stopAllListeners() {
        stopPublicListeners();
        stopAdminListeners();
        activeListeners.forEach(function (entry) { entry.ref.off('value', entry.valueHandler); });
        activeListeners.clear();
    }

    window.bolaoFirebase = Object.freeze({
        paths: PATHS,
        lerConfig: function () { return readPath(PATHS.config); },
        lerRodadas: function () { return readPath(PATHS.rodadas); },
        lerRanking: function () { return readPath(PATHS.ranking); },
        gravarConfig: function (dados) { return writePath(PATHS.config, dados, 'update'); },
        gravarRodada: function (rodadaId, dados) {
            return writePath(PATHS.rodadas + '/' + assertKey(rodadaId, 'ID da rodada'), dados, 'set');
        },
        gravarItemRanking: function (uid, dados) {
            return writePath(PATHS.ranking + '/' + assertKey(uid, 'UID'), dados, 'update');
        },
        gravarPalpite: savePrediction,
        abrirBolao: adminOpenBolao,
        abrirRodada: adminCreateRound,
        definirPeriodoPalpites: adminUpdateSchedule,
        gravarResultadoOficial: adminSaveOfficialResult,
        encerrarRodada: adminCloseRound,
        lerResultadosOficiais: function () { return readPath(PATHS.resultados); },
        ouvirConfig: function (callback, onError) { return listenPath(PATHS.config, callback, onError); },
        ouvirRodadas: function (callback, onError) { return listenPath(PATHS.rodadas, callback, onError); },
        ouvirRanking: function (callback, onError) { return listenPath(PATHS.ranking, callback, onError); },
        ouvirParticipantes: function (callback, onError) { return listenPath(PATHS.participantes, callback, onError); },
        pararListeners: stopAllListeners
    });

    function watchTabLifecycle() {
        var tab = document.getElementById('bolao-ver');
        var adminTab = document.getElementById('bolao-admin');
        if (tab && typeof MutationObserver !== 'undefined') {
            bolaoTabObserver = new MutationObserver(function () {
                if (!tab.classList.contains('active')) stopPublicListeners();
            });
            bolaoTabObserver.observe(tab, {attributes: true, attributeFilter: ['class']});
        }
        if (adminTab && typeof MutationObserver !== 'undefined') {
            bolaoAdminTabObserver = new MutationObserver(function () {
                if (!adminTab.classList.contains('active')) stopAdminListeners();
            });
            bolaoAdminTabObserver.observe(adminTab, {attributes: true, attributeFilter: ['class']});
        }
    }

    watchTabLifecycle();

    window.bolaoAdminAbrir = function () {
        if (!window.isAdminLogado) {
            if (typeof window.mostrarToast === 'function') window.mostrarToast('Acesso exclusivo para administradores.', true);
            return;
        }
        if (typeof window.switchTab === 'function') window.switchTab('bolao-admin');
        var title = document.getElementById('page-title-text');
        if (title) title.textContent = 'ADMINISTRAÇÃO DO BOLÃO';
        if (typeof window.toggleGamesMenu === 'function') window.toggleGamesMenu(false);
        bindNewBolaoForm();
        bindAdminCreateForm();
        startAdminListeners();
        renderAdminPanel();
    };
    window.bolaoAdminVoltar = function () { window.bolaoAbrir(); };
    window.bolaoAdminAdicionarPartida = addNewMatchRow;


    window.bolaoAbrir = function () {
        if (typeof window.switchTab === 'function') window.switchTab('bolao-ver');
        var title = document.getElementById('page-title-text');
        if (title) title.textContent = 'BOLÃO';
        if (typeof window.toggleGamesMenu === 'function') window.toggleGamesMenu(false);
        startViewListeners();
        renderBolao();
    };
    window.bolaoRenderizar = renderBolao;
})();
