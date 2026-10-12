/* Dados e tela pública isolados do Bolão. Não altera módulos existentes. */
(function () {
    'use strict';

    var ROOT = 'public/bolao';
    var PRIVATE_PREDICTIONS = 'private/bolao/palpites';
    var PUBLIC_PARTICIPANTS = ROOT + '/participantes';
    var PATHS = Object.freeze({
        config: ROOT + '/config',
        rodadas: ROOT + '/rodadas',
        ranking: ROOT + '/ranking',
        participantes: PUBLIC_PARTICIPANTS,
        palpites: PRIVATE_PREDICTIONS
    });
    var activeListeners = new Set();
    var view = {config: null, rodadas: null, participantes: 0, erro: ''};
    var viewListenersStarted = false;
    var viewUnsubscribers = [];
    var authUnsubscribe = null;
    var bolaoTabObserver = null;

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
            throw new Error('Somente um administrador autenticado pode alterar os dados públicos do Bolão.');
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
        viewUnsubscribers.forEach(function (unsubscribe) { unsubscribe(); });
        viewUnsubscribers = [];
        activeListeners.forEach(function (entry) { entry.ref.off('value', entry.valueHandler); });
        activeListeners.clear();
        if (authUnsubscribe) { authUnsubscribe(); authUnsubscribe = null; }
        viewListenersStarted = false;
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
        ouvirConfig: function (callback, onError) { return listenPath(PATHS.config, callback, onError); },
        ouvirRodadas: function (callback, onError) { return listenPath(PATHS.rodadas, callback, onError); },
        ouvirRanking: function (callback, onError) { return listenPath(PATHS.ranking, callback, onError); },
        ouvirParticipantes: function (callback, onError) { return listenPath(PATHS.participantes, callback, onError); },
        pararListeners: stopAllListeners
    });

    function watchTabLifecycle() {
        var tab = document.getElementById('bolao-ver');
        if (!tab || typeof MutationObserver === 'undefined') return;
        bolaoTabObserver = new MutationObserver(function () {
            if (!tab.classList.contains('active')) stopAllListeners();
        });
        bolaoTabObserver.observe(tab, {attributes: true, attributeFilter: ['class']});
    }

    watchTabLifecycle();

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
