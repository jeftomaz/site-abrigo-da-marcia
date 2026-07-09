// Controller da tela de Sorteio (módulo ES). Portado da IIFE embutida em
// pages/admin/sorteio.html sem mudar o comportamento: globais viraram imports
// (core/* + camada de dados) e as queries saíram para os repositórios.
import { requireAdminSession } from '../core/auth.js';
import { esc } from '../core/dom.js';
import { normalizeRafflePrizes, prizeDisplayName } from '../core/raffle-prizes.js';
import * as Events from '../data/events.js';
import * as Reservations from '../data/reservations.js';

let raffles      = [];     // rifas elegíveis (ativo/encerrado)
let currentEvent = null;
let selectedPrizeIndex = 0;
let pool         = [];     // [{number, firstName}] — números pagos
let drawn        = null;   // resultado sorteado ainda não confirmado
let spinning     = false;

// Ícone de dado (stroke em currentColor: acompanha a cor do botão)
const DICE_SVG =
    '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4Z" stroke="currentColor" stroke-width="1.5"></path>' +
    '<path d="M7.5 8C7.22386 8 7 7.77614 7 7.5C7 7.22386 7.22386 7 7.5 7C7.77614 7 8 7.22386 8 7.5C8 7.77614 7.77614 8 7.5 8Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
    '<path d="M12 12.5C11.7239 12.5 11.5 12.2761 11.5 12C11.5 11.7239 11.7239 11.5 12 11.5C12.2761 11.5 12.5 11.7239 12.5 12C12.5 12.2761 12.2761 12.5 12 12.5Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
    '<path d="M16.5 17C16.2239 17 16 16.7761 16 16.5C16 16.2239 16.2239 16 16.5 16C16.7761 16 17 16.2239 17 16.5C17 16.7761 16.7761 17 16.5 17Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

// Ícone de check do selo "Resultado confirmado"
const CHECK_SVG =
    '<svg class="icon-check" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M7 12.5L10 15.5L17 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
    '<path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

// Ícone de presente exibido junto ao ganhador
const GIFT_SVG =
    '<svg class="icon-gift" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M20 12V21.4C20 21.7314 19.7314 22 19.4 22H4.6C4.26863 22 4 21.7314 4 21.4V12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
    '<path d="M21.4 7H2.6C2.26863 7 2 7.26863 2 7.6V11.4C2 11.7314 2.26863 12 2.6 12H21.4C21.7314 12 22 11.7314 22 11.4V7.6C22 7.26863 21.7314 7 21.4 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
    '<path d="M12 22V7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
    '<path d="M12 7H7.5C6.83696 7 6.20107 6.73661 5.73223 6.26777C5.26339 5.79893 5 5.16304 5 4.5C5 3.83696 5.26339 3.20107 5.73223 2.73223C6.20107 2.26339 6.83696 2 7.5 2C11 2 12 7 12 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
    '<path d="M12 7H16.5C17.163 7 17.7989 6.73661 18.2678 6.26777C18.7366 5.79893 19 5.16304 19 4.5C19 3.83696 18.7366 3.20107 18.2678 2.73223C17.7989 2.26339 17.163 2 16.5 2C13 2 12 7 12 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

// esc() vem de core/dom.js.
function firstName(full) {
    return String(full || '').trim().split(/\s+/)[0] || '';
}
// Sorteio uniforme com gerador criptográfico
function pickRandom(list) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return list[buf[0] % list.length];
}

function currentPrizes() {
    return normalizeRafflePrizes(currentEvent || {});
}

function currentPrize() {
    return currentPrizes()[selectedPrizeIndex] || null;
}

function winnerNumbersExceptSelected() {
    return currentPrizes().map(function(prize, i) {
        return i === selectedPrizeIndex ? null : prize.winner_number;
    }).filter(function(n) { return n != null; });
}

function availablePool() {
    const blocked = winnerNumbersExceptSelected();
    return pool.filter(function(entry) { return blocked.indexOf(entry.number) === -1; });
}

function firstPrizeWithoutWinner(prizes) {
    const idx = prizes.findIndex(function(prize) { return prize.winner_number == null; });
    return idx === -1 ? 0 : idx;
}

