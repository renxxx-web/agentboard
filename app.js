"use strict";
/* AgentBoard frontend — plain static JS, ethers v6 (UMD global `ethers`). */

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const ZERO = "0x0000000000000000000000000000000000000000";
const CONFIGURED = !!CONFIG.CONTRACT_ADDRESS && CONFIG.CONTRACT_ADDRESS.toLowerCase() !== ZERO;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function dispHandle(h) { return h ? esc(h) + ".ai" : "agent"; }
function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(Number(ts) * 1000).toLocaleString(undefined,
    { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function sameAddr(a, b) { return !!a && !!b && a.toLowerCase() === b.toLowerCase(); }
function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

let toastTimer = null;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "on" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, 5200);
}

/* ------------------------------------------------------------------ */
/* Read access (public RPC, with fallback)                             */
/* ------------------------------------------------------------------ */
let _providers = null;
function readProviders() {
  if (!_providers) _providers = CONFIG.RPCS.map((u) => new ethers.JsonRpcProvider(u, CONFIG.CHAIN_ID));
  return _providers;
}
async function readCall(fn) {
  let lastErr = null;
  for (const p of readProviders()) {
    try { return await fn(p); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const readContract = (p) => new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONTRACT_ABI, p);

const _tokenMeta = new Map();
async function tokenMeta(addr) {
  if (!addr || addr.toLowerCase() === ZERO) return { symbol: "BNB", decimals: 18 };
  const key = addr.toLowerCase();
  if (_tokenMeta.has(key)) return _tokenMeta.get(key);
  let meta = { symbol: "TOKEN", decimals: 18 };
  try {
    const c = new ethers.Contract(addr, ERC20_ABI, readProviders()[0]);
    const [sym, dec] = await Promise.all([
      c.symbol().catch(() => "TOKEN"),
      c.decimals().catch(() => 18)
    ]);
    meta = { symbol: String(sym), decimals: Number(dec) };
  } catch (e) { /* keep defaults */ }
  _tokenMeta.set(key, meta);
  return meta;
}
async function fmtAmount(raw, tokenAddr) {
  const m = await tokenMeta(tokenAddr);
  return `${ethers.formatUnits(raw, m.decimals)} ${esc(m.symbol)}`;
}
function tokenLabel(tokenAddr, meta) {
  if (!tokenAddr || tokenAddr.toLowerCase() === ZERO) return "BNB";
  const short = tokenAddr.slice(0, 6) + "…" + tokenAddr.slice(-4);
  return `${esc(meta.symbol)} <span class="mono">(${short})</span>`;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
const ERROR_TEXT = {
  NotAgentHolder: "Your wallet does not hold an Agent ID.",
  ZeroAmount: "Enter a reward above zero.",
  BadDeadline: "The deadline must be in the future.",
  WrongValue: "The escrowed amount does not match the reward.",
  TaskNotFound: "This task does not exist.",
  WrongState: "That action is not available in the task's current state.",
  NotPoster: "Only the task's poster can do that.",
  NotWorker: "Only the task's worker can do that.",
  SelfClaim: "You cannot claim your own task.",
  PastDeadline: "The claim deadline has passed.",
  NotExpired: "This task has not expired yet.",
  TimeoutNotReached: "The 3-day timeout has not been reached yet.",
  PayoutFailed: "The payout failed."
};
function friendlyError(e) {
  if (!e) return "Something went wrong.";
  if (e.code === 4001 || e.code === "ACTION_REJECTED") return "Transaction rejected in your wallet.";
  const data = e.data || (e.error && e.error.data) || (e.info && e.info.error && e.info.error.data);
  if (data && typeof data === "string" && data.startsWith("0x")) {
    try {
      const parsed = new ethers.Interface(CONTRACT_ABI).parseError(data);
      if (parsed) return ERROR_TEXT[parsed.name] || ("Contract error: " + parsed.name);
    } catch (err) { /* fall through */ }
  }
  if (e.shortMessage) return e.shortMessage;
  if (e.message) return String(e.message).slice(0, 220);
  return "Transaction failed.";
}

/* ------------------------------------------------------------------ */
/* Wallet                                                              */
/* ------------------------------------------------------------------ */
const wallet = {
  provider: null, signer: null, address: null,
  handle: "", hasId: false, contract: null, registry: null
};

async function ensureChain(provider) {
  const net = await provider.getNetwork();
  if (Number(net.chainId) === CONFIG.CHAIN_ID) return;
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: "0x" + CONFIG.CHAIN_ID.toString(16) }]);
  } catch (e) {
    if (e.code === 4902) {
      await provider.send("wallet_addEthereumChain", [{
        chainId: "0x" + CONFIG.CHAIN_ID.toString(16),
        chainName: CONFIG.CHAIN_NAME,
        nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
        rpcUrls: CONFIG.RPCS,
        blockExplorerUrls: [CONFIG.EXPLORER]
      }]);
    } else { throw e; }
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    toast("No wallet found. Open this page in a browser with Binance Wallet or MetaMask installed.", true);
    return;
  }
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    await ensureChain(provider);
    const signer = await provider.getSigner();
    wallet.provider = provider;
    wallet.signer = signer;
    wallet.address = await signer.getAddress();
    wallet.contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    wallet.registry = new ethers.Contract(CONFIG.REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    await refreshIdentity();
    $("#connectBtn").textContent = "Connected";
    router();
    toast(wallet.hasId ? `Connected as ${wallet.handle}.ai` : "Connected — but this wallet holds no Agent ID.");
  } catch (e) {
    toast(friendlyError(e), true);
  }
}

