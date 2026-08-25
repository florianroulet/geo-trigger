// ------------------------------------------------------------
// geo-trigger - Service Worker
//
// Le Service Worker est le MOTEUR de geofencing.
//
// Il est responsable de :
//
//   - stocker la zone            (IndexedDB)
//   - conserver l'état          (dans / hors zone)
//   - calculer la distance       (haversine)
//   - appliquer l'hystérésis
//   - déclencher le webhook
//   - conserver un journal
//
// La page ne fait plus que transmettre les positions GPS
// brutes via postMessage({ type: "POSITION" }).
//
// LIMITATION IMPORTANTE :
//
// L'API Geolocation n'est PAS disponible dans un Service
// Worker. Le Service Worker ne peut donc pas obtenir la
// position lui-même : il faut qu'un client (page ou
// application native) la lui transmette.
//
// Le Service Worker peut en revanche être arrêté et relancé
// entre deux positions : tout l'état est donc persisté dans
// IndexedDB après chaque évaluation.
// ------------------------------------------------------------


const DB_NAME = "geo-trigger";
const DB_VERSION = 1;
const STORE_NAME = "config";

const ZONE_KEY = "zone";
const STATE_KEY = "state";
const LOG_KEY = "log";

const LOG_MAX_ENTRIES = 200;

/*
 * Hystérésis GPS :
 *
 * entrée : rayon
 * sortie : rayon + EXIT_MARGIN_METERS
 */
const EXIT_MARGIN_METERS = 20;


// ------------------------------------------------------------
// CYCLE DE VIE
// ------------------------------------------------------------

self.addEventListener("install", event => {

    console.log("Service Worker installé");

    self.skipWaiting();

});


self.addEventListener("activate", event => {

    console.log("Service Worker activé");

    event.waitUntil(
        self.clients.claim()
    );

});


// ------------------------------------------------------------
// INDEXEDDB
//
// localStorage n'est pas accessible depuis un Service Worker :
// la configuration doit vivre dans IndexedDB.
// ------------------------------------------------------------

/*
 * La connexion est mémorisée : le Service Worker effectue
 * plusieurs lectures/écritures par position GPS et ouvrir une
 * connexion à chaque fois les accumulerait.
 */
let databasePromise = null;