// ── Auth guard ──────────────────────────────────────────
async function init() {
    // requireAdminSession (core/auth.js): valida sessão + AAL2
    if (!await requireAdminSession()) return;
    await loadRaffles();
    bindEvents();
}

// ── Rifas disponíveis ───────────────────────────────────
async function loadRaffles() {
    const { data, error } = await Events.listRaffles();

    const select = document.getElementById('event-select');
    if (error) {
        select.innerHTML = '<option value="">Erro: ' + esc(error.message) + '</option>';
        return;
    }
    raffles = data || [];
    if (!raffles.length) {
        select.innerHTML = '<option value="">Nenhuma rifa ativa ou encerrada</option>';
        setStageMessage('Nenhuma rifa para sortear', 'Crie e ative uma rifa no painel de eventos.');
        return;
    }
    select.innerHTML = raffles.map(function(ev) {
        return '<option value="' + ev.id + '">' + esc(ev.name) + ' (' + ev.status + ')</option>';
    }).join('');
    // Pré-seleciona a rifa indicada na URL (?event=ID), vinda do botão
    // "Sortear" do evento; senão, a mais recente.
    const wanted = new URLSearchParams(location.search).get('event');
    const initial = (wanted && raffles.some(function(e) { return e.id === wanted; })) ? wanted : raffles[0].id;
    selectEvent(initial);
}

async function selectEvent(id) {
    currentEvent = raffles.find(e => e.id === id) || null;
    drawn = null;
    if (!currentEvent) return;
    document.getElementById('event-select').value = id;
    document.getElementById('stage-event-name').textContent = currentEvent.name;
    selectedPrizeIndex = firstPrizeWithoutWinner(currentPrizes());
    renderPrizeOptions();
    await loadPool();
    renderStage();
}

function renderPrizeOptions() {
    const select = document.getElementById('prize-select');
    const prizes = currentPrizes();
    if (!prizes.length) {
        select.innerHTML = '<option value="">Nenhum prêmio cadastrado</option>';
        select.disabled = true;
        selectedPrizeIndex = 0;
        return;
    }
    if (selectedPrizeIndex < 0 || selectedPrizeIndex >= prizes.length) selectedPrizeIndex = 0;
    select.disabled = false;
    select.innerHTML = prizes.map(function(prize, i) {
        const status = prize.winner_number ? ' — nº ' + prize.winner_number : '';
        return '<option value="' + i + '">' + esc(prizeDisplayName(prize, i)) + status + '</option>';
    }).join('');
    select.value = String(selectedPrizeIndex);
}

// ── Números elegíveis (status pago ou entregue) ─────────
async function loadPool() {
    document.getElementById('stage-pool').textContent = 'Carregando números…';
    const { data, error } = await Reservations.listPaidRaffleNumbers(currentEvent.id);

    if (error) {
        pool = [];
        showAlert('Erro ao carregar números: ' + error.message);
        return;
    }
    pool = (data || []).map(function(it) {
        return { number: it.raffle_number, firstName: firstName(it.reservation.customer_name) };
    }).sort(function(a, b) { return a.number - b.number; });
}

// ── Renderização do palco ───────────────────────────────
function setStageMessage(title, hint) {
    document.getElementById('stage-event-name').textContent = title;
    document.getElementById('stage-prize').textContent = '';
    document.getElementById('prize-select').innerHTML = '<option value="">Prêmios…</option>';
    document.getElementById('prize-select').disabled = true;
    document.getElementById('stage-pool').textContent = '';
    document.getElementById('stage-winner').textContent = '';
    document.getElementById('stage-actions').innerHTML = '';
    document.getElementById('stage-hint').textContent = hint || '';
}