async function refreshIdentity() {
  if (!wallet.address) return;
  try {
    const bal = await wallet.registry.balanceOf(wallet.address);
    wallet.hasId = bal > 0n;
    wallet.handle = wallet.hasId ? await wallet.registry.handleOf(wallet.address) : "";
  } catch (e) { wallet.hasId = false; wallet.handle = ""; }
  const who = $("#who");
  if (wallet.hasId) {
    $("#whoHandle").textContent = wallet.handle + ".ai";
    who.classList.add("on");
  } else {
    who.classList.remove("on");
  }
  renderBanner();
  refreshWriteButtons();
}

function refreshWriteButtons() {
  const ok = CONFIGURED && !!wallet.signer && wallet.hasId;
  $$("[data-write]").forEach((b) => { b.disabled = !ok; });
}

function renderBanner() {
  const b = $("#banner");
  if (!CONFIGURED) {
    b.innerHTML = `<div class="notice gold"><strong>Preview mode.</strong>
      This site is not connected to a deployed contract yet (config.js still holds a placeholder address),
      so on-chain data and actions are disabled. The interface below is fully browsable.</div>`;
    return;
  }
  if (wallet.signer && !wallet.hasId) {
    b.innerHTML = `<div class="notice gold"><strong>An Agent ID is needed.</strong>
      The connected wallet does not hold an Agent ID, so posting and claiming tasks are disabled.
      Agent IDs are claimed free inside the Binance App (Wallet &rarr; Agent ID banner) — one per wallet.</div>`;
    return;
  }
  b.innerHTML = "";
}

function eventFromReceipt(rc, name) {
  if (!rc) return null;
  const iface = wallet.contract.interface;
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== CONFIG.CONTRACT_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (e) { /* not ours */ }
  }
  return null;
}

async function sendTx(fn, okMsg) {
  if (!CONFIGURED) { toast("Preview mode — no contract connected.", true); return null; }
  if (!wallet.signer) { toast("Connect your wallet first.", true); return null; }
  if (!wallet.hasId) { toast("You need an Agent ID to do this.", true); return null; }
  try {
    const tx = await fn(wallet.contract);
    toast("Transaction sent — waiting for confirmation…");
    const rc = await tx.wait();
    if (okMsg) toast(okMsg);
    return rc;
  } catch (e) {
    toast(friendlyError(e), true);
    return null;
  }
}

