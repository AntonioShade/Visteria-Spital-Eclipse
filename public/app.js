const authView = document.querySelector("#auth-view");
const dashboardView = document.querySelector("#dashboard-view");
const toast = document.querySelector("#toast");
const currency = new Intl.NumberFormat("ro-RO", { style: "currency", currency: "RON" });
let toastTimeout;

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Cererea nu a putut fi finalizată.");
  return body;
}

function showView(stage) {
  authView.hidden = stage !== "anonymous";
  dashboardView.hidden = stage !== "authorized";
}

function renderLedger(ledger) {
  document.querySelector("#balance-amount").textContent = currency.format(ledger.balanceCents / 100);
  document.querySelector("#transaction-count").textContent = `${ledger.transactions.length} ${ledger.transactions.length === 1 ? "operațiune" : "operațiuni"}`;
  document.querySelector("#history-count").textContent = `${ledger.transactions.length} ÎNREGISTRĂRI`;

  const list = document.querySelector("#history-list");
  list.replaceChildren();
  document.querySelector("#empty-state").hidden = ledger.transactions.length > 0;

  for (const transaction of ledger.transactions) {
    const isDeposit = transaction.type === "deposit";
    const row = document.createElement("article");
    row.className = "transaction-row";

    const icon = document.createElement("span");
    icon.className = `transaction-icon ${isDeposit ? "deposit" : "withdrawal"}`;
    icon.textContent = isDeposit ? "↙" : "↗";
    icon.setAttribute("aria-hidden", "true");

    const details = document.createElement("div");
    details.className = "transaction-details";
    const title = document.createElement("p");
    title.className = "transaction-title";
    title.textContent = transaction.note || (isDeposit ? "Adăugare în vistierie" : "Retragere din vistierie");
    const meta = document.createElement("p");
    meta.className = "transaction-meta";
    const date = new Date(transaction.createdAt);
    const memberName = transaction.callsign
      ? `${transaction.actor} · ${transaction.callsign}`
      : transaction.actor;
    meta.textContent = `${date.toLocaleString("ro-RO", { dateStyle: "medium", timeStyle: "short" })} · ${memberName}`;
    details.append(title, meta);

    const amount = document.createElement("span");
    amount.className = `transaction-amount ${isDeposit ? "deposit" : "withdrawal"}`;
    amount.textContent = `${isDeposit ? "+" : "−"}${currency.format(transaction.amountCents / 100)}`;
    row.append(icon, details, amount);
    list.append(row);
  }
}

function avatarFor(user) {
  const avatar = document.querySelector("#user-avatar");
  avatar.replaceChildren();
  avatar.textContent = user.displayName.slice(0, 1).toUpperCase();
  document.querySelector("#user-name").textContent = user.callsign
    ? `${user.displayName} · ${user.callsign}`
    : user.displayName;
}

function renderMembers(users) {
  const list = document.querySelector("#member-list");
  list.replaceChildren();
  document.querySelector("#member-count").textContent = String(users.length);
  document.querySelector("#members-empty").hidden = users.length > 0;

  for (const user of users) {
    const row = document.createElement("article");
    row.className = "member-row";
    const details = document.createElement("div");
    details.className = "member-details";
    const name = document.createElement("p");
    name.className = "member-name";
    name.textContent = `${user.displayName} · ${user.callsign}`;
    const id = document.createElement("p");
    id.className = "member-id";
    id.textContent = user.discordId;
    details.append(name, id);

    const removeButton = document.createElement("button");
    removeButton.className = "member-remove";
    removeButton.type = "button";
    removeButton.textContent = "Elimină";
    removeButton.addEventListener("click", async () => {
      removeButton.disabled = true;
      try {
        await api("/api/admin/access", {
          method: "DELETE",
          body: JSON.stringify({ discordId: user.discordId })
        });
        await loadMembers();
        showToast("Accesul persoanei a fost revocat.");
      } catch (error) {
        showToast(error.message, true);
        removeButton.disabled = false;
      }
    });

    row.append(details, removeButton);
    list.append(row);
  }
}

async function loadMembers() {
  const { users } = await api("/api/admin/access");
  renderMembers(users);
}

async function loadDashboard() {
  const session = await api("/api/session");
  showView(session.stage);
  if (session.stage === "authorized") {
    avatarFor(session.user);
    renderLedger(await api("/api/ledger"));
    if (session.user.isAdmin) {
      document.querySelector("#access-link").hidden = false;
      document.querySelector("#access-section").hidden = false;
      await loadMembers();
    }
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("error") === "not-allowed") showToast("Acest cont Discord nu are acces aprobat.", true);
  if (params.get("error") === "oauth") showToast("Autentificarea Discord nu a putut fi finalizată. Încearcă din nou.", true);
  if (params.has("error")) history.replaceState({}, "", "/");
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
    showView("anonymous");
  } catch (error) {
    showToast(error.message, true);
  }
}

document.querySelector("#logout-button").addEventListener("click", logout);

document.querySelector("#access-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api("/api/admin/access", {
      method: "POST",
      body: JSON.stringify({
        discordId: document.querySelector("#member-discord-id").value,
        displayName: document.querySelector("#member-name").value,
        callsign: document.querySelector("#member-callsign").value
      })
    });
    event.currentTarget.reset();
    await loadMembers();
    showToast("Persoana a primit acces la vistierie.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

for (const [formId, type, amountId, noteId] of [
  ["deposit-form", "deposit", "deposit-amount", "deposit-note"],
  ["withdrawal-form", "withdrawal", "withdrawal-amount", "withdrawal-note"]
]) {
  document.querySelector(`#${formId}`).addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const ledger = await api("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          type,
          amount: document.querySelector(`#${amountId}`).value,
          note: document.querySelector(`#${noteId}`).value
        })
      });
      event.currentTarget.reset();
      renderLedger(ledger);
      showToast(type === "deposit" ? "Suma a fost adăugată în vistierie." : "Suma a fost scoasă din vistierie.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

loadDashboard().catch((error) => {
  showView("anonymous");
  showToast(error.message, true);
});
