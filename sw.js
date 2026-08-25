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


self.addEventListener("message", event => {

    const data = event.data;

    if (!data) {
        return;
    }


    if (data.type === "WEBHOOK") {

        sendWebhook(
            data.url,
            data.payload
        );
    }

});


async function sendWebhook(url, payload) {

    console.log(
        "Envoi webhook :",
        url,
        payload
    );

    try {

        const response =
            await fetch(
                url,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify(payload)
                }
            );

        console.log(
            "Webhook HTTP",
            response.status
        );

    } catch (error) {

        console.error(
            "Erreur webhook",
            error
        );
    }

}