function renderStage() {
    if (!currentEvent) return;
    hideAlert();
    renderPrizeOptions();
    const prize = currentPrize();
    const drawPool = availablePool();
    const circle  = document.getElementById('number-circle');
    const numberEl = document.getElementById('stage-number');
    const winnerEl = document.getElementById('stage-winner');
    const actions  = document.getElementById('stage-actions');
    const hint     = document.getElementById('stage-hint');
    const poolEl   = document.getElementById('stage-pool');
    const prizeEl  = document.getElementById('stage-prize');

    if (prize) {
        prizeEl.innerHTML =
            (prize.image_url ? '<img src="' + esc(prize.image_url) + '" alt="">' : '') +
            '<span>Prêmio: ' + esc(prizeDisplayName(prize, selectedPrizeIndex)) + '</span>';
    } else {
        prizeEl.textContent = '';
    }

    poolEl.textContent = drawPool.length
        ? drawPool.length + ' número' + (drawPool.length !== 1 ? 's' : '') + ' pago' + (drawPool.length !== 1 ? 's' : '') + ' participando'
        : (pool.length ? 'Nenhum número elegível restante para este prêmio' : 'Nenhum número pago ainda');
    circle.classList.remove('spinning', 'winner');

    if (!prize) {
        numberEl.textContent = '?';
        winnerEl.textContent = '';
        actions.innerHTML = '';
        hint.textContent = 'Cadastre ao menos um prêmio nesta rifa antes de sortear.';
        return;
    }

    // Estado 1: resultado já confirmado no banco
    if (prize.winner_number != null && !drawn) {
        const entry = pool.find(p => p.number === prize.winner_number);
        circle.classList.add('winner');
        numberEl.textContent = prize.winner_number;
        winnerEl.innerHTML = entry
            ? 'Parabéns, <strong>' + esc(entry.firstName) + '</strong>! ' + GIFT_SVG
            : '';
        actions.innerHTML =
            '<span class="confirmed-tag">' + CHECK_SVG + ' Resultado confirmado</span>' +
            '<button class="btn btn-ghost" id="redo-btn">Refazer sorteio</button>';
        hint.textContent = 'O número sorteado já aparece na página pública de eventos.';
        return;
    }

    // Estado 2: sorteado nesta tela, aguardando confirmação
    if (drawn) {
        circle.classList.add('winner');
        numberEl.textContent = drawn.number;
        winnerEl.innerHTML = 'Parabéns, <strong>' + esc(drawn.firstName) + '</strong>! ' + GIFT_SVG;
        actions.innerHTML =
            '<button class="btn btn-gold btn-big" id="confirm-btn">Confirmar resultado</button>' +
            '<button class="btn btn-ghost" id="draw-btn">Sortear novamente</button>';
        hint.textContent = 'Confirme para publicar o ganhador na página de eventos, ou sorteie novamente.';
        return;
    }

    // Estado 3: pronto para sortear
    numberEl.textContent = '?';
    winnerEl.textContent = '';
    if (drawPool.length) {
        actions.innerHTML = '<button class="btn btn-primary btn-big" id="draw-btn">Sortear ' + DICE_SVG + '</button>';
        hint.textContent = 'Somente números com pagamento confirmado (Pago ou Entregue) participam.';
    } else {
        actions.innerHTML = '';
        hint.textContent = pool.length
            ? 'Os números vencedores de outros prêmios não participam novamente.'
            : 'Marque reservas como "Pago" no painel de eventos para liberar o sorteio.';
    }
}

// ── Animação da roleta ──────────────────────────────────
function spin() {
    const drawPool = availablePool();
    if (spinning || !drawPool.length) return;
    spinning = true;
    drawn = null;
    hideAlert();

    const result   = pickRandom(drawPool);
    const circle   = document.getElementById('number-circle');
    const numberEl = document.getElementById('stage-number');
    document.getElementById('stage-winner').textContent = '';
    document.getElementById('stage-actions').innerHTML = '';
    document.getElementById('stage-hint').textContent = '';
    circle.classList.remove('winner');
    circle.classList.add('spinning');

    // gira ~5s, desacelerando até revelar o resultado
    const start = Date.now();
    const DURATION = 5000;
    (function tick() {
        const elapsed = Date.now() - start;
        if (elapsed >= DURATION) {
            spinning = false;
            drawn = result;
            circle.classList.remove('spinning');
            launchConfetti();
            renderStage();
            return;
        }
        numberEl.textContent = pickRandom(drawPool).number;
        // intervalo cresce de 50ms até ~350ms no fim
        const t = elapsed / DURATION;
        setTimeout(tick, 50 + 300 * t * t);
    })();
}