function openDatabase() {

    if (databasePromise) {

        return databasePromise;
    }

    databasePromise = new Promise((resolve, reject) => {

        const request =
            indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {

            const database = request.result;

            if (!database.objectStoreNames.contains(STORE_NAME)) {

                database.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = () => resolve(request.result);

        request.onerror = () => reject(request.error);
    });

    databasePromise.catch(() => {

        // Nouvelle tentative au prochain appel.

        databasePromise = null;
    });

    return databasePromise;
}


function readValue(key) {

    return openDatabase().then(database =>

        new Promise((resolve, reject) => {

            const transaction =
                database.transaction(STORE_NAME, "readonly");

            const request =
                transaction.objectStore(STORE_NAME).get(key);

            request.onsuccess = () => resolve(request.result);

            request.onerror = () => reject(request.error);
        })
    );
}


function writeValue(key, value) {

    return openDatabase().then(database =>

        new Promise((resolve, reject) => {

            const transaction =
                database.transaction(STORE_NAME, "readwrite");

            transaction
                .objectStore(STORE_NAME)
                .put(value, key);

            transaction.oncomplete = () => resolve();

            transaction.onerror = () => reject(transaction.error);
        })
    );
}


// ------------------------------------------------------------
// DIFFUSION VERS LES CLIENTS
// ------------------------------------------------------------

async function broadcast(message) {

    const clients =
        await self.clients.matchAll({

            type: "window",

            includeUncontrolled: true
        });

    for (const client of clients) {

        client.postMessage(message);
    }
}


// ------------------------------------------------------------
// JOURNAL
//
// Persisté : la page peut ainsi afficher ce qui s'est passé
// pendant qu'elle était fermée.
// ------------------------------------------------------------

async function log(message) {

    console.log("[geo-trigger]", message);

    const entry = {

        time: new Date().toISOString(),

        message
    };

    const entries =
        (await readValue(LOG_KEY)) || [];

    entries.push(entry);

    while (entries.length > LOG_MAX_ENTRIES) {

        entries.shift();
    }

    await writeValue(LOG_KEY, entries);

    await broadcast({

        type: "LOG",

        entry
    });
}


// ------------------------------------------------------------
// GEOFENCING
// ------------------------------------------------------------

function distanceMeters(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const R = 6371000;

    const dLat =
        (lat2 - lat1) * Math.PI / 180;

    const dLon =
        (lon2 - lon1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +

        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    const c =
        2 * Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );

    return R * c;
}


function defaultState() {

    return {

        inside: false,

        distance: null,

        position: null,

        updatedAt: null
    };
}


async function readState() {

    return (await readValue(STATE_KEY)) || defaultState();
}


/*
 * Coeur du moteur.
 *
 * position : objet simple
 *
 *   {
 *     latitude,
 *     longitude,
 *     accuracy,
 *     timestamp
 *   }
 *
 * Un GeolocationPosition n'est pas clonable : la page envoie
 * donc un objet reconstruit.
 */
async function handlePosition(position) {

    const zone = await readValue(ZONE_KEY);

    if (!zone) {

        await broadcast({

            type: "STATE",

            zone: null,

            state: await readState()
        });

        return;
    }


    const state = await readState();

    const distance =
        distanceMeters(

            position.latitude,
            position.longitude,

            zone.latitude,
            zone.longitude
        );

    const radius =
        zone.diameter / 2;

    const exitRadius =
        radius + EXIT_MARGIN_METERS;


    let event = null;


    // --------------------------------------------------------
    // ENTRÉE
    // --------------------------------------------------------

    if (!state.inside && distance <= radius) {

        state.inside = true;

        event = "enter";
    }


    // --------------------------------------------------------
    // SORTIE
    // --------------------------------------------------------

    else if (state.inside && distance >= exitRadius) {

        state.inside = false;

        event = "exit";
    }


    state.distance = distance;

    state.position = position;

    state.updatedAt = new Date().toISOString();


    // L'état est persisté AVANT le webhook : si le Service
    // Worker est tué pendant le fetch, on ne redéclenchera pas
    // l'entrée à la position suivante.

    await writeValue(STATE_KEY, state);

    await broadcast({

        type: "STATE",

        zone,

        state,

        radius,

        exitRadius
    });


    if (!event) {
        return;
    }


    const payload = {

        event,

        latitude: position.latitude,

        longitude: position.longitude,

        accuracy: position.accuracy,

        timestamp: new Date().toISOString()
    };


    if (event === "enter") {

        await log(
            `ENTRÉE dans la zone (${distance.toFixed(1)} m)`
        );

        await sendWebhook(zone.webhook, payload);

    } else {

        await log(
            `SORTIE de la zone (${distance.toFixed(1)} m)`
        );

        // Pour le POC on ne déclenche pas de webhook
        // à la sortie.
    }
}


// ------------------------------------------------------------
// WEBHOOK
// ------------------------------------------------------------

async function sendWebhook(url, payload) {

    if (!url) {

        await log("Webhook non configuré");

        return {

            ok: false,

            error: "Webhook non configuré"
        };
    }

    await log(`Appel webhook : ${url}`);

    try {

        const response =
            await fetch(
                url,
                {
                    method: "GET",
                    //
                    // headers: {
                    //     "Content-Type":
                    //         "application/json"
                    // },
                    //
                    // body:
                    //     JSON.stringify(payload)
                }
            );

        await log(`Webhook HTTP ${response.status}`);

        await notify(
            "geo-trigger",
            `${payload.event} - webhook HTTP ${response.status}`
        );

        return {

            ok: response.ok,

            status: response.status
        };

    } catch (error) {

        await log("Erreur webhook : " + error);

        await notify(
            "geo-trigger",
            "Erreur webhook : " + error
        );

        return {

            ok: false,

            error: String(error)
        };
    }
}


// ------------------------------------------------------------
// NOTIFICATION
//
// Seule trace visible quand la page est fermée ou en veille.
// Échoue silencieusement si la permission n'a pas été
// accordée.
// ------------------------------------------------------------

async function notify(title, body) {

    try {

        await self.registration.showNotification(
            title,
            {
                body,

                tag: "geo-trigger",

                renotify: true
            }
        );

    } catch (error) {

        // Permission absente : on ignore.
    }
}


// ------------------------------------------------------------
// MESSAGES
// ------------------------------------------------------------

self.addEventListener("message", event => {

    const data = event.data;

    if (!data || !data.type) {
        return;
    }

    event.waitUntil(
        handleMessage(data, event)
    );

});


function reply(event, value) {

    if (event.ports && event.ports[0]) {

        event.ports[0].postMessage(value);
    }
}


async function handleMessage(data, event) {

    switch (data.type) {


        // ----------------------------------------------------
        // Position GPS transmise par un client
        // ----------------------------------------------------

        case "POSITION": {

            await handlePosition(data.position);

            reply(event, {

                ok: true,

                state: await readState()
            });

            break;
        }


        // ----------------------------------------------------
        // Enregistrement de la zone
        // ----------------------------------------------------

        case "SAVE_ZONE": {

            const zone = {

                latitude: Number(data.zone.latitude),

                longitude: Number(data.zone.longitude),

                diameter: Number(data.zone.diameter),

                webhook: data.zone.webhook
            };

            await writeValue(ZONE_KEY, zone);

            // Nouvelle zone : on repart d'un état neutre.

            await writeValue(STATE_KEY, defaultState());

            await log(
                `Zone enregistrée : ${JSON.stringify(zone)}`
            );

            reply(event, {

                ok: true,

                zone,

                state: await readState()
            });

            break;
        }


        // ----------------------------------------------------
        // Lecture de la configuration complète
        // ----------------------------------------------------

        case "GET_CONFIG": {

            reply(event, {

                ok: true,

                zone: (await readValue(ZONE_KEY)) || null,

                state: await readState(),

                log: (await readValue(LOG_KEY)) || [],

                exitMargin: EXIT_MARGIN_METERS
            });

            break;
        }


        // ----------------------------------------------------
        // Appel manuel du webhook (test)
        // ----------------------------------------------------

        case "TEST_WEBHOOK": {

            /*
             * L'URL transmise par la page prime sur celle de la
             * zone enregistrée : c'est justement AVANT
             * l'enregistrement qu'on veut vérifier qu'une URL
             * répond.
             */

            const zone = await readValue(ZONE_KEY);

            const url =
                data.url || (zone && zone.webhook);

            await log("Test manuel du webhook");

            const result =
                await sendWebhook(
                    url,
                    {
                        event: "test",

                        timestamp: new Date().toISOString()
                    }
                );

            reply(event, result);

            break;
        }


        // ----------------------------------------------------
        // Ancien protocole, où la page décidait elle-même du
        // déclenchement.
        //
        // Conservé le temps d'une mise à jour : une page déjà
        // chargée avant l'installation de ce Service Worker
        // continue d'envoyer ce message.
        // ----------------------------------------------------

        case "WEBHOOK": {

            await sendWebhook(data.url, data.payload || {});

            reply(event, { ok: true });

            break;
        }


        default: {

            reply(event, {

                ok: false,

                error: "Type de message inconnu : " + data.type
            });
        }
    }
}
