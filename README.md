# Vistieria

Aplicație web privată pentru evidența sumelor depuse și retrase. Autentificarea și verificarea contului se fac prin Discord OAuth; accesul este permis numai ID-urilor Discord înscrise în `Acces.json` sau configurate drept administratori. Administratorii gestionează lista din secțiunea „Gestionare acces” a aplicației. La prima pornire, aplicația creează `Acces.json` și `data/visterie.json` din șabloanele incluse; ambele fișiere cu date reale sunt ignorate de Git. Numele și callsign-ul sunt salvate împreună cu fiecare tranzacție. Valorile monetare sunt stocate în bani întregi, iar interfața afișează lei (RON).

> Aplicația ține un registru de evidență; nu transferă și nu procesează bani. Stocarea în JSON și sesiunile ținute în memoria serverului sunt potrivite pentru o singură instanță pe un singur server, nu pentru instanțe multiple sau utilizare financiară reglementată.

## Pornire locală

Ai nevoie de Node.js 20.6 sau mai nou. Nu sunt necesare pachete externe.

1. Copiază `.env.example` în `.env` și completează `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` și `DISCORD_ADMIN_IDS` cu ID-ul Discord al administratorului (mai mulți administratori se separă prin virgulă).
2. În Discord Developer Portal, configurează URL-ul de redirect OAuth2 exact ca `DISCORD_REDIRECT_URI` (implicit `http://localhost:3000/auth/discord/callback`) și activează scope-ul `identify`.
3. Rulează `npm start` și deschide `http://localhost:3000`.
4. Conectează-te cu contul de administrator și deschide secțiunea „Gestionare acces”. Introdu ID-ul Discord (Developer Mode → clic dreapta pe utilizator → Copy User ID), numele și callsign-ul membrului.

Pentru utilizare publică, publică aplicația numai în spatele HTTPS și setează `NODE_ENV=production`; aceasta activează cookie-ul `Secure`. Păstrează `.env`, `Acces.json` și `data/visterie.json` în afara controlului versiunilor și limitează accesul la server și la copiile de siguranță. Repornește serverul după modificarea ID-urilor administratorilor din `.env`.

## Publicare pe Render

Aplicația folosește un server Node.js persistent, sesiuni în memoria procesului și fișiere JSON. Nu o publica pe Vercel fără migrarea sesiunilor și a datelor la servicii externe. Pentru Render, folosește blueprint-ul `render.yaml`; acesta configurează un serviciu web Node cu disc persistent montat în `/var/data`. Planul serviciului trebuie să permită discuri persistente.

După crearea serviciului, completează variabilele `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_ADMIN_IDS` și `DISCORD_REDIRECT_URI` în setările Render. Valoarea pentru `DISCORD_REDIRECT_URI` trebuie să fie URL-ul serviciului urmat de `/auth/discord/callback`, de exemplu `https://numele-serviciului.onrender.com/auth/discord/callback`. Adaugă același URL în Discord Developer Portal, la OAuth2 Redirects. `Acces.json` și `visterie.json` se creează pe discul persistent la prima pornire; nu încărca fișierele de date locale în repository.

## Teste

Rulează `npm test` pentru testele de validare a sumelor și a datelor membrilor.