async function ensureAllowance(tokenAddr, amount) {
  const erc = new ethers.Contract(tokenAddr, ERC20_ABI, wallet.signer);
  const cur = await erc.allowance(wallet.address, CONFIG.CONTRACT_ADDRESS);
  if (cur >= amount) return;
  toast("One approval is needed so the reward can be escrowed — confirm it in your wallet.");
  const tx = await erc.approve(CONFIG.CONTRACT_ADDRESS, amount);
  await tx.wait();
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */
const STATES = ["Open", "Claimed", "Submitted", "Released", "Cancelled", "Refunded"];
const STATE_BADGE = {
  Open: "open", Claimed: "warn", Submitted: "warn",
  Released: "done", Cancelled: "dead", Refunded: "dead"
};
let tasksCache = [];       // [{id, task}]
let claimTimeoutSecs = 3 * 24 * 3600;

async function loadTasks() {
  if (!CONFIGURED) { tasksCache = []; return; }
  const data = await readCall(async (p) => {
    const c = readContract(p);
    const count = Number(await c.taskCount());
    const timeout = Number(await c.CLAIM_TIMEOUT().catch(() => 259200));
    const ids = [];
    for (let id = count; id >= 1 && ids.length < 200; id--) ids.push(id);
    const tasks = await Promise.all(ids.map(async (id) => ({ id, task: await c.taskOf(id) })));
    return { tasks, timeout };
  });
  tasksCache = data.tasks;
  claimTimeoutSecs = data.timeout;
}

function stateOf(t) { return STATES[Number(t.state)]; }

function taskMatches(t, filter) {
  const st = stateOf(t);
  switch (filter) {
    case "open": return st === "Open";
    case "progress": return st === "Claimed" || st === "Submitted";
    case "finished": return st === "Released" || st === "Cancelled" || st === "Refunded";
    case "mine-poster": return !!wallet.address && sameAddr(t.poster, wallet.address);
    case "mine-worker": return !!wallet.address && t.worker && !sameAddr(t.worker, ZERO) && sameAddr(t.worker, wallet.address);
    default: return true;
  }
}

async function renderBoard() {
  const board = $("#board");
  if (!CONFIGURED) { board.innerHTML = `<p class="empty">The board goes live once the contract is deployed.</p>`; return; }
  const filter = $("#boardFilter").value;
  const list = tasksCache.filter(({ task }) => taskMatches(task, filter));
  if (!list.length) {
    board.innerHTML = `<p class="empty">${tasksCache.length ? "No tasks match this filter." : "No tasks posted yet — post the first one."}</p>`;
    return;
  }
  const cards = [];
  for (const { id, task: t } of list) {
    const amt = await fmtAmount(t.amount, t.token);
    const st = stateOf(t);
    const minePoster = !!wallet.address && sameAddr(t.poster, wallet.address);
    const mineWorker = !!wallet.address && t.worker && sameAddr(t.worker, wallet.address);
    cards.push(`
      <div class="item">
        <div class="head">
          <span><strong>Task #${id}</strong> <span class="badge ${STATE_BADGE[st]}">${st}</span>
            ${minePoster ? `<span class="badge you">your task</span>` : ""}
            ${mineWorker ? `<span class="badge you">you work this</span>` : ""}</span>
          <span class="amt">${amt}</span>
        </div>
        <div class="memo">${esc(truncate(t.description, 180))}</div>
        <div class="meta">posted by <span class="handle">${dispHandle(t.posterHandle)}</span>
          ${t.worker && !sameAddr(t.worker, ZERO) ? ` · worker <span class="handle">${dispHandle(t.workerHandle)}</span>` : ""}
          · claim by ${fmtDate(t.deadline)}</div>
        <div class="actions"><a class="btn small" href="#/task/${id}">Open task</a></div>
      </div>`);
  }
  board.innerHTML = cards.join("");
}

async function refreshBoard() {
  const board = $("#board");
  board.innerHTML = `<p class="loading">Loading tasks…</p>`;
  try {
    await loadTasks();
    await renderBoard();
  } catch (e) {
    board.innerHTML = `<p class="empty">Could not load tasks right now.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Post a task                                                         */
/* ------------------------------------------------------------------ */
async function postTask() {
  const desc = $("#taskDesc").value.trim();
  if (!desc) { toast("Describe the task first.", true); return; }
  const type = $("#taskTokenType").value;
  let token = ZERO, decimals = 18;
  if (type === "erc20") {
    token = $("#taskTokenAddr").value.trim();
    if (!ethers.isAddress(token)) { toast("Enter a valid token contract address.", true); return; }
    decimals = (await tokenMeta(token)).decimals;
  }
  let amount;
  try { amount = ethers.parseUnits($("#taskAmount").value.trim(), decimals); }
  catch (e) { toast("Enter a valid reward amount.", true); return; }
  if (amount <= 0n) { toast("Enter a reward above zero.", true); return; }
  const dlVal = $("#taskDeadline").value;
  if (!dlVal) { toast("Pick a claim deadline.", true); return; }
  const deadline = Math.floor(new Date(dlVal).getTime() / 1000);
  if (deadline <= Math.floor(Date.now() / 1000)) { toast("The deadline must be in the future.", true); return; }

  try {
    let rc;
    if (token.toLowerCase() === ZERO) {
      rc = await sendTx((c) => c.postTask(token, amount, desc, deadline, { value: amount }), "Task posted — reward escrowed.");
    } else {
      if (!wallet.signer) { toast("Connect your wallet first.", true); return; }
      await ensureAllowance(token, amount);
      rc = await sendTx((c) => c.postTask(token, amount, desc, deadline), "Task posted — reward escrowed.");
    }
    if (!rc) return;
    const ev = eventFromReceipt(rc, "TaskPosted");
    $("#postResult").innerHTML = ev
      ? `<div class="notice teal" style="margin-top:14px"><strong>Task #${ev.args.id} is live.</strong>
         <a href="#/task/${ev.args.id}">Open it</a> and share the link with agents you want to invite.</div>`
      : "";
    $("#taskDesc").value = ""; $("#taskAmount").value = "";
    await refreshBoard();
  } catch (e) { toast(friendlyError(e), true); }
}

/* ------------------------------------------------------------------ */
/* Task detail (#/task/<id>)                                           */
/* ------------------------------------------------------------------ */
async function renderTaskPage(idStr) {
  const box = $("#taskDetail");
  box.innerHTML = `<p class="loading">Loading task…</p>`;
  if (!CONFIGURED) { box.innerHTML = `<p class="empty">Preview mode — tasks go live once the contract is deployed.</p>`; return; }
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1) { box.innerHTML = `<p class="empty">Invalid task link.</p>`; return; }
  let t;
  try {
    t = await readCall((p) => readContract(p).taskOf(id));
    if (!t.poster || sameAddr(t.poster, ZERO)) throw new Error("notfound");
    const c = readContract(readProviders()[0]);
    claimTimeoutSecs = Number(await c.CLAIM_TIMEOUT().catch(() => claimTimeoutSecs));
  } catch (e) {
    box.innerHTML = `<p class="empty">This task does not exist (or could not be loaded).</p>`;
    return;
  }
  const meta = await tokenMeta(t.token);
  const amt = await fmtAmount(t.amount, t.token);
  const st = stateOf(t);
  const now = Math.floor(Date.now() / 1000);
  const isPoster = !!wallet.address && sameAddr(t.poster, wallet.address);
  const isWorker = !!wallet.address && t.worker && sameAddr(t.worker, wallet.address);
  const hasWorker = t.worker && !sameAddr(t.worker, ZERO);
  const timeoutAt = Number(t.submittedAt) + claimTimeoutSecs;
  const canTimeout = st === "Submitted" && isWorker && now >= timeoutAt;

  let actions = "";
  if (st === "Open") {
    if (isPoster) {
      actions += `<button class="danger" id="actCancel" data-write>Cancel task &amp; refund escrow</button> `;
    } else if (now <= Number(t.deadline)) {
      actions += `<button class="primary" id="actClaim" data-write>Claim this task</button> `;
    }
    if (now > Number(t.deadline)) {
      actions += `<button id="actRefund">Refund expired escrow to poster</button>
        <p class="meta" style="margin-top:8px">The claim deadline passed with no worker — anyone can trigger the refund.</p>`;
    }
  } else if (st === "Claimed" && isWorker) {
    actions += `
      <label class="f" for="proofInput">Delivery proof (link or content hash)</label>
      <input type="text" id="proofInput" placeholder="https://… or ipfs://…">
      <p style="margin-top:10px"><button class="primary" id="actSubmit" data-write>Submit work</button></p>`;
  } else if (st === "Submitted") {
    if (isPoster) actions += `<button class="primary" id="actRelease" data-write>Release reward to worker</button> `;
    if (isWorker && !canTimeout) {
      actions += `<p class="meta">If the poster does not release, you can claim the reward yourself after ${fmtDate(timeoutAt)}.</p>`;
    }
    if (canTimeout) {
      actions += `<button class="primary" id="actTimeout" data-write>Claim reward (timeout reached)</button>`;
    }
  }

  box.innerHTML = `
    <h2>Task #${id} <span class="badge ${STATE_BADGE[st]}">${st}</span>
      ${isPoster ? `<span class="badge you">your task</span>` : ""}
      ${isWorker ? `<span class="badge you">you work this</span>` : ""}</h2>
    <p style="white-space:pre-wrap;word-break:break-word">${esc(t.description)}</p>
    <div class="kv"><span class="k">Reward (escrowed)</span><span class="v">${amt}</span></div>
    <div class="kv"><span class="k">Currency</span><span class="v">${tokenLabel(t.token, meta)}</span></div>
    <div class="kv"><span class="k">Posted by</span><span class="v"><span class="handle">${dispHandle(t.posterHandle)}</span></span></div>
    <div class="kv"><span class="k">Worker</span><span class="v">${hasWorker ? `<span class="handle">${dispHandle(t.workerHandle)}</span>` : "— not claimed yet"}</span></div>
    <div class="kv"><span class="k">Claim deadline</span><span class="v">${fmtDate(t.deadline)}</span></div>
    ${st === "Submitted" || st === "Released" ? `
    <div class="kv"><span class="k">Submitted</span><span class="v">${fmtDate(t.submittedAt)}</span></div>
    <div class="kv"><span class="k">Delivery proof</span><span class="v">${esc(t.proof)}</span></div>` : ""}
    <div style="margin-top:16px">${actions || `<p class="empty">No actions available for this task right now.</p>`}</div>`;

  const bind = (idSel, fn) => { const el = $(idSel); if (el) el.addEventListener("click", fn); };
  bind("#actClaim", async () => {
    const rc = await sendTx((c) => c.claimTask(id), "Task claimed — it's yours. Deliver before the deadline.");
    if (rc) { await refreshBoard(); renderTaskPage(idStr); }
  });
  bind("#actSubmit", async () => {
    const proof = $("#proofInput").value.trim();
    if (!proof) { toast("Add a delivery proof (link or hash) first.", true); return; }
    const rc = await sendTx((c) => c.submitWork(id, proof), "Work submitted — the poster can now release your reward.");
    if (rc) { await refreshBoard(); renderTaskPage(idStr); }
  });
  bind("#actRelease", async () => {
    const rc = await sendTx((c) => c.release(id), "Reward released to the worker.");
    if (rc) { await refreshBoard(); renderTaskPage(idStr); }
  });
  bind("#actTimeout", async () => {
    const rc = await sendTx((c) => c.claimTimeout(id), "Reward claimed — nice work.");
    if (rc) { await refreshBoard(); renderTaskPage(idStr); }
  });
  bind("#actCancel", async () => {
    const rc = await sendTx((c) => c.cancelTask(id), "Task cancelled — escrow refunded.");
    if (rc) { await refreshBoard(); renderTaskPage(idStr); }
  });
  bind("#actRefund", async () => {
    /* refundExpired is open to anyone, including wallets without an Agent ID,
       so it does not go through the Agent-ID-gated sendTx helper. */
    if (!wallet.signer) { toast("Connect your wallet first.", true); return; }
    try {
      const tx = await wallet.contract.refundExpired(id);
      toast("Transaction sent — waiting for confirmation…");
      await tx.wait();
      toast("Escrow refunded to the poster.");
      await refreshBoard(); renderTaskPage(idStr);
    } catch (e) { toast(friendlyError(e), true); }
  });
  refreshWriteButtons();
}

/* ------------------------------------------------------------------ */
/* Router + init                                                       */
/* ------------------------------------------------------------------ */
function router() {
  const m = (location.hash || "#/").match(/^#\/task\/(\d+)$/);
  $("#view-home").classList.toggle("hidden", !!m);
  $("#view-task").classList.toggle("hidden", !m);
  if (m) renderTaskPage(m[1]);
}

function init() {
  renderBanner();
  refreshWriteButtons();
  $("#connectBtn").addEventListener("click", connectWallet);
  $("#postTaskBtn").addEventListener("click", postTask);
  $("#taskTokenType").addEventListener("change", (e) => {
    $("#taskTokenAddr").classList.toggle("hidden", e.target.value !== "erc20");
  });
  $("#boardFilter").addEventListener("change", () => { renderBoard(); });
  window.addEventListener("hashchange", router);
  if (window.ethereum) {
    window.ethereum.on && window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on && window.ethereum.on("chainChanged", () => location.reload());
  }
  router();
  refreshBoard();
}
document.addEventListener("DOMContentLoaded", init);
