
let currentPosition = null;

let zone = null;

let configLoaded = false;


// ------------------------------------------------------------
// LOG
//
// Le journal de référence vit dans le Service Worker : la page
// affiche ce qu'il lui pousse, plus ses propres messages
// locaux.
// ------------------------------------------------------------

function appendLog(time, message) {
    const element = document.getElementById("log");
    element.textContent += `[${time}] ${message}\n`;
    element.scrollTop = element.scrollHeight;
}


function log(message) {
    appendLog(
        new Date().toLocaleTimeString(),
        message
    );
    console.log(message);
}


function logEntry(entry) {
    appendLog(
        new Date(entry.time).toLocaleTimeString(),
        entry.message
    );
}


// ------------------------------------------------------------
// SERVICE WORKER
// ------------------------------------------------------------

async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
        log("Service Worker non supporté");
        return false;
    }

    try {
        await navigator.serviceWorker.register("./sw.js");
        log("Service Worker enregistré");
        await navigator.serviceWorker.ready;
        navigator.serviceWorker.addEventListener(
            "message",
            event => onWorkerMessage(event.data)
        );


        /*
         * Au premier chargement le Service Worker vient d'être
         * installé et ne contrôle pas encore la page :
         * postMessage() n'aboutirait nulle part. On attend donc
         * le passage en contrôleur (clients.claim()).
         */

        if (!navigator.serviceWorker.controller) {
            log("En attente du contrôleur...");
            await new Promise(resolve => {
                navigator.serviceWorker.addEventListener(
                    "controllerchange",
                    resolve,
                    { once: true }
                );
                setTimeout(resolve, 3000);
            });
        }

        /*
         * Le Service Worker peut prendre le contrôle plus tard
         * (installation lente, mise à jour) : on récupère alors
         * la configuration sans demander de rechargement.
         */

        navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => {
                if (!configLoaded) {
                    loadConfig();
                }
            }
        );

        if (!navigator.serviceWorker.controller) {
            log(
                "Service Worker pas encore contrôleur : en attente"
            );
            return false;
        }

        log("Service Worker prêt");
        return true;
    } catch (error) {
        log("Erreur Service Worker : " + error);
        return false;
    }
}


/*
 * Envoi d'un message au Service Worker avec réponse, via un
 * MessageChannel.
 */
function send(message) {
    return new Promise((resolve, reject) => {
        const target = navigator.serviceWorker.controller;
        if (!target) {
            reject(
                new Error("Service Worker non contrôleur")
            );
            return;
        }
        const channel = new MessageChannel();
        channel.port1.onmessage = event => resolve(event.data);
        target.postMessage(message, [channel.port2]);
    });
}


function onWorkerMessage(data) {
    if (!data || !data.type) {
        return;
    }

    if (data.type === "LOG") {
        logEntry(data.entry);
        return;
    }

    if (data.type === "STATE") {
        if (data.zone) {
            zone = data.zone;
        }
        renderState(data);
    }
}


// ------------------------------------------------------------
// GPS
//
// Seule responsabilité restante de la page : obtenir les
// positions et les transmettre au Service Worker.
// ------------------------------------------------------------

function startGPS() {
    if (!("geolocation" in navigator)) {
        document.getElementById("position").textContent = "Géolocalisation non supportée";
        return;
    }

    navigator.geolocation.watchPosition(

        position => {
            currentPosition = position;
            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;
            const accuracy = position.coords.accuracy;
            document.getElementById("position").textContent =
                `Latitude  : ${latitude}
Longitude : ${longitude}
Précision  : ${accuracy.toFixed(1)} m`;

            sendPosition(position);
        },
        error => {
            log(
                `Erreur GPS ${error.code}: ${error.message}`
            );
        },

        {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 30000
        }
    );
    log("watchPosition() démarré");
}


let positionErrorLogged = false;


async function sendPosition(position) {

    /*
     * Un GeolocationPosition n'est pas clonable : on envoie un
     * objet simple.
     */

    const payload = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: position.timestamp
    };

    try {
        await send({
            type: "POSITION",
            position: payload
        });

        positionErrorLogged = false;
    } catch (error) {
        if (!positionErrorLogged) {
            log(
                "Position non transmise au Service Worker : "
                + error.message
            );
            positionErrorLogged = true;
        }
    }
}


// ------------------------------------------------------------
// FORMULAIRE
// ------------------------------------------------------------

document
    .getElementById("createZone")
    .addEventListener("click", () => {
        if (!currentPosition) {

            alert(
                "La position GPS n'est pas encore disponible."
            );

            return;
        }

        document.getElementById("latitude").value = currentPosition.coords.latitude.toFixed(6);
        document.getElementById("longitude").value = currentPosition.coords.longitude.toFixed(6);
        document.getElementById("diameter").value = 100;
        document.getElementById("webhook").value = "";

        log("Formulaire initialisé avec la position actuelle");
    });


