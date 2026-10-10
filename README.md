# Vistieria

Aplicație web privată pentru evidența sumelor depuse și retrase. Autentificarea și verificarea contului se fac prin Discord OAuth; accesul este permis numai ID-urilor Discord înscrise în lista de acces sau configurate drept administratori. Administratorii gestionează lista din secțiunea „Gestionare acces” a aplicației. Local, datele sunt păstrate în fișierele `Acces.json` și `data/visterie.json`; pe Vercel, lista, registrul și sesiunile sunt păstrate în Neon Postgres. Numele și callsign-ul sunt salvate împreună cu fiecare tranzacție. Valorile monetare sunt stocate în bani întregi, iar interfața afișează lei (RON).

> Aplicația ține un registru de evidență; nu transferă și nu procesează bani. Stocarea în JSON și sesiunile ținute în memoria serverului sunt potrivite pentru o singură instanță pe un singur server, nu pentru instanțe multiple sau utilizare financiară reglementată.

## Pornire locală

Ai nevoie de Node.js 20.6 sau mai nou. Dependențele sunt instalate cu `npm install`.

1. Copiază `.env.example` în `.env` și completează `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` și `DISCORD_ADMIN_IDS` cu ID-ul Discord al administratorului (mai mulți administratori se separă prin virgulă).
2. În Discord Developer Portal, configurează URL-ul de redirect OAuth2 exact ca `DISCORD_REDIRECT_URI` (implicit `http://localhost:3000/auth/discord/callback`) și activează scope-ul `identify`.
3. Rulează `npm start` și deschide `http://localhost:3000`.
4. Conectează-te cu contul de administrator și deschide secțiunea „Gestionare acces”. Introdu ID-ul Discord (Developer Mode → clic dreapta pe utilizator → Copy User ID), numele și callsign-ul membrului.

Pentru utilizare publică, publică aplicația numai în spatele HTTPS și setează `NODE_ENV=production`; aceasta activează cookie-ul `Secure`. Păstrează `.env`, `Acces.json` și `data/visterie.json` în afara controlului versiunilor și limitează accesul la server și la copiile de siguranță. Repornește serverul după modificarea ID-urilor administratorilor din `.env`.

## Publicare pe Vercel cu Neon

Aplicația poate rula pe Vercel ca funcție serverless numai folosind o bază de date persistentă. Fișierul `vercel.json` direcționează rutele OAuth către funcția din `api/`, iar `DATABASE_URL` activează Neon pentru sold, tranzacții, accesul membrilor și sesiunile. Tabelele sunt create automat la prima cerere către API; tranzacțiile și sesiunile nu se bazează pe memoria temporară a funcției.

1. Creează o bază de date Neon și copiază connection string-ul pooled pentru variabila `DATABASE_URL`.
2. Importă repository-ul în Vercel și adaugă în Project Settings → Environment Variables `DATABASE_URL`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_ADMIN_IDS` și `DISCORD_REDIRECT_URI`.
3. Setează `DISCORD_ADMIN_IDS` la ID-ul Discord al administratorului. Administratorul primește acces chiar dacă lista de membri este goală.
4. Setează `DISCORD_REDIRECT_URI` la adresa publică Vercel urmată de `/auth/discord/callback`, de exemplu `https://numele-proiectului.vercel.app/auth/discord/callback`, și adaugă aceeași adresă la Discord Developer Portal → OAuth2 → Redirects.
5. Redeployează proiectul după configurarea variabilelor și folosește domeniul Vercel redeployat.

Nu publica `DATABASE_URL` în cod, în repository sau în conversații. Pe Vercel, dacă `DATABASE_URL` lipsește, API-ul returnează o eroare explicită în loc să raporteze succes folosind stocare temporară.

## Publicare pe Render

Poți folosi și serverul Node.js persistent de pe Render cu fișiere JSON și disc persistent. Blueprint-ul `render.yaml` configurează discul în `/var/data`; planul serviciului trebuie să permită discuri persistente.

După crearea serviciului, completează variabilele `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_ADMIN_IDS` și `DISCORD_REDIRECT_URI` în setările Render. Valoarea pentru `DISCORD_REDIRECT_URI` trebuie să fie URL-ul serviciului urmat de `/auth/discord/callback`, de exemplu `https://numele-serviciului.onrender.com/auth/discord/callback`. Adaugă același URL în Discord Developer Portal, la OAuth2 Redirects. `Acces.json` și `visterie.json` se creează pe discul persistent la prima pornire; nu încărca fișierele de date locale în repository.

## Teste

Rulează `npm test` pentru testele de validare a sumelor și a datelor membrilor.
