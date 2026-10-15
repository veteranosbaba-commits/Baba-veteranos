/* Bolão recreativo: Firebase Authentication + Realtime Database + Security Rules. */
(function () {
    'use strict';

    var PUBLIC = 'public';
    var PRIVATE = 'private';
    var PATHS = Object.freeze({
        config: PUBLIC + '/config',
        rodadas: PUBLIC + '/rodadas',
        resultadosPublicos: PUBLIC + '/resultados',
        revelados: PUBLIC + '/revelados',
        palpites: PRIVATE + '/palpites',
        palpitesVisitantes: PRIVATE + '/palpitesVisitantes',
        resultadosPrivados: PRIVATE + '/resultados',
        perfis: PRIVATE + '/perfis',
        visitantes: PRIVATE + '/visitantes'
    });

    var activeListeners = new Set();
    var publicUnsubs = Object.create(null);
    var ownPredictionUnsubs = Object.create(null);
    var profileUnsubscribe = null;
    var authUnsubscribe = null;
    var publicListenersStarted = false;
    var adminListenersStarted = false;
    var viewUnsubscribers = [];
    var adminUnsubscribers = [];
    var newBolaoFormBound = false;
    var adminFormBound = false;
    var aliasFormBound = false;
    var bolaoTabObserver = null;
    var bolaoAdminTabObserver = null;
    var newMatchCounter = 0;

    var view = {
        config: null,
        rodadas: null,
        palpitesRevelados: {},
        resultadosPublicos: {},
        ownPredictions: Object.create(null),
        ownPredictionsLoaded: Object.create(null),
        profile: null,
        profileUid: '',
        profileKind: '',
        erro: ''
    };
    var adminView = {config: null, rodadas: null, resultados: null, erro: ''};

    function getBolaoRef() {
        if (window.firebase && window.firebase.apps && window.firebase.apps.length) {
            return window.firebase.database().ref('bolao');
        }
        throw new Error('O Firebase do app ainda não foi inicializado.');
    }

    function getRef(path) {
        return getBolaoRef().child(path);
    }

    function currentUser() {
        return (window.authRef && window.authRef.currentUser) || window.firebaseUser || null;
    }

    function requireVerifiedUser() {
        var user = currentUser();
        if (!user || user.emailVerified !== true) {
            throw new Error('Para participar como atleta, entre com uma conta e confirme o e-mail.');
        }
        return user;
    }

    var VISITOR_ID_STORAGE_KEY = 'babaBolaoVisitorId';

    function getVisitorId() {
        try {
            var saved = window.localStorage.getItem(VISITOR_ID_STORAGE_KEY);
            if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved;
            if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
                throw new Error('Este navegador não permite criar uma identidade local segura para visitante.');
            }
            var bytes = new Uint8Array(16);
            window.crypto.getRandomValues(bytes);
            var visitorId = Array.from(bytes).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
            window.localStorage.setItem(VISITOR_ID_STORAGE_KEY, visitorId);
            return visitorId;
        } catch (error) {
            if (error && error.message && error.message.indexOf('identidade local') >= 0) throw error;
            throw new Error('Não foi possível guardar a identidade do visitante neste navegador. Ative o armazenamento local e tente novamente.');
        }
    }

    function getParticipantIdentity() {
        var user = currentUser();
        if (user && user.emailVerified === true) return {kind: 'atleta', id: String(user.uid), profilePath: PATHS.perfis + '/' + assertKey(user.uid, 'UID')};
        if (!user) {
            var visitorId = getVisitorId();
            return {kind: 'visitante', id: visitorId, profilePath: PATHS.visitantes + '/' + visitorId};
        }
        return {kind: 'naoVerificado', id: String(user.uid), profilePath: ''};
    }

    function assertAdminWrite() {
        if (!currentUser() || !window.isAdminLogado) {
            throw new Error('Somente um administrador autenticado pode alterar o Bolão.');
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

    function toEntries(value) {
        if (Array.isArray(value)) {
            return value.map(function (item, index) { return [String((item && item.id) || index), item]; })
                .filter(function (item) { return item[1] && typeof item[1] === 'object'; });
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

    function validateScoreMap(raw, matches, label) {
        var scores = assertObject(raw, label || 'Os placares');
        var expected = toEntries(matches).map(function (entry) { return String((entry[1] && entry[1].id) || entry[0]); });
        var keys = Object.keys(scores);
        if (!expected.length || keys.length !== expected.length || expected.some(function (id) { return !Object.prototype.hasOwnProperty.call(scores, id); })) {
            throw new TypeError('Informe um placar para cada partida da rodada.');
        }
        keys.forEach(function (id) {
            assertKey(id, 'ID da partida');
            if (expected.indexOf(id) === -1) throw new TypeError('O placar contém uma partida que não pertence à rodada.');
            var score = assertObject(scores[id], 'O placar');
            if (Object.keys(score).length !== 2) throw new TypeError('Cada placar deve conter somente mandante e visitante.');
            ['mandante', 'visitante'].forEach(function (side) {
                if (!Number.isInteger(score[side]) || score[side] < 0 || score[side] > 100) {
                    throw new TypeError('Informe gols inteiros entre 0 e 100.');
                }
            });
        });
        return scores;
    }

    function normalizeProfile(raw) {
        if (!raw || typeof raw.apelido !== 'string' || !raw.apelido.trim() || typeof raw.playerKey !== 'string') return null;
        return {apelido: raw.apelido.trim(), playerKey: raw.playerKey};
    }

    function safeProfileName(value, userUid) {
        var name = String(value || '').trim().replace(/\s+/g, ' ');
        if (name.length < 2 || name.length > 40) throw new TypeError('O nome ou apelido deve ter entre 2 e 40 caracteres.');
        if (/[.#$\/\[\]\u0000-\u001f]/.test(name)) throw new TypeError('O nome ou apelido contém caracteres inválidos.');
        if (userUid && name.toLowerCase() === String(userUid).toLowerCase()) throw new TypeError('Use um nome ou apelido, não o identificador da conta.');
        return name;
    }

    function bindAliasForm() {
        var form = document.getElementById('bolao-apelido-form');
        if (!form || aliasFormBound) return;
        aliasFormBound = true;
        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            var status = document.getElementById('bolao-apelido-status');
            if (status) status.textContent = '';
            try {
                var identity = getParticipantIdentity();
                if (identity.kind === 'naoVerificado') throw new Error('Confirme o e-mail da conta ou saia dela para participar como visitante.');
                var input = document.getElementById('bolao-apelido-input');
                var name = safeProfileName(input && input.value, identity.id);
                var existing = normalizeProfile(await readPath(identity.profilePath));
                if (existing) {
                    if (status) status.textContent = 'Já existe um apelido salvo para este navegador/conta: ' + existing.apelido;
                    return;
                }
                var collection = identity.kind === 'atleta' ? PATHS.perfis : PATHS.visitantes;
                var playerKey = getRef(collection).push().key;
                await getRef(identity.profilePath).set({apelido: name, playerKey: playerKey});
                if (status) status.textContent = 'Apelido salvo. Ele será exibido com seus palpites e no ranking.';
            } catch (error) {
                if (status) status.textContent = error && error.message ? error.message : 'Não foi possível salvar o apelido.';
            }
        });
    }

    function syncProfileListener() {
        var identity;
        try { identity = getParticipantIdentity(); }
        catch (error) {
            if (profileUnsubscribe) { profileUnsubscribe(); profileUnsubscribe = null; }
            view.profileUid = ''; view.profileKind = ''; view.profile = null; view.erro = error.message;
            updateAliasPanel(); renderBolao(); return;
        }
        var identityKey = identity.kind + ':' + identity.id;
        if (identityKey === view.profileUid && identity.kind === view.profileKind) return;
        if (profileUnsubscribe) { profileUnsubscribe(); profileUnsubscribe = null; }
        view.profileUid = identityKey; view.profileKind = identity.kind; view.profile = null;
        var aliasInput = document.getElementById('bolao-apelido-input');
        if (aliasInput) aliasInput.value = '';
        view.ownPredictions = Object.create(null); view.ownPredictionsLoaded = Object.create(null);
        Object.keys(ownPredictionUnsubs).forEach(function (key) { ownPredictionUnsubs[key](); delete ownPredictionUnsubs[key]; });
        if (identity.kind !== 'naoVerificado') {
            profileUnsubscribe = listenPath(identity.profilePath, function (value) {
                view.profile = normalizeProfile(value);
                syncOwnPredictionListeners(); updateAliasPanel(); renderBolao();
            }, function () {
                view.profile = null; updateAliasPanel(); renderBolao();
            });
        } else {
            updateAliasPanel(); renderBolao();
        }
    }

    function updateAliasPanel() {
        var form = document.getElementById('bolao-apelido-form');
        var saved = document.getElementById('bolao-apelido-saved');
        var input = document.getElementById('bolao-apelido-input');
        var button = form && form.querySelector('button[type="submit"]');
        var user = currentUser();
        var canSetAlias = !user || user.emailVerified === true;
        if (!form) return;
        form.classList.toggle('hidden', !canSetAlias || Boolean(view.profile));
        if (saved) {
            saved.textContent = view.profile ? 'Seu nome/apelido público: ' + view.profile.apelido : '';
            saved.classList.toggle('hidden', !view.profile);
        }
        if (input && view.profile) input.value = view.profile.apelido;
        if (button) button.disabled = Boolean(view.profile);
    }

    function bindPredictionForm(form, roundId, round, user, existing) {
        var matches = toEntries(round.partidas);
        matches.forEach(function (entry) {
            var matchId = String((entry[1] && entry[1].id) || entry[0]);
            var match = entry[1] || {};
            var row = makeText('div', 'rounded-xl border border-stone-800 bg-stone-950/70 p-3', '');
            row.appendChild(makeText('p', 'mb-3 text-xs font-bold text-stone-200', String(match.mandante || 'Mandante') + ' × ' + String(match.visitante || 'Visitante')));
            var fields = makeText('div', 'grid grid-cols-[1fr_auto_1fr] items-center gap-2', '');
            [['mandante', 'Gols do mandante'], ['visitante', 'Gols do visitante']].forEach(function (sideInfo, index) {
                var input = document.createElement('input');
                input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '1'; input.required = true; input.inputMode = 'numeric';
                input.dataset.matchId = matchId; input.dataset.side = sideInfo[0]; input.setAttribute('aria-label', sideInfo[1]);
                input.className = 'w-full rounded-lg border border-stone-700 bg-stone-800 p-2 text-center text-white';
                var savedScore = existing && existing.palpites && existing.palpites[matchId];
                if (savedScore && savedScore[sideInfo[0]] !== undefined) input.value = String(savedScore[sideInfo[0]]);
                if (index === 0) fields.appendChild(input);
                else { fields.appendChild(makeText('span', 'text-center text-stone-500', '—')); fields.appendChild(input); }
            });
            row.appendChild(fields); form.appendChild(row);
        });
        var submit = makeText('button', 'w-full rounded-xl bg-emerald-600 px-4 py-3 text-xs font-black uppercase text-white disabled:opacity-50', existing ? 'Atualizar meu palpite' : 'Salvar meu palpite');
        submit.type = 'submit';
        form.appendChild(submit);
        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            var status = document.getElementById('bolao-status');
            if (status) status.textContent = '';
            try {
                var guesses = {};
                form.querySelectorAll('input[data-match-id]').forEach(function (input) {
                    if (!guesses[input.dataset.matchId]) guesses[input.dataset.matchId] = {};
                    guesses[input.dataset.matchId][input.dataset.side] = Number(input.value);
                });
                await savePrediction(roundId, guesses);
                if (status) status.textContent = 'Palpite salvo. Você pode alterá-lo até o encerramento.';
            } catch (error) {
                if (status) status.textContent = error && error.message ? error.message : 'Não foi possível salvar o palpite.';
            }
        });
    }

    function savePrediction(roundId, guesses) {
        var identity = getParticipantIdentity();
        if (identity.kind === 'naoVerificado') throw new Error('Confirme o e-mail da conta ou saia dela para participar como visitante.');
        var profile = view.profile;
        if (view.profileKind !== identity.kind || view.profileUid !== identity.kind + ':' + identity.id) throw new Error('Carregando seu perfil. Aguarde um instante e tente novamente.');
        if (!profile) throw new Error('Salve primeiro seu nome ou apelido público.');
        var rid = assertKey(roundId, 'ID da rodada');
        var round = view.rodadas && view.rodadas[rid];
        var config = view.config;
        var now = Date.now();
        if (!round || !config || round.bolaoId !== config.bolaoId || round.status !== 'aberta' || round.encerrada === true || round.resultadoRevelado === true || now < Number(round.inicioPalpites) || now > Number(round.fimPalpites)) {
            throw new Error('O período para registrar ou editar palpites está encerrado.');
        }
        var clean = validateScoreMap(guesses, round.partidas, 'Os palpites');
        var record = {palpites: clean, enviadoEm: window.firebase.database.ServerValue.TIMESTAMP};
        if (identity.kind === 'atleta') {
            return getRef(PATHS.palpites + '/' + rid + '/' + assertKey(identity.id, 'UID')).set(record);
        }
        record.apelido = profile.apelido;
        record.playerKey = profile.playerKey;
        return getRef(PATHS.palpitesVisitantes + '/' + rid + '/' + assertKey(identity.id, 'ID do visitante')).set(record);
    }

    function syncOwnPredictionListeners() {
        var identity;
        try { identity = getParticipantIdentity(); }
        catch (error) { view.erro = error.message; return; }
        var desired = Object.create(null);
        if (identity.kind !== 'naoVerificado' && view.profile && view.config && view.rodadas) {
            toEntries(view.rodadas).forEach(function (entry) {
                var rid = entry[0]; var round = entry[1] || {};
                if (round.bolaoId === view.config.bolaoId && round.status === 'aberta' && round.resultadoRevelado !== true) {
                    var path = identity.kind === 'atleta'
                        ? PATHS.palpites + '/' + assertKey(rid, 'ID da rodada') + '/' + assertKey(identity.id, 'UID')
                        : PATHS.palpitesVisitantes + '/' + assertKey(rid, 'ID da rodada') + '/' + assertKey(identity.id, 'ID do visitante');
                    desired[identity.kind + ':' + identity.id + '|' + rid] = {rid: rid, path: path};
                }
            });
        }
        Object.keys(ownPredictionUnsubs).forEach(function (key) {
            if (!desired[key]) {
                ownPredictionUnsubs[key](); delete ownPredictionUnsubs[key];
                var rid = key.slice(key.lastIndexOf('|') + 1);
                delete view.ownPredictions[rid]; delete view.ownPredictionsLoaded[rid];
            }
        });
        Object.keys(desired).forEach(function (key) {
            if (ownPredictionUnsubs[key]) return;
            var item = desired[key];
            ownPredictionUnsubs[key] = listenPath(item.path, function (value) {
                view.ownPredictions[item.rid] = value || null;
                view.ownPredictionsLoaded[item.rid] = true;
                renderBolao();
            }, function () {
                view.ownPredictions[item.rid] = null;
                view.ownPredictionsLoaded[item.rid] = true;
                renderBolao();
            });
        });
    }

    function syncPublishedRoundListeners() {
        var desired = Object.create(null);
        if (view.config && view.rodadas) {
            toEntries(view.rodadas).forEach(function (entry) {
                var rid = entry[0]; var round = entry[1] || {};
                if (round.bolaoId === view.config.bolaoId && round.resultadoRevelado === true) desired[rid] = true;
            });
        }
        Object.keys(publicUnsubs).forEach(function (key) {
            var rid = key.split('|')[0];
            if (!desired[rid]) { publicUnsubs[key](); delete publicUnsubs[key]; }
        });
        Object.keys(desired).forEach(function (rid) {
            [['revealed', PATHS.revelados + '/' + rid], ['result', PATHS.resultadosPublicos + '/' + rid]].forEach(function (item) {
                var key = rid + '|' + item[0];
                if (publicUnsubs[key]) return;
                publicUnsubs[key] = listenPath(item[1], function (value) {
                    if (item[0] === 'revealed') view.palpitesRevelados[rid] = value || {};
                    else view.resultadosPublicos[rid] = value || null;
                    renderBolao();
                }, function () { view.erro = 'Não foi possível carregar os dados revelados.'; renderBolao(); });
            });
        });
    }

    function outcome(home, away) { return home > away ? 1 : (home < away ? -1 : 0); }

    function stableVisualSuffix(playerKey) {
        var hash = 2166136261;
        var value = String(playerKey || '');
        for (var index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0');
    }

    function buildDisplayNames() {
        var groups = Object.create(null);
        var config = view.config || {};
        toEntries(view.rodadas).forEach(function (roundEntry) {
            var roundId = roundEntry[0]; var round = roundEntry[1] || {};
            if (round.bolaoId !== config.bolaoId || round.resultadoRevelado !== true) return;
            var revealed = view.palpitesRevelados[roundId] || {};
            Object.keys(revealed).forEach(function (playerKey) {
                var record = revealed[playerKey];
                var nickname = record && typeof record.apelido === 'string' ? record.apelido.trim() : '';
                if (!nickname || !record.palpites) return;
                var groupKey = nickname.toLocaleLowerCase('pt-BR');
                if (!groups[groupKey]) groups[groupKey] = Object.create(null);
                groups[groupKey][playerKey] = nickname;
            });
        });
        var displayNames = Object.create(null);
        Object.keys(groups).forEach(function (groupKey) {
            var members = groups[groupKey];
            var playerKeys = Object.keys(members);
            if (playerKeys.length < 2) return;
            playerKeys.forEach(function (playerKey) {
                displayNames[playerKey] = members[playerKey] + ' · ' + stableVisualSuffix(playerKey);
            });
        });
        return displayNames;
    }

    function calculateRanking() {
        var totals = Object.create(null);
        var config = view.config || {};
        toEntries(view.rodadas).forEach(function (roundEntry) {
            var roundId = roundEntry[0]; var round = roundEntry[1] || {};
            if (round.bolaoId !== config.bolaoId || round.resultadoRevelado !== true) return;
            var resultRecord = view.resultadosPublicos[roundId];
            var revealed = view.palpitesRevelados[roundId] || {};
            var official = resultRecord && resultRecord.partidas;
            if (!official) return;
            Object.keys(revealed).forEach(function (playerKey) {
                var player = revealed[playerKey];
                if (!player || !player.apelido || !player.palpites) return;
                if (!totals[playerKey]) totals[playerKey] = {playerKey: playerKey, apelido: player.apelido, pontos: 0, rodadasPontuadas: 0};
                totals[playerKey].apelido = player.apelido;
                var points = 0;
                Object.keys(official).forEach(function (matchId) {
                    var guess = player.palpites[matchId]; var actual = official[matchId];
                    if (!guess || !actual) return;
                    if (guess.mandante === actual.mandante && guess.visitante === actual.visitante) points += 3;
                    else if (outcome(guess.mandante, guess.visitante) === outcome(actual.mandante, actual.visitante)) points += 1;
                });
                totals[playerKey].pontos += points;
                totals[playerKey].rodadasPontuadas += 1;
            });
        });
        return Object.keys(totals).map(function (key) { return totals[key]; }).sort(function (a, b) {
            return b.pontos - a.pontos || a.apelido.localeCompare(b.apelido, 'pt-BR');
        });
    }

    function appendRevealedPredictions(card, roundId, round, displayNames) {
        if (round.resultadoRevelado !== true) return;
        var guesses = view.palpitesRevelados[roundId];
        card.appendChild(makeText('h4', 'border-t border-stone-800 pt-3 text-xs font-black uppercase text-amber-200', 'Palpites revelados'));
        if (!guesses) { card.appendChild(makeText('p', 'text-xs text-stone-400', 'Carregando palpites revelados…')); return; }
        var playerKeys = Object.keys(guesses).filter(function (key) { return guesses[key] && guesses[key].palpites; });
        if (!playerKeys.length) { card.appendChild(makeText('p', 'text-xs text-stone-400', 'Nenhum palpite registrado nesta rodada.')); return; }
        var matches = toEntries(round.partidas);
        playerKeys.sort(function (a, b) { return String(guesses[a].apelido).localeCompare(String(guesses[b].apelido), 'pt-BR'); });
        playerKeys.forEach(function (playerKey) {
            var player = guesses[playerKey];
            var item = makeText('div', 'rounded-xl border border-stone-800 bg-stone-950/60 p-3 space-y-2', '');
            item.appendChild(makeText('p', 'text-xs font-black text-stone-200', (displayNames && displayNames[playerKey]) || player.apelido || 'Participante'));
            matches.forEach(function (entry) {
                var matchId = String((entry[1] && entry[1].id) || entry[0]);
                var score = player.palpites[matchId]; var match = entry[1] || {};
                if (score) item.appendChild(makeText('p', 'text-[11px] text-stone-300', String(match.mandante || 'Mandante') + ' ' + score.mandante + ' × ' + score.visitante + ' ' + String(match.visitante || 'Visitante')));
            });
            card.appendChild(item);
        });
    }

    function renderPublicRanking(displayNames) {
        var host = document.getElementById('bolao-ranking-publico');
        if (!host) return;
        host.replaceChildren();
        var ranking = calculateRanking();
        displayNames = displayNames || buildDisplayNames();
        host.appendChild(makeText('h3', 'mb-2 text-xs font-black uppercase tracking-wide text-amber-200', 'Ranking do Bolão'));
        if (!ranking.length) { host.appendChild(makeText('p', 'text-xs text-stone-400', 'O ranking aparece após a primeira revelação.')); return; }
        var position = 0; var lastPoints = null;
        ranking.forEach(function (record, index) {
            if (lastPoints === null || record.pontos !== lastPoints) position = index + 1;
            lastPoints = record.pontos;
            var row = makeText('div', 'flex items-center justify-between gap-3 border-b border-stone-800 py-2 text-xs', '');
            row.appendChild(makeText('span', 'font-bold text-stone-200', position + 'º · ' + ((displayNames && displayNames[record.playerKey]) || record.apelido)));
            row.appendChild(makeText('span', 'font-black text-emerald-300', record.pontos + ' pts'));
            host.appendChild(row);
        });
    }

    function renderBolao() {
        var host = document.getElementById('bolao-rodadas-lista');
        var loginPrompt = document.getElementById('bolao-login-prompt');
        var status = document.getElementById('bolao-status');
        var adminButton = document.getElementById('bolao-admin-open');
        var poolTitle = document.getElementById('bolao-titulo-atual');
        if (poolTitle) poolTitle.textContent = view.config && view.config.titulo ? String(view.config.titulo) : '';
        if (adminButton) adminButton.classList.toggle('hidden', !window.isAdminLogado);
        updateAliasPanel();
        if (!host) return;
        var user = currentUser();
        var canGuess = !user || user.emailVerified === true;
        if (loginPrompt) loginPrompt.classList.toggle('hidden', !user || user.emailVerified === true);
        host.replaceChildren();
        if (view.erro) {
            host.appendChild(makeText('p', 'rounded-xl border border-red-800 bg-red-950/40 p-3 text-sm text-red-200', view.erro));
            renderPublicRanking(); return;
        }
        var activeBolaoId = view.config && view.config.bolaoId;
        if (!activeBolaoId) {
            host.appendChild(makeText('p', 'rounded-xl border border-stone-700 bg-stone-900 p-4 text-sm text-stone-300', 'Ainda não há um Bolão aberto.'));
            renderPublicRanking(); return;
        }
        var rounds = toEntries(view.rodadas).filter(function (entry) { return entry[1] && entry[1].bolaoId === activeBolaoId; });
        var displayNames = buildDisplayNames();
        if (!rounds.length) host.appendChild(makeText('p', 'rounded-xl border border-stone-700 bg-stone-900 p-4 text-sm text-stone-300', 'Ainda não há rodadas cadastradas para este Bolão.'));
        rounds.forEach(function (entry) {
            var roundId = entry[0]; var round = entry[1] || {};
            var card = makeText('section', 'rounded-2xl border border-stone-700 bg-stone-900 p-4 space-y-4', '');
            card.appendChild(makeText('h3', 'font-black text-emerald-300 uppercase tracking-wide', String(round.titulo || ('Rodada ' + roundId))));
            var matches = toEntries(round.partidas);
            if (!matches.length) { card.appendChild(makeText('p', 'text-sm text-stone-400', 'Esta rodada ainda não tem partidas cadastradas.')); host.appendChild(card); return; }
            var now = Date.now(); var startAt = Number(round.inicioPalpites); var endAt = Number(round.fimPalpites);
            var open = round.status === 'aberta' && round.encerrada !== true && round.resultadoRevelado !== true && Number.isFinite(startAt) && Number.isFinite(endAt) && now >= startAt && now <= endAt;
            if (round.resultadoRevelado === true) {
                card.appendChild(makeText('p', 'text-xs text-amber-200', 'Palpites revelados após o resultado oficial.'));
            } else if (!open) {
                card.appendChild(makeText('p', 'text-xs text-stone-400', 'O período para registrar ou editar palpites está fechado.'));
            } else if (!canGuess) {
                card.appendChild(makeText('p', 'text-xs text-stone-400', 'Entre com uma conta de e-mail confirmado para palpitar.'));
            } else if (!view.profile) {
                card.appendChild(makeText('p', 'text-xs text-amber-200', 'Salve seu nome ou apelido público antes de palpitar.'));
            } else if (!view.ownPredictionsLoaded[roundId]) {
                card.appendChild(makeText('p', 'text-xs text-stone-400', 'Carregando seu palpite…'));
            } else {
                var form = document.createElement('form'); form.className = 'space-y-3';
                bindPredictionForm(form, roundId, round, user, view.ownPredictions[roundId]);
                card.appendChild(form);
            }
            appendRevealedPredictions(card, roundId, round, displayNames);
            host.appendChild(card);
        });
        renderPublicRanking(displayNames);
    }

    function validateSchedule(startAt, endAt) {
        var start = Number(startAt); var end = Number(endAt);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new TypeError('O fim dos palpites deve ser posterior ao início.');
        return {startAt: start, endAt: end};
    }

    function validateMatches(matches) {
        if (!Array.isArray(matches) || !matches.length || matches.length > 100) throw new TypeError('Cadastre de 1 a 100 partidas.');
        var result = {};
        matches.forEach(function (match, index) {
            var mandante = String((match && match.mandante) || '').trim();
            var visitante = String((match && match.visitante) || '').trim();
            if (!mandante || !visitante || mandante.length > 80 || visitante.length > 80) throw new TypeError('Preencha os times de cada partida (até 80 caracteres).');
            var id = 'partida_' + (index + 1);
            result[id] = {id: id, mandante: mandante, visitante: visitante};
        });
        return result;
    }

    async function adminOpenBolao(titulo) {
        assertAdminWrite();
        var name = String(titulo || '').trim();
        if (!name || name.length > 80) throw new TypeError('Informe um nome válido para o novo Bolão.');
        var id = getRef(PATHS.config).push().key;
        await getRef(PATHS.config).set({bolaoId: id, titulo: name, status: 'aberto', abertoEm: window.firebase.database.ServerValue.TIMESTAMP});
        return id;
    }

    async function adminCreateRound(input) {
        assertAdminWrite();
        var title = String((input && input.titulo) || '').trim();
        if (!title || title.length > 80) throw new TypeError('Informe o nome da rodada.');
        var schedule = validateSchedule(input.inicioPalpites, input.fimPalpites);
        var config = await readPath(PATHS.config);
        if (!config || !config.bolaoId) throw new Error('Abra um Bolão antes de cadastrar rodadas.');
        var matches = validateMatches(input.partidas);
        var ref = getRef(PATHS.rodadas).push();
        await ref.set({titulo: title, bolaoId: config.bolaoId, partidas: matches, inicioPalpites: schedule.startAt, fimPalpites: schedule.endAt, status: 'aberta', encerrada: false, resultadoRevelado: false});
        return ref.key;
    }

    async function adminUpdateSchedule(roundId, startAt, endAt) {
        assertAdminWrite();
        var rid = assertKey(roundId, 'ID da rodada'); var schedule = validateSchedule(startAt, endAt);
        var round = await readPath(PATHS.rodadas + '/' + rid);
        var result = await readPath(PATHS.resultadosPrivados + '/' + rid);
        if (!round || round.resultadoRevelado === true || round.encerrada === true || result) throw new Error('Não é possível alterar o prazo após o resultado ser salvo ou a rodada encerrada.');
        var updates = {};
        updates[PATHS.rodadas + '/' + rid + '/inicioPalpites'] = schedule.startAt;
        updates[PATHS.rodadas + '/' + rid + '/fimPalpites'] = schedule.endAt;
        await getBolaoRef().update(updates);
        return true;
    }

    async function adminSaveOfficialResult(roundId, rawScores) {
        assertAdminWrite();
        var rid = assertKey(roundId, 'ID da rodada');
        var round = await readPath(PATHS.rodadas + '/' + rid);
        if (!round) throw new Error('A rodada não foi encontrada.');
        if (Date.now() <= Number(round.fimPalpites)) throw new Error('O resultado só pode ser salvo após o fim do período de palpites.');
        var scores = validateScoreMap(rawScores, round.partidas, 'O resultado oficial');
        await getRef(PATHS.resultadosPrivados + '/' + rid).set({partidas: scores, atualizadoEm: window.firebase.database.ServerValue.TIMESTAMP});
        return true;
    }

    async function adminRevealRound(roundId) {
        assertAdminWrite();
        var rid = assertKey(roundId, 'ID da rodada');
        var values = await Promise.all([
            readPath(PATHS.rodadas + '/' + rid),
            readPath(PATHS.resultadosPrivados + '/' + rid),
            readPath(PATHS.palpites + '/' + rid),
            readPath(PATHS.perfis),
            readPath(PATHS.palpitesVisitantes + '/' + rid),
            readPath(PATHS.visitantes),
            readPath(PATHS.config)
        ]);
        var round = values[0]; var privateResult = values[1]; var athletePicks = values[2] || {}; var athleteProfiles = values[3] || {};
        var visitorPicks = values[4] || {}; var visitorProfiles = values[5] || {}; var config = values[6];
        if (!round || !config || round.bolaoId !== config.bolaoId) throw new Error('A rodada não pertence ao Bolão atual.');
        if (Date.now() <= Number(round.fimPalpites)) throw new Error('A revelação só pode ocorrer após o encerramento do prazo.');
        if (!privateResult || !privateResult.partidas) throw new Error('Salve primeiro o resultado oficial.');
        var official = validateScoreMap(privateResult.partidas, round.partidas, 'O resultado oficial');
        var revealed = {};
        function addParticipant(profile, rawGuesses, sourceId) {
            var normalized = normalizeProfile(profile);
            if (!normalized || normalized.apelido.toLowerCase() === String(sourceId).toLowerCase()) throw new Error('Um participante ainda não tem um apelido válido salvo.');
            var playerKey = assertKey(normalized.playerKey, 'Identificador do participante');
            if (playerKey.length !== 20) throw new Error('O identificador público de um participante está inválido.');
            if (Object.prototype.hasOwnProperty.call(revealed, playerKey)) throw new Error('Dois perfis usam a mesma chave interna; corrija antes de revelar.');
            var guesses = validateScoreMap(rawGuesses, round.partidas, 'Um palpite registrado');
            revealed[playerKey] = {apelido: normalized.apelido, palpites: guesses};
        }
        Object.keys(athletePicks).forEach(function (uid) {
            var record = athletePicks[uid];
            addParticipant(athleteProfiles[uid], record && record.palpites, uid);
        });
        Object.keys(visitorPicks).forEach(function (visitorId) {
            var record = visitorPicks[visitorId]; var profile = visitorProfiles[visitorId];
            if (!profile || record.apelido !== profile.apelido || record.playerKey !== profile.playerKey) throw new Error('Um palpite de visitante não corresponde ao perfil local salvo.');
            addParticipant(profile, record.palpites, visitorId);
        });
        var updates = {};
        updates[PATHS.revelados + '/' + rid] = Object.keys(revealed).length ? revealed : null;
        updates[PATHS.resultadosPublicos + '/' + rid] = {partidas: official};
        updates[PATHS.rodadas + '/' + rid + '/status'] = 'encerrada';
        updates[PATHS.rodadas + '/' + rid + '/encerrada'] = true;
        updates[PATHS.rodadas + '/' + rid + '/encerradaEm'] = window.firebase.database.ServerValue.TIMESTAMP;
        updates[PATHS.rodadas + '/' + rid + '/resultadoRevelado'] = true;
        await getBolaoRef().update(updates);
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
        var input = document.createElement('input'); input.type = type; input.value = value === undefined || value === null ? '' : String(value); input.required = true;
        input.className = className || 'w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-white';
        label.appendChild(input); return {label: label, input: input};
    }

    function setAdminStatus(message, isError) {
        var status = document.getElementById('bolao-admin-status');
        if (!status) return;
        status.textContent = message || '';
        status.className = 'min-h-5 text-xs ' + (isError ? 'text-red-300' : 'text-emerald-300');
    }

    function addNewMatchRow() {
        var container = document.getElementById('bolao-admin-novas-partidas');
        if (!container) return;
        newMatchCounter += 1;
        var row = makeText('div', 'grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] items-center gap-2 rounded-xl border border-stone-800 bg-stone-950/60 p-3', '');
        row.dataset.newMatch = 'true';
        var home = document.createElement('input'); home.type = 'text'; home.required = true; home.maxLength = 80; home.placeholder = 'Time mandante'; home.className = 'min-w-0 rounded-lg border border-stone-700 bg-stone-800 px-3 py-2 text-sm text-white'; home.dataset.mandante = 'true'; home.setAttribute('aria-label', 'Time mandante da partida ' + newMatchCounter);
        var divider = makeText('span', 'hidden sm:block text-center text-stone-500', '×');
        var away = document.createElement('input'); away.type = 'text'; away.required = true; away.maxLength = 80; away.placeholder = 'Time visitante'; away.className = 'min-w-0 rounded-lg border border-stone-700 bg-stone-800 px-3 py-2 text-sm text-white'; away.dataset.visitante = 'true'; away.setAttribute('aria-label', 'Time visitante da partida ' + newMatchCounter);
        var remove = makeText('button', 'rounded-lg border border-red-900/60 px-3 py-2 text-xs font-bold text-red-300', 'Remover');
        remove.type = 'button'; remove.addEventListener('click', function () { if (container.querySelectorAll('[data-new-match]').length > 1) row.remove(); });
        row.appendChild(home); row.appendChild(divider); row.appendChild(away); row.appendChild(remove); container.appendChild(row);
    }

    function bindNewBolaoForm() {
        var form = document.getElementById('bolao-admin-novo-bolao');
        if (!form || newBolaoFormBound) return;
        newBolaoFormBound = true;
        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            var input = document.getElementById('bolao-admin-nome-bolao');
            if (!input || !window.confirm('Abrir outro Bolão? O ranking do novo Bolão começará do zero.')) return;
            try {
                await adminOpenBolao(input.value); form.reset();
                setAdminStatus('Novo Bolão aberto. O ranking é calculado somente com as rodadas dele.', false);
            } catch (error) { setAdminStatus(error && error.message ? error.message : 'Não foi possível abrir o novo Bolão.', true); }
        });
    }

    function bindAdminCreateForm() {
        var form = document.getElementById('bolao-admin-nova-rodada');
        var addButton = document.getElementById('bolao-admin-add-match');
        var container = document.getElementById('bolao-admin-novas-partidas');
        if (!form || !container || adminFormBound) return;
        adminFormBound = true;
        if (!container.children.length) addNewMatchRow();
        if (addButton) addButton.addEventListener('click', addNewMatchRow);
        form.addEventListener('submit', async function (event) {
            event.preventDefault(); setAdminStatus('', false);
            try {
                var rows = Array.from(container.querySelectorAll('[data-new-match]'));
                var matches = rows.map(function (row) { return {mandante: row.querySelector('[data-mandante]').value, visitante: row.querySelector('[data-visitante]').value}; });
                var id = await adminCreateRound({
                    titulo: document.getElementById('bolao-admin-titulo-novo').value,
                    inicioPalpites: Date.parse(document.getElementById('bolao-admin-inicio-novo').value),
                    fimPalpites: Date.parse(document.getElementById('bolao-admin-fim-novo').value),
                    partidas: matches
                });
                form.reset(); container.replaceChildren(); newMatchCounter = 0; addNewMatchRow();
                setAdminStatus('Rodada cadastrada: ' + id, false);
            } catch (error) { setAdminStatus(error && error.message ? error.message : 'Não foi possível abrir a rodada.', true); }
        });
    }

    function renderAdminRoundCard(roundId, round, savedResult) {
        var card = makeText('section', 'space-y-4 rounded-2xl border border-amber-800/50 bg-stone-900 p-4', '');
        var revealed = round.resultadoRevelado === true;
        var closedByTime = Date.now() > Number(round.fimPalpites);
        card.appendChild(makeText('h3', 'text-sm font-black uppercase text-amber-300', String(round.titulo || ('Rodada ' + roundId))));
        card.appendChild(makeText('p', 'text-[11px] text-stone-400', revealed ? 'Encerrada e revelada · ' + roundId : (savedResult ? 'Resultado salvo; aguardando revelação · ' + roundId : (closedByTime ? 'Prazo encerrado · ' + roundId : 'Palpites abertos · ' + roundId))));

        var scheduleForm = document.createElement('form'); scheduleForm.className = 'grid grid-cols-1 gap-3 rounded-xl border border-stone-800 bg-stone-950/50 p-3 sm:grid-cols-2';
        var start = labelledInput('Início dos palpites', 'datetime-local', localDateTimeInput(round.inicioPalpites));
        var end = labelledInput('Fim dos palpites', 'datetime-local', localDateTimeInput(round.fimPalpites));
        scheduleForm.appendChild(start.label); scheduleForm.appendChild(end.label);
        var saveTime = makeText('button', 'sm:col-span-2 rounded-lg bg-stone-700 px-3 py-2 text-xs font-black uppercase text-white disabled:opacity-50', 'Salvar período');
        saveTime.type = 'submit'; saveTime.disabled = revealed || Boolean(savedResult); scheduleForm.appendChild(saveTime);
        scheduleForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            try { await adminUpdateSchedule(roundId, Date.parse(start.input.value), Date.parse(end.input.value)); setAdminStatus('Período atualizado.', false); }
            catch (error) { setAdminStatus(error && error.message ? error.message : 'Não foi possível atualizar o período.', true); }
        });
        card.appendChild(scheduleForm);

        var matches = toEntries(round.partidas);
        if (!matches.length) { card.appendChild(makeText('p', 'text-xs text-stone-400', 'Esta rodada não tem partidas cadastradas.')); return card; }
        var resultForm = document.createElement('form'); resultForm.className = 'space-y-3 rounded-xl border border-stone-800 bg-stone-950/50 p-3';
        resultForm.appendChild(makeText('h4', 'text-xs font-black uppercase text-stone-200', 'Resultado oficial (privado até a revelação)'));
        var storedScores = (savedResult && savedResult.partidas) || {};
        matches.forEach(function (entry) {
            var id = String((entry[1] && entry[1].id) || entry[0]); var match = entry[1] || {}; var score = storedScores[id] || {};
            var row = makeText('div', 'rounded-lg border border-stone-800 p-3', '');
            row.appendChild(makeText('p', 'mb-2 text-xs font-bold text-stone-200', String(match.mandante || 'Mandante') + ' × ' + String(match.visitante || 'Visitante')));
            var fields = makeText('div', 'grid grid-cols-[1fr_auto_1fr] items-center gap-2', '');
            [['mandante', score.mandante], ['visitante', score.visitante]].forEach(function (side, index) {
                var input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '1'; input.required = true;
                input.className = 'w-full rounded-lg border border-stone-700 bg-stone-800 p-2 text-center text-white'; input.dataset.matchId = id; input.dataset.side = side[0]; input.setAttribute('aria-label', 'Resultado oficial: gols ' + side[0]);
                if (side[1] !== undefined && side[1] !== null) input.value = String(side[1]);
                if (index === 0) fields.appendChild(input); else { fields.appendChild(makeText('span', 'text-center text-stone-500', '—')); fields.appendChild(input); }
            });
            row.appendChild(fields); resultForm.appendChild(row);
        });
        var saveResult = makeText('button', 'w-full rounded-lg bg-emerald-700 px-3 py-3 text-xs font-black uppercase text-white', savedResult ? 'Salvar atualização do resultado' : 'Salvar resultado privado');
        saveResult.type = 'submit'; resultForm.appendChild(saveResult);
        resultForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            try {
                var scores = {};
                resultForm.querySelectorAll('input[data-match-id]').forEach(function (input) { var id = input.dataset.matchId; if (!scores[id]) scores[id] = {}; scores[id][input.dataset.side] = Number(input.value); });
                if (savedResult && !window.confirm('Atualizar o resultado privado? A mudança só aparecerá após a revelação.')) return;
                await adminSaveOfficialResult(roundId, scores);
                setAdminStatus('Resultado salvo em área privada. Use “Revelar” para publicar os palpites e o resultado.', false);
            } catch (error) { setAdminStatus(error && error.message ? error.message : 'Não foi possível salvar o resultado.', true); }
        });
        card.appendChild(resultForm);

        if (savedResult) {
            var reveal = makeText('button', 'w-full rounded-lg border border-amber-700 bg-amber-950/40 px-3 py-3 text-xs font-black uppercase text-amber-100 disabled:opacity-50', revealed ? 'Atualizar publicação e ranking' : 'Revelar palpites e publicar resultado');
            reveal.type = 'button'; reveal.disabled = !closedByTime;
            reveal.addEventListener('click', async function () {
                var question = revealed ? 'Publicar novamente o resultado atualizado e recalcular o ranking?' : 'Revelar os palpites e publicar o resultado oficial?';
                if (!window.confirm(question)) return;
                try { await adminRevealRound(roundId); setAdminStatus('Palpites revelados; o ranking será recalculado no app.', false); }
                catch (error) { setAdminStatus(error && error.message ? error.message : 'Não foi possível revelar a rodada.', true); }
            });
            card.appendChild(reveal);
        }
        if (!closedByTime) card.appendChild(makeText('p', 'text-[11px] text-stone-500', 'O resultado e a revelação ficam disponíveis após o encerramento do prazo.'));
        return card;
    }

    function renderAdminPanel() {
        var host = document.getElementById('bolao-admin-rodadas');
        var poolInfo = document.getElementById('bolao-admin-bolao-atual');
        if (poolInfo) poolInfo.textContent = adminView.config && adminView.config.bolaoId ? 'Bolão atual: ' + String(adminView.config.titulo || adminView.config.bolaoId) : 'Nenhum Bolão aberto.';
        if (!host) return;
        host.replaceChildren();
        if (!window.isAdminLogado) { host.appendChild(makeText('p', 'rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm text-red-200', 'Acesso exclusivo para administradores.')); return; }
        if (adminView.erro) host.appendChild(makeText('p', 'rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm text-red-200', adminView.erro));
        if (adminView.rodadas === null) { host.appendChild(makeText('p', 'text-sm text-stone-400', 'Carregando rodadas…')); return; }
        var rounds = toEntries(adminView.rodadas);
        if (!rounds.length) host.appendChild(makeText('p', 'rounded-xl border border-stone-700 bg-stone-900 p-4 text-sm text-stone-300', 'Nenhuma rodada cadastrada. Abra a primeira acima.'));
        rounds.forEach(function (entry) { host.appendChild(renderAdminRoundCard(entry[0], entry[1] || {}, (adminView.resultados || {})[entry[0]] || null)); });
    }

    function startAdminListeners() {
        if (adminListenersStarted || !window.isAdminLogado) return;
        adminListenersStarted = true; adminView.erro = '';
        try {
            adminUnsubscribers.push(listenPath(PATHS.config, function (value) { adminView.config = value; renderAdminPanel(); }, function () { adminView.erro = 'Não foi possível carregar o Bolão atual.'; renderAdminPanel(); }));
            adminUnsubscribers.push(listenPath(PATHS.rodadas, function (value) { adminView.rodadas = value; renderAdminPanel(); }, function () { adminView.erro = 'Não foi possível carregar as rodadas.'; renderAdminPanel(); }));
            adminUnsubscribers.push(listenPath(PATHS.resultadosPrivados, function (value) { adminView.resultados = value; renderAdminPanel(); }, function () { adminView.erro = 'Não foi possível carregar os resultados privados.'; renderAdminPanel(); }));
        } catch (error) { adminListenersStarted = false; adminView.erro = 'Não foi possível iniciar o painel do Bolão.'; renderAdminPanel(); }
    }

    function stopAdminListeners() {
        adminUnsubscribers.forEach(function (unsubscribe) { unsubscribe(); });
        adminUnsubscribers = []; adminListenersStarted = false;
    }

    function syncViewFromAuth(user) {
        syncProfileListener(user);
        syncOwnPredictionListeners();
        updateAliasPanel(); renderBolao();
        if (window.isAdminLogado) startAdminListeners(); else stopAdminListeners();
    }

    function stopPublicListeners() {
        viewUnsubscribers.forEach(function (unsubscribe) { unsubscribe(); }); viewUnsubscribers = [];
        Object.keys(publicUnsubs).forEach(function (key) { publicUnsubs[key](); delete publicUnsubs[key]; });
        Object.keys(ownPredictionUnsubs).forEach(function (key) { ownPredictionUnsubs[key](); delete ownPredictionUnsubs[key]; });
        if (profileUnsubscribe) { profileUnsubscribe(); profileUnsubscribe = null; }
        if (authUnsubscribe) { authUnsubscribe(); authUnsubscribe = null; }
        view.profileUid = ''; view.profileKind = ''; view.profile = null; view.ownPredictions = Object.create(null); view.ownPredictionsLoaded = Object.create(null);
        view.palpitesRevelados = {}; view.resultadosPublicos = {}; publicListenersStarted = false;
    }

    function startViewListeners() {
        if (publicListenersStarted) return;
        publicListenersStarted = true; view.erro = '';
        try {
            viewUnsubscribers.push(listenPath(PATHS.config, function (value) {
                var oldId = view.config && view.config.bolaoId; view.config = value;
                if (oldId !== (value && value.bolaoId)) { view.palpitesRevelados = {}; view.resultadosPublicos = {}; }
                syncOwnPredictionListeners(); syncPublishedRoundListeners(); renderBolao();
            }, function () { view.erro = 'Não foi possível carregar a configuração do Bolão.'; renderBolao(); }));
            viewUnsubscribers.push(listenPath(PATHS.rodadas, function (value) {
                view.rodadas = value; syncOwnPredictionListeners(); syncPublishedRoundListeners(); renderBolao();
            }, function () { view.erro = 'Não foi possível carregar as rodadas do Bolão.'; renderBolao(); }));
        } catch (error) { publicListenersStarted = false; view.erro = error && error.message ? error.message : 'Não foi possível iniciar o Bolão.'; renderBolao(); }
        if (!authUnsubscribe && window.authRef && typeof window.authRef.onAuthStateChanged === 'function') {
            authUnsubscribe = window.authRef.onAuthStateChanged(function (user) { syncViewFromAuth(user || null); });
        } else {
            syncViewFromAuth(currentUser());
        }
    }

    function stopAllListeners() {
        stopPublicListeners(); stopAdminListeners();
        activeListeners.forEach(function (entry) { entry.ref.off('value', entry.valueHandler); }); activeListeners.clear();
    }

    window.bolaoFirebase = Object.freeze({
        paths: PATHS,
        lerConfig: function () { return readPath(PATHS.config); },
        lerRodadas: function () { return readPath(PATHS.rodadas); },
        lerRanking: function () { return Promise.resolve(calculateRanking()); },
        gravarPalpite: savePrediction,
        abrirBolao: adminOpenBolao,
        abrirRodada: adminCreateRound,
        definirPeriodoPalpites: adminUpdateSchedule,
        gravarResultadoOficial: adminSaveOfficialResult,
        revelarRodada: adminRevealRound,
        lerResultadosOficiais: function () { return readPath(PATHS.resultadosPrivados); },
        lerPalpitesRevelados: function (rid) { return readPath(PATHS.revelados + '/' + assertKey(rid, 'ID da rodada')); },
        pararListeners: stopAllListeners
    });

    function watchTabLifecycle() {
        var tab = document.getElementById('bolao-ver'); var adminTab = document.getElementById('bolao-admin');
        if (tab && typeof MutationObserver !== 'undefined') {
            bolaoTabObserver = new MutationObserver(function () { if (!tab.classList.contains('active')) stopPublicListeners(); });
            bolaoTabObserver.observe(tab, {attributes: true, attributeFilter: ['class']});
        }
        if (adminTab && typeof MutationObserver !== 'undefined') {
            bolaoAdminTabObserver = new MutationObserver(function () { if (!adminTab.classList.contains('active')) stopAdminListeners(); });
            bolaoAdminTabObserver.observe(adminTab, {attributes: true, attributeFilter: ['class']});
        }
    }

    bindAliasForm();
    watchTabLifecycle();

    window.bolaoAdminAbrir = function () {
        if (!window.isAdminLogado) { if (typeof window.mostrarToast === 'function') window.mostrarToast('Acesso exclusivo para administradores.', true); return; }
        if (typeof window.switchTab === 'function') window.switchTab('bolao-admin');
        var title = document.getElementById('page-title-text'); if (title) title.textContent = 'ADMINISTRAÇÃO DO BOLÃO';
        if (typeof window.toggleGamesMenu === 'function') window.toggleGamesMenu(false);
        bindNewBolaoForm(); bindAdminCreateForm(); startAdminListeners(); renderAdminPanel();
    };
    window.bolaoAdminVoltar = function () { window.bolaoAbrir(); };
    window.bolaoAdminAdicionarPartida = addNewMatchRow;
    window.bolaoAbrir = function () {
        if (typeof window.switchTab === 'function') window.switchTab('bolao-ver');
        var title = document.getElementById('page-title-text'); if (title) title.textContent = 'BOLÃO';
        if (typeof window.toggleGamesMenu === 'function') window.toggleGamesMenu(false);
        bindAliasForm(); startViewListeners(); renderBolao();
    };
    window.bolaoRenderizar = renderBolao;
})();