document
    .getElementById("zoneForm")
    .addEventListener("submit", async event => {
        event.preventDefault();
        const candidate = {
            latitude: Number(document.getElementById("latitude").value),
            longitude: Number(document.getElementById("longitude").value),
            diameter: Number(document.getElementById("diameter").value),
            webhook: document.getElementById("webhook").value
        };


        // Geste utilisateur : bon moment pour demander la
        // permission de notifier, seule trace visible quand la
        // page n'est pas au premier plan.

        await requestNotificationPermission();
        try {
            const result =
                await send({
                    type: "SAVE_ZONE",
                    zone: candidate
                });
            zone = result.zone;
            updateZoneStatus();
            renderState({zone: result.zone, state: result.state});

            /*
             * Le Service Worker n'évalue une zone qu'à la
             * réception d'une position. Sans cela l'état
             * resterait vide jusqu'au prochain tick GPS : on lui
             * renvoie donc immédiatement la dernière position
             * connue.
             */
            if (currentPosition) {
                await sendPosition(currentPosition);
            }
        } catch (error) {
            log("Zone non enregistrée : " + error.message);
        }
    });


document
    .getElementById("testWebhook")
    .addEventListener("click", async () => {
        const button = document.getElementById("testWebhook");
        const input = document.getElementById("webhook");

        /*
         * On teste l'URL saisie dans le formulaire, pas celle de
         * la zone enregistrée : on veut pouvoir vérifier une URL
         * avant de la valider.
         */
        const url = input.value.trim();
        if (!url || !input.checkValidity()) {
            alert("Renseigne une URL de webhook valide.");
            input.focus();
            return;
        }

        // Geste utilisateur : le résultat du test passe par une
        // notification, c'est donc le bon moment pour en
        // demander la permission.
        await requestNotificationPermission();

        const label = button.textContent;
        button.disabled = true;
        button.textContent = "Test en cours...";

        try {
            const result = await send({type: "TEST_WEBHOOK", url});
            if (result.ok) {
                log(`Test réussi : HTTP ${result.status}`);
            } else if (result.status !== undefined) {
                log(`Test en échec : HTTP ${result.status}`);
            } else {
                log("Test en échec : " + result.error);
            }
        } catch (error) {
            log("Test impossible : " + error.message);
        } finally {
            button.disabled = false;
            button.textContent = label;
        }
    });


document
    .getElementById("unregisterServiceWorker")
    .addEventListener("click", async () => {
        if (!("serviceWorker" in navigator)) {
            log("Service Worker non supporté");
            return;
        }

        const confirmed =
            confirm(
                "Supprimer le Service Worker ?\n\n"
                + "Le geofencing s'arrêtera. La zone "
                + "enregistrée, elle, est conservée."
            );
        if (!confirmed) {
            return;
        }

        try {
            const registrations = await navigator.serviceWorker.getRegistrations();

            if (registrations.length === 0) {
                log("Aucun Service Worker enregistré");
                return;
            }

            for (const registration of registrations) {
                const removed = await registration.unregister();
                log(
                    removed
                        ? "Service Worker supprimé"
                        : "Service Worker non supprimé"
                );
            }


            /*
             * unregister() détache la registration mais ne tue
             * pas le worker déjà actif : il continue de servir
             * les pages qu'il contrôle jusqu'à leur
             * rechargement.
             */

            log(
                "Recharge la page pour terminer la suppression"
            );

        } catch (error) {

            log("Suppression impossible : " + error.message);
        }
    });


async function requestNotificationPermission() {

    if (!("Notification" in window)) {
        return;
    }

    if (Notification.permission !== "default") {
        return;
    }

    try {

        const permission =
            await Notification.requestPermission();

        log("Notifications : " + permission);

    } catch (error) {

        // Ignoré.
    }
}


// ------------------------------------------------------------
// CHARGEMENT DE LA CONFIGURATION
//
// La zone est détenue par le Service Worker (IndexedDB), pas
// par la page.
// ------------------------------------------------------------

async function loadConfig() {

    try {

        const config = await send({ type: "GET_CONFIG" });

        configLoaded = true;

        for (const entry of config.log) {
            logEntry(entry);
        }

        if (!config.zone) {
            updateZoneStatus();
            return;
        }

        zone = config.zone;
        document.getElementById("latitude").value = zone.latitude;
        document.getElementById("longitude").value = zone.longitude;
        document.getElementById("diameter").value = zone.diameter;
        document.getElementById("webhook").value = zone.webhook;

        updateZoneStatus();

        renderState({
            zone: config.zone,
            state: config.state
        });

        log("Zone chargée depuis le Service Worker");

    } catch (error) {
        log(
            "Configuration illisible : " + error.message
        );
    }
}


// ------------------------------------------------------------
// UI
// ------------------------------------------------------------

function renderState(data) {

    const state = data.state;
    const element = document.getElementById("state");

    if (!data.zone) {
        element.textContent = "Zone non configurée";
        return;
    }

    if (state.distance === null) {
        element.textContent = "En attente d'une position GPS";
        return;
    }

    const radius =
        data.radius !== undefined ? data.radius : data.zone.diameter / 2;

    element.textContent =
        `Distance : ${state.distance.toFixed(1)} m
Rayon : ${radius} m
État : ${state.inside ? "DANS LA ZONE" : "HORS ZONE"}`;

    element.className = state.inside ? "inside" : "outside";
}


function updateZoneStatus() {

    const element = document.getElementById("zoneStatus");

    if (!zone) {
        element.textContent = "Aucune zone configurée";
        return;
    }

    element.textContent =
        `Zone : ${zone.latitude}, ${zone.longitude}
Diamètre : ${zone.diameter} m
Webhook : ${zone.webhook}`;
}


// ------------------------------------------------------------
// INIT
// ------------------------------------------------------------

(async function () {

    const ready = await registerServiceWorker();

    if (ready) {
        await loadConfig();
    }

    startGPS();
})();
