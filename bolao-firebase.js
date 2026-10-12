/* Módulo isolado de dados do Bolão. Não inicia listeners automaticamente. */
(function () {
    'use strict';

    var ROOT = 'public/bolao';
    var PATHS = Object.freeze({
        config: ROOT + '/config',
        rodadas: ROOT + '/rodadas',
        ranking: ROOT + '/ranking'
    });
    var activeListeners = new Set();

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

    function assertAdminWrite() {
        var user = (window.authRef && window.authRef.currentUser) || window.firebaseUser;
        if (!user || !window.isAdminLogado) {
            throw new Error('Somente um administrador autenticado pode gravar dados do Bolão.');
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
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) {
            throw new TypeError(label + ' inválido.');
        }
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
            callback(snapshot.exists() ? snapshot.val() : null);
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
        ouvirConfig: function (callback, onError) { return listenPath(PATHS.config, callback, onError); },
        ouvirRodadas: function (callback, onError) { return listenPath(PATHS.rodadas, callback, onError); },
        ouvirRanking: function (callback, onError) { return listenPath(PATHS.ranking, callback, onError); },
        pararListeners: function () {
            activeListeners.forEach(function (entry) { entry.ref.off('value', entry.valueHandler); });
            activeListeners.clear();
        }
    });
})();
