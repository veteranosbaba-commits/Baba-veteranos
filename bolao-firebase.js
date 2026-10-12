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
    var view = {config: null, rodadas: null, participantes: 0, erro: ''};
    var viewListenersStarted = false;
    var viewUnsubscribers = [];
    var authUnsubscribe = null;
    var bolaoTabObserver = null;
    var bolaoAdminTabObserver = null;
    var adminView = {rodadas: null, resultados: null, erro: ''};
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

    function validatePredictions(value) {
        var guesses = assertObject(value, 'Os palpites');
        var ids = Object.keys(guesses);
        if (!ids.length) throw new TypeError('Registre pelo menos um palpite.');
        ids.forEach(function (id) {
            assertKey(id, 'ID da partida');
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
        var cleanGuesses = validatePredictions(guesses);
        var round = await readPath(PATHS.rodadas + '/' + rid);
        var now = Date.now();
        if (!round || round.status !== 'aberta' || round.encerrada === true || !Number.isFinite(Number(round.inicioPalpites)) || !Number.isFinite(Number(round.fimPalpites)) || now < Number(round.inicioPalpites) || now > Number(round.fimPalpites)) {
            throw new TypeError('Os palpites desta rodada ainda não estão abertos ou o prazo terminou.');
        }
        var updates = {};
        updates[PRIVATE_PREDICTIONS + '/' + user.uid + '/' + rid] = {
            palpites: cleanGuesses,
            enviadoEm: window.firebase.database.ServerValue.TIMESTAMP
        };
        updates[PUBLIC_PARTICIPANTS + '/' + assertKey(user.uid, 'UID')] = true;
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

    function renderBolao() {
        var host = document.getElementById('bolao-rodadas-lista');
        var count = document.getElementById('bolao-participantes-count');
        var loginPrompt = document.getElementById('bolao-login-prompt');
        var status = document.getElementById('bolao-status');
        var adminButton = document.getElementById('bolao-admin-open');
        if (adminButton) adminButton.classList.toggle('hidden', !window.isAdminLogado);
        if (!host || !count) return;

        count.textContent = String(view.participantes || 0);
        var user = currentUser();
        var podePalpitar = Boolean(user && user.emailVerified === true);
        if (loginPrompt) loginPrompt.classList.toggle('hidden', podePalpitar);
        host.replaceChildren();

        if (view.erro) {
            host.appendChild(makeText('p', 'rounded-xl border border-red-800 bg-red-950/40 p-3 text-sm text-red-200', view.erro));
            return;
        }

        var rounds = toEntries(view.rodadas);
        if (!rounds.length) {
            host.appendChild(makeText('p', 'rounded-xl border border-stone-700 bg-stone-900 p-4 text-sm text-stone-300', 'Ainda não há rodadas cadastradas.'));
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
            host.appendChild(card);
        });
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

    async function adminCreateRound(input) {
        assertAdminWrite();
        var title = String((input && input.titulo) || '').trim();
        if (!title) throw new TypeError('Informe o nome da rodada.');
        var schedule = validateSchedule(input.inicioPalpites, input.fimPalpites);
        var matches = validateMatches(input.partidas);
        var suffix = window.crypto && typeof window.crypto.randomUUID === 'function'
            ? window.crypto.randomUUID().replace(/-/g, '')
            : (Date.now() + '_' + Math.floor(Math.random() * 1000000));
        var roundId = assertKey('r_' + suffix, 'ID da rodada');
        var data = {
            titulo: title,
            partidas: matches,
            inicioPalpites: schedule.startAt,
            fimPalpites: schedule.endAt,
            status: 'aberta',
            encerrada: false,
            criadaEm: window.firebase.database.ServerValue.TIMESTAMP
        };
        await getRef(PATHS.rodadas + '/' + roundId).set(data);
        return roundId;
    }

    async function adminUpdateSchedule(roundId, startAt, endAt) {
        assertAdminWrite();
        var rid = assertKey(roundId, 'ID da rodada');
        var existing = await readPath(PATHS.rodadas + '/' + rid);
        if (!existing) throw new TypeError('A rodada não foi encontrada.');
        if (existing.encerrada === true || existing.status === 'encerrada') throw new TypeError('Uma rodada encerrada não pode ter o período alterado.');
        var schedule = validateSchedule(startAt, endAt);
        await getRef(PATHS.rodadas + '/' + rid).update({
            inicioPalpites: schedule.startAt,
            fimPalpites: schedule.endAt
        });
        return true;
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
        await getRef(PATHS.resultados + '/' + rid).set({
            partidas: cleanScores,
            atualizadoEm: window.firebase.database.ServerValue.TIMESTAMP
        });
        return true;
    }

    async function adminCloseRound(roundId) {
        assertAdminWrite();
        var rid = assertKey(roundId, 'ID da rodada');
        var existing = await readPath(PATHS.rodadas + '/' + rid);
        if (!existing) throw new TypeError('A rodada não foi encontrada.');
        if (existing.encerrada === true || existing.status === 'encerrada') return true;
        await getRef(PATHS.rodadas + '/' + rid).update({
            status: 'encerrada',
            encerrada: true,
            encerradaEm: window.firebase.database.ServerValue.TIMESTAMP
        });
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
        if (authUnsubscribe) { authUnsubscribe(); authUnsubscribe = null; }
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
            viewUnsubscribers.push(listenPath(PATHS.config, function (value) { view.config = value; renderBolao(); }, function () { view.erro = 'Não foi possível carregar a configuração do Bolão.'; renderBolao(); }));
            viewUnsubscribers.push(listenPath(PATHS.rodadas, function (value) { view.rodadas = value; renderBolao(); }, function () { view.erro = 'Não foi possível carregar as rodadas do Bolão.'; renderBolao(); }));
            viewUnsubscribers.push(listenPath(PATHS.participantes, function (value, childCount) {
                view.participantes = Number(childCount) || 0;
                var countEl = document.getElementById('bolao-participantes-count');
                if (countEl) countEl.textContent = String(view.participantes);
            }, function () { view.erro = 'Não foi possível carregar a quantidade de participantes.'; renderBolao(); }));
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