// ── Confirmar / refazer ─────────────────────────────────
async function confirmResult() {
    if (!drawn) return;
    const btn = document.getElementById('confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
    const prizes = currentPrizes();
    if (!prizes[selectedPrizeIndex]) return;
    prizes[selectedPrizeIndex].winner_number = drawn.number;
    const { error } = await Events.updateEvent(currentEvent.id, {
        raffle_prizes: prizes,
        raffle_prize: prizes[0] ? prizes[0].name : null,
        raffle_winner_number: prizes[0] ? prizes[0].winner_number : null
    });
    if (error) {
        showAlert('Erro ao salvar: ' + error.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Confirmar resultado'; }
        return;
    }
    currentEvent.raffle_prizes = prizes;
    currentEvent.raffle_prize = prizes[0] ? prizes[0].name : null;
    currentEvent.raffle_winner_number = prizes[0] ? prizes[0].winner_number : null;
    drawn = null;
    renderStage();
}

async function redoDraw() {
    const ok = window.confirm(
        'Refazer o sorteio? O resultado atual será removido da página pública até você confirmar um novo número.'
    );
    if (!ok) return;
    const prizes = currentPrizes();
    if (!prizes[selectedPrizeIndex]) return;
    prizes[selectedPrizeIndex].winner_number = null;
    const { error } = await Events.updateEvent(currentEvent.id, {
        raffle_prizes: prizes,
        raffle_prize: prizes[0] ? prizes[0].name : null,
        raffle_winner_number: prizes[0] ? prizes[0].winner_number : null
    });
    if (error) { showAlert('Erro: ' + error.message); return; }
    currentEvent.raffle_prizes = prizes;
    currentEvent.raffle_prize = prizes[0] ? prizes[0].name : null;
    currentEvent.raffle_winner_number = prizes[0] ? prizes[0].winner_number : null;
    drawn = null;
    renderStage();
}

// ── Confete 🎉 ──────────────────────────────────────────
function launchConfetti() {
    const colors = ['#F15A55', '#FFAD28', '#4ade80', '#60a5fa', '#F6F6F6'];
    for (let i = 0; i < 50; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti';
        piece.style.left = (Math.random() * 100) + 'vw';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDuration = (2.5 + Math.random() * 2) + 's';
        piece.style.animationDelay = (Math.random() * 0.6) + 's';
        document.body.appendChild(piece);
        setTimeout(function() { piece.remove(); }, 5500);
    }
}

// ── Alertas ─────────────────────────────────────────────
function showAlert(msg) {
    const el = document.getElementById('stage-alert');
    el.textContent = msg;
    el.classList.add('show');
}
function hideAlert() {
    document.getElementById('stage-alert').classList.remove('show');
}

// ── Eventos da UI ───────────────────────────────────────
function bindEvents() {
    document.getElementById('event-select').addEventListener('change', function() {
        if (this.value) selectEvent(this.value);
    });
    document.getElementById('prize-select').addEventListener('change', function() {
        selectedPrizeIndex = Number(this.value) || 0;
        drawn = null;
        renderStage();
    });
    document.getElementById('reload-btn').addEventListener('click', async function() {
        if (!currentEvent || spinning) return;
        await loadPool();
        renderStage();
    });
    document.getElementById('hide-controls-btn').addEventListener('click', function() {
        document.body.classList.add('presentation');
    });
    document.getElementById('show-controls-btn').addEventListener('click', function() {
        document.body.classList.remove('presentation');
    });
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') document.body.classList.remove('presentation');
    });
    // delegação dos botões do palco (são recriados a cada render)
    document.getElementById('stage-actions').addEventListener('click', function(e) {
        if (e.target.closest('#draw-btn'))    spin();
        if (e.target.closest('#confirm-btn')) confirmResult();
        if (e.target.closest('#redo-btn'))    redoDraw();
    });
}

init();
