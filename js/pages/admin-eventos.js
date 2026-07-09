// Controller da tela Admin · Eventos (módulo ES). Portado da IIFE embutida em
// pages/admin/eventos.html sem mudar o comportamento: globais viraram imports
// (core/* + config + ui/* + camada de dados data/events.js e data/reservations.js)
// e toda query/RPC/Storage saiu para os repositórios. Imports são relativos a
// ESTE arquivo.
import { sb } from '../core/supabase.js';
import { requireAdminSession } from '../core/auth.js';
import { esc, slugify, formatMoney, formatDate } from '../core/dom.js';
import { ICON_LABEL_SVG } from '../core/icons.js';
import { compressImage } from '../core/image.js';
import { MAX_RAFFLE_PRIZES, emptyRafflePrize, normalizeRafflePrizes } from '../core/raffle-prizes.js';
import { adminToast } from '../ui/toast.js';
import { MAX_PHOTOS, PIX_DEFAULTS, STATUS_LABEL, EVENT_STATUS_LABEL } from '../config.js';
import * as Events from '../data/events.js';
import * as Reservations from '../data/reservations.js';

// Ícone de etiqueta para eventos sem capa (currentColor segue o tema)
const ICON_LABEL = ICON_LABEL_SVG;

let allEvents     = [];
let editingEventId = null;
let coverItem     = { url: null, file: null };   // capa do evento
let photoItems    = [];                           // galeria: {url,file,preview}
let rafflePrizeItems = [];                        // rifa: {name,image_url,file,preview,winner_number}

let currentEvent  = null;                         // evento selecionado p/ reservas
let allReservations = [];                         // reservas do evento atual (com itens)
let editingReservationId = null;
let confirmCallback = null;

let eventProducts = [];                           // produtos do evento atual (tela de reservas)
// Produtos editados dentro do modal do evento (venda):
let formProductImages = {};                       // estado por card: { [pid]: { images:[{url,file,preview}], sizeImage:{url,file,preview}|null } }
let loadedProductIds = [];                        // ids dos produtos já no banco (p/ diff de remoção)
let pidCounter = 0;

// ── Auth guard ──────────────────────────────────────────
async function init() {
    // requireAdminSession (core/auth.js): valida sessão + AAL2 e preenche #admin-email
    if (!await requireAdminSession()) return;
    await loadEvents();
    bindGlobal();
}

document.getElementById('logout-btn').addEventListener('click', async function() {
    await sb.auth.signOut();
    window.location.href = 'login.html';
});

// ════════════ EVENTOS ════════════
async function loadEvents() {
    const { data, error } = await Events.listEvents();
    if (error) { showEventsError(error.message); return; }
    allEvents = data || [];
    renderEventsTable();
    renderEventStats();
    if (currentEvent) {
        const fresh = allEvents.find(e => e.id === currentEvent.id);
        if (fresh) currentEvent = fresh;
    }
}

function renderEventStats() {
    document.getElementById('stat-total').textContent = allEvents.length;
    const active = allEvents.find(e => e.status === 'ativo');
    document.getElementById('stat-active').textContent = active ? active.name : '—';
}

function renderEventsTable() {
    const tbody = document.getElementById('events-tbody');
    tbody.innerHTML = '';
    if (!allEvents.length) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="6">Nenhum evento cadastrado.</td></tr>';
        return;
    }
    // IDs no histórico público: encerrados/arquivados, 3 mais recentes por
    // ends_at desc (mesma regra do público). Arquivados fora disso podem ser
    // removidos por completo (registro + imagens) para liberar espaço.
    const publicHistoryIds = new Set(
        allEvents.filter(function(e) { return e.status === 'encerrado' || e.status === 'arquivado'; })
            .sort(function(a, b) { return String(b.ends_at || '').localeCompare(String(a.ends_at || '')); })
            .slice(0, 3).map(function(e) { return e.id; })
    );
    allEvents.forEach(function(ev) {
        const tr = document.createElement('tr');
        tr.innerHTML =
            '<td>' +
                (ev.cover_url
                    ? '<img class="dog-thumb" src="' + esc(ev.cover_url) + '" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
                    : '') +
                '<div class="dog-no-img" style="display:' + (ev.cover_url ? 'none' : 'flex') + '">' + ICON_LABEL + '</div>' +
            '</td>' +
            '<td><strong>' + esc(ev.name) + '</strong></td>' +
            '<td>' + (ev.type === 'rifa' ? 'Rifa' : 'Venda') + '</td>' +
            '<td>' + formatDate(ev.starts_at) + '<br>' + formatDate(ev.ends_at) + '</td>' +
            '<td><span class="badge badge-' + ev.status + '">' + EVENT_STATUS_LABEL[ev.status] + '</span>' +
                // Selos de auditoria: reaberto p/ correção e/ou dados pessoais limpos (LGPD)
                (ev.reopened_at ? '<br><small class="muted-hint" title="Reservas reabertas para correção após o arquivamento">Reaberto ' + formatDate(ev.reopened_at) + '</small>' : '') +
                (ev.summary && ev.summary.purged_at ? '<br><small class="muted-hint" title="Dados pessoais removidos (LGPD)">Dados limpos ' + formatDate(ev.summary.purged_at) + '</small>' : '') +
                (ev.status === 'arquivado' && !publicHistoryIds.has(ev.id) ? '<br><small class="muted-hint" title="Fora dos 3 mais recentes do histórico público — pode ser removido para liberar espaço">Fora do histórico</small>' : '') +
            '</td>' +
            '<td><div class="actions">' + eventActions(ev) + '</div></td>';
        tbody.appendChild(tr);
    });
}

function eventActions(ev) {
    let html = '';
    if (ev.status === 'rascunho')  html += '<button class="btn btn-success btn-sm js-ev-status" data-id="' + ev.id + '" data-to="ativo">Ativar</button>';
    if (ev.status === 'ativo')     html += '<button class="btn btn-warning btn-sm js-ev-status" data-id="' + ev.id + '" data-to="encerrado">Encerrar</button>';
    if (ev.status === 'encerrado') {
        html += '<button class="btn btn-success btn-sm js-ev-status" data-id="' + ev.id + '" data-to="ativo">Reativar</button>';
        html += '<button class="btn btn-secondary btn-sm js-ev-status" data-id="' + ev.id + '" data-to="arquivado">Arquivar</button>';
    }
    // Arquivado = histórico congelado. Para corrigir algo é preciso reabrir
    // (volta a "encerrado"); a reabertura fica registrada em reopened_at.
    if (ev.status === 'arquivado') {
        html += '<button class="btn btn-warning btn-sm js-ev-status" data-id="' + ev.id + '" data-to="encerrado">Reabrir p/ correção</button>';
        // Limpeza LGPD: some depois de limpo (summary preenchido pelo purge).
        if (!ev.summary)
            html += '<button class="btn btn-danger btn-sm js-ev-purge" data-id="' + ev.id + '">Limpar dados</button>';
    }
    // Sortear: leva à tela de sorteio já vinculada a esta rifa (só rifa ativa/encerrada).
    if (ev.type === 'rifa' && (ev.status === 'ativo' || ev.status === 'encerrado'))
        html += '<a class="btn btn-secondary btn-sm" href="sorteio.html?event=' + ev.id + '">Sortear</a>';
    html += '<button class="btn btn-primary btn-sm js-ev-reservations" data-id="' + ev.id + '">Reservas</button>';
    // Editar fica indisponível no arquivado (registro congelado) — reabra para editar.
    if (ev.status !== 'arquivado')
        html += '<button class="btn btn-edit btn-sm js-ev-edit" data-id="' + ev.id + '">Editar</button>';
    if (ev.status === 'rascunho' || ev.status === 'arquivado')
        html += '<button class="btn btn-danger btn-sm js-ev-delete" data-id="' + ev.id + '">Remover</button>';
    return html;
}

function showEventsError(msg) {
    document.getElementById('events-tbody').innerHTML =
        '<tr class="loading-row"><td colspan="6">Erro: ' + esc(msg) + '</td></tr>';
}

// ── Delegação de ações da tabela de eventos ─────────────
document.getElementById('events-tbody').addEventListener('click', function(e) {
    const t = e.target;
    const editB = t.closest('.js-ev-edit');
    const delB  = t.closest('.js-ev-delete');
    const stB   = t.closest('.js-ev-status');
    const resB  = t.closest('.js-ev-reservations');
    const purgeB = t.closest('.js-ev-purge');

    if (editB) {
        const ev = allEvents.find(x => x.id === editB.dataset.id);
        if (ev) openEventModal(ev);
    } else if (delB) {
        const ev = allEvents.find(x => x.id === delB.dataset.id);
        if (ev) confirmDeleteEvent(ev);
    } else if (stB) {
        const ev = allEvents.find(x => x.id === stB.dataset.id);
        if (ev) confirmStatusChange(ev, stB.dataset.to);
    } else if (resB) {
        const ev = allEvents.find(x => x.id === resB.dataset.id);
        if (ev) openReservations(ev);
    } else if (purgeB) {
        const ev = allEvents.find(x => x.id === purgeB.dataset.id);
        if (ev) startPurgeFlow(ev);
    }
});

function confirmStatusChange(ev, to) {
    // Reabertura de evento arquivado (arquivado → encerrado): texto e registro
    // próprios — descongela o histórico para uma correção deliberada.
    if (ev.status === 'arquivado' && to === 'encerrado') {
        askConfirm('Reabrir para correção',
            'Reabrir "' + ev.name + '" para corrigir reservas? Ele volta a "Encerrado" e o histórico deixa de ficar congelado. A reabertura fica registrada na data de hoje.',
            function() { return changeEventStatus(ev.id, to, { reopened: true }); });
        return;
    }
    const msgs = {
        ativo:     'Tornar "' + ev.name + '" o evento ativo? (apenas um evento pode estar ativo por vez)',
        encerrado: 'Encerrar "' + ev.name + '"? Ele deixa de receber novas reservas.',
        arquivado: 'Arquivar "' + ev.name + '"? Continua visível no histórico público; as reservas ficam somente-leitura.'
    };
    askConfirm('Alterar status', msgs[to] || 'Confirmar?', function() {
        return changeEventStatus(ev.id, to);
    });
}

async function changeEventStatus(id, to, opts) {
    const payload = { status: to };
    // Registra a reabertura de um evento arquivado (correção pós-encerramento).
    if (opts && opts.reopened) payload.reopened_at = new Date().toISOString();
    const { error } = await Events.updateEvent(id, payload);
    if (error) {
        if (/events_um_ativo/.test(error.message))
            return Promise.reject(new Error('Já existe um evento ativo. Encerre-o antes de ativar outro.'));
        return Promise.reject(error);
    }
    await loadEvents();
    // Reflete a troca de status na seção de reservas aberta: atualiza o
    // currentEvent (status novo) e re-renderiza contexto + linhas (lock).
    if (currentEvent && currentEvent.id === id) {
        currentEvent = allEvents.find(function(x) { return x.id === id; }) || currentEvent;
        refreshReservationContext();
        renderReservations();
    }
}

// Remoção completa de um evento (registro + reservas em cascata + imagens do
// Storage), com backup CSV prévio das reservas. Usado tanto para rascunhos
// quanto para arquivados "fora do histórico" (retenção/LGPD + economia).
async function confirmDeleteEvent(ev) {
    const { data } = await Reservations.listReservations(ev.id);
    const reservations = data || [];
    if (reservations.length) downloadReservationsCsv(ev, reservations);  // backup imediato
    const extra = reservations.length
        ? ' O backup CSV (' + reservations.length + ' reserva(s)) foi baixado agora.' : '';
    askConfirm('Remover evento?',
        'Remover "' + ev.name + '" — registro, reservas e imagens — permanentemente?' + extra +
        ' Esta ação não pode ser desfeita.',
        function() { return deleteEvent(ev.id); });
}

// Apaga as imagens do evento (capa + galeria) do bucket event-photos.
// Tolerante a falhas: um erro de Storage não impede a remoção do registro.
async function removeEventPhotos(ev) {
    const urls = [];
    if (ev.cover_url) urls.push(ev.cover_url);
    (ev.gallery || []).forEach(function(u) { if (u) urls.push(u); });
    normalizeRafflePrizes(ev).forEach(function(prize) {
        if (prize.image_url) urls.push(prize.image_url);
    });
    const marker = '/event-photos/';
    const paths = urls.map(function(u) {
        const i = u.indexOf(marker);
        return i === -1 ? null : decodeURIComponent(u.slice(i + marker.length));
    }).filter(Boolean);
    if (!paths.length) return;
    try { await Events.removeStoredImages(paths); }
    catch (e) { console.warn('Falha ao remover imagens do Storage:', e); }
}

async function deleteEvent(id) {
    const ev = allEvents.find(function(x) { return x.id === id; });
    if (ev) await removeEventPhotos(ev);   // limpa o Storage antes (evita órfãos)
    const { error } = await Events.deleteEvent(id);
    if (error) return Promise.reject(error);
    if (currentEvent && currentEvent.id === id) closeReservations();
    await loadEvents();
}

// ── Modal de evento ─────────────────────────────────────
document.getElementById('add-event-btn').addEventListener('click', function() { openEventModal(null); });

function toggleTypeFields() {
    const type = document.getElementById('ev-type').value;
    document.getElementById('ev-raffle-fields').style.display    = type === 'rifa'  ? '' : 'none';
    document.getElementById('ev-products-section').style.display = type === 'venda' ? '' : 'none';
    if (type === 'rifa' && !rafflePrizeItems.length) {
        rafflePrizeItems = [emptyRafflePrize()];
        renderRafflePrizes();
    }
    // Venda exige ≥1 produto: garante um card inicial.
    if (type === 'venda' && !document.querySelector('#ev-products-list .ev-product-card'))
        addProductCard(null);
}
document.getElementById('ev-type').addEventListener('change', toggleTypeFields);

// ── Valor por número sugerido (meta ÷ quantidade) ───────
// O preenchimento automático só acontece quando META ou
// QUANTIDADE mudam — nunca enquanto o admin digita/apaga no
// próprio campo de valor (apagar com backspace funciona).
// O valor manual prevalece e não altera meta nem quantidade.
let lastAutoPrice = null;

function suggestedPrice() {
    const goal  = parseFloat(document.getElementById('ev-goal').value);
    const total = parseInt(document.getElementById('ev-raffle-total').value, 10);
    if (!(goal > 0) || !(total > 0)) return null;
    return Math.round((goal / total) * 100) / 100;
}

function updatePriceHint() {
    const hint      = document.getElementById('ev-price-hint');
    const input     = document.getElementById('ev-raffle-price');
    const suggested = suggestedPrice();
    if (suggested === null) { hint.textContent = ''; return; }
    const current = input.value === '' ? null : Number(input.value);
    if (current !== null && current !== suggested) {
        hint.textContent = 'Valor definido manualmente — sugerido pela meta: ' + formatMoney(suggested) + '.';
    } else {
        hint.textContent = 'Calculado pela meta ÷ números (' + formatMoney(suggested) + '). Ajuste se quiser.';
    }
}

function autoFillPrice() {
    const input     = document.getElementById('ev-raffle-price');
    const suggested = suggestedPrice();
    if (suggested !== null) {
        const current = input.value === '' ? null : Number(input.value);
        // só sobrescreve se o campo está vazio ou ainda segue o cálculo
        if (current === null || current === lastAutoPrice) {
            input.value = suggested.toFixed(2);
            lastAutoPrice = suggested;
        }
    }
    updatePriceHint();
}

document.getElementById('ev-goal').addEventListener('input', autoFillPrice);
document.getElementById('ev-raffle-total').addEventListener('input', autoFillPrice);
document.getElementById('ev-raffle-price').addEventListener('input', function() {
    lastAutoPrice = null;   // digitou/apagou: o valor passa a ser do admin
    updatePriceHint();
});

async function openEventModal(ev) {
    editingEventId = ev ? ev.id : null;
    document.getElementById('ev-modal-title').textContent = ev ? 'Editar evento' : 'Novo evento';
    document.getElementById('ev-form-alert').className = 'alert';

    document.getElementById('ev-id').value          = ev ? ev.id : '';
    document.getElementById('ev-type').value         = ev ? ev.type : 'rifa';
    document.getElementById('ev-name').value         = ev ? ev.name : '';
    document.getElementById('ev-description').value  = ev && ev.description ? ev.description : '';
    document.getElementById('ev-starts').value       = ev ? (ev.starts_at || '').slice(0,10) : '';
    document.getElementById('ev-ends').value         = ev ? (ev.ends_at || '').slice(0,10) : '';
    document.getElementById('ev-goal').value         = ev && ev.goal_amount != null ? ev.goal_amount : '';
    document.getElementById('ev-raffle-total').value = ev && ev.raffle_total_numbers != null ? ev.raffle_total_numbers : '';
    document.getElementById('ev-raffle-price').value = ev && ev.raffle_number_price != null ? ev.raffle_number_price : '';
    document.getElementById('ev-raffle-max').value   = ev && ev.raffle_max_per_reservation != null ? ev.raffle_max_per_reservation : 5;
    // PIX: pré-preenche com os dados padrão do abrigo (PIX_DEFAULTS, em config.js)
    // quando o evento não tem valor próprio — admin pode editar.
    document.getElementById('ev-pix-key').value      = (ev && ev.pix_key) || PIX_DEFAULTS.key;
    document.getElementById('ev-pix-name').value     = (ev && ev.pix_merchant_name) || PIX_DEFAULTS.name;
    document.getElementById('ev-pix-city').value     = (ev && ev.pix_merchant_city) || PIX_DEFAULTS.city;
    document.getElementById('ev-pix-payload').value  = ev && ev.pix_payload ? ev.pix_payload : '';
    document.getElementById('ev-pay-instructions').value = ev && ev.payment_instructions ? ev.payment_instructions : '';

    // capa
    coverItem = { url: ev && ev.cover_url ? ev.cover_url : null, file: null };
    renderCover();
    document.getElementById('ev-cover-file').value = '';

    // galeria
    photoItems = (ev && ev.gallery ? ev.gallery : []).map(function(url) {
        return { url: url, file: null, preview: url };
    });
    renderPhotos();
    document.getElementById('ev-photos-file').value = '';

    rafflePrizeItems = (ev && ev.type === 'rifa' ? normalizeRafflePrizes(ev) : [])
        .map(function(item) {
            return {
                name: item.name,
                image_url: item.image_url,
                file: null,
                preview: item.image_url,
                winner_number: item.winner_number
            };
        });
    if ((!ev || (ev && ev.type === 'rifa')) && !rafflePrizeItems.length)
        rafflePrizeItems = [emptyRafflePrize()];
    renderRafflePrizes();

    // produtos (venda): carrega os existentes ao editar
    document.getElementById('ev-products-list').innerHTML = '';
    formProductImages = {};
    loadedProductIds = [];
    if (ev && ev.type === 'venda') await loadProductsIntoForm(ev.id);

    lastAutoPrice = null;
    updatePriceHint();
    toggleTypeFields();   // se venda e lista vazia, cria 1 card
    document.getElementById('event-modal').classList.add('open');
}

function closeEventModal() {
    document.getElementById('event-modal').classList.remove('open');
    editingEventId = null;
    coverItem = { url: null, file: null };
    photoItems = [];
    rafflePrizeItems = [];
    renderRafflePrizes();
    document.getElementById('ev-products-list').innerHTML = '';
    formProductImages = {};
    loadedProductIds = [];
}
document.getElementById('ev-modal-close').addEventListener('click', closeEventModal);
document.getElementById('ev-modal-cancel').addEventListener('click', closeEventModal);
document.getElementById('event-modal').addEventListener('click', function(e) { if (e.target === this) closeEventModal(); });

// ── Capa ────────────────────────────────────────────────
function renderCover() {
    const img = document.getElementById('ev-cover-img');
    const ph  = document.getElementById('ev-cover-placeholder');
    const preview = coverItem.file ? coverItem._preview : coverItem.url;
    if (preview) {
        img.src = preview; img.style.display = 'block'; ph.style.display = 'none';
    } else {
        img.style.display = 'none'; ph.style.display = 'flex';
    }
}
document.getElementById('ev-cover-wrap').addEventListener('click', function() {
    document.getElementById('ev-cover-file').click();
});
document.getElementById('ev-cover-file').addEventListener('change', async function() {
    const file = (this.files || [])[0];
    this.value = '';
    if (!file) return;
    const ready = await prepareImage(file, 'A capa');
    if (!ready) return;
    coverItem = { url: null, file: ready.file, _preview: ready.preview };
    renderCover();
});

// ── Galeria ─────────────────────────────────────────────
function renderPhotos() {
    const grid = document.getElementById('ev-photos-grid');
    grid.innerHTML = '';
    photoItems.forEach(function(item, i) {
        const cell = document.createElement('div');
        cell.className = 'photo-thumb';
        cell.innerHTML =
            '<img src="' + esc(item.preview) + '" alt="Foto ' + (i+1) + '">' +
            '<button type="button" class="photo-remove" data-index="' + i + '" aria-label="Remover">&times;</button>';
        grid.appendChild(cell);
    });
    if (photoItems.length < MAX_PHOTOS) {
        const add = document.createElement('button');
        add.type = 'button'; add.className = 'photos-add'; add.id = 'ev-photos-add-btn';
        add.innerHTML = '<span>+</span>Adicionar';
        grid.appendChild(add);
    }
    document.getElementById('ev-photos-counter').textContent = '(' + photoItems.length + '/' + MAX_PHOTOS + ')';
}
document.getElementById('ev-photos-grid').addEventListener('click', function(e) {
    const rm  = e.target.closest('.photo-remove');
    const add = e.target.closest('#ev-photos-add-btn');
    if (rm) { photoItems.splice(parseInt(rm.dataset.index, 10), 1); renderPhotos(); }
    else if (add) { document.getElementById('ev-photos-file').click(); }
});
document.getElementById('ev-photos-file').addEventListener('change', async function() {
    const files = Array.from(this.files || []);
    this.value = '';
    for (const file of files) {
        if (photoItems.length >= MAX_PHOTOS) break;
        const ready = await prepareImage(file, '"' + file.name + '"');
        if (!ready) continue;
        photoItems.push({ url: null, file: ready.file, preview: ready.preview });
        renderPhotos();
    }
});

// ── Prêmios da rifa ────────────────────────────────────
function renderRafflePrizes() {
    const list = document.getElementById('ev-raffle-prizes-list');
    if (!list) return;
    list.innerHTML = '';
    rafflePrizeItems.forEach(function(item, i) {
        const card = document.createElement('div');
        card.className = 'raffle-prize-card';
        card.dataset.index = i;
        const preview = item.preview || item.image_url || '';
        card.innerHTML =
            '<button type="button" class="raffle-prize-img js-raffle-prize-img" aria-label="Escolher imagem do prêmio">' +
                (preview
                    ? '<img src="' + esc(preview) + '" alt="">'
                    : '<span>Imagem</span>') +
            '</button>' +
            '<div class="raffle-prize-fields">' +
                '<input type="text" class="js-raffle-prize-name" maxlength="120" placeholder="Nome do prêmio" value="' + esc(item.name || '') + '">' +
                (item.winner_number
                    ? '<small class="muted-hint">Sorteado: nº ' + item.winner_number + '</small>'
                    : '<small class="muted-hint">Será sorteado separadamente</small>') +
            '</div>' +
            '<button type="button" class="btn btn-ghost btn-sm js-raffle-prize-remove" aria-label="Remover prêmio">&times;</button>' +
            '<input type="file" class="js-raffle-prize-file" accept="image/jpeg,image/jpg,image/png,image/webp" style="display:none">';
        list.appendChild(card);
    });
    document.getElementById('ev-add-raffle-prize').disabled = rafflePrizeItems.length >= MAX_RAFFLE_PRIZES;
}

document.getElementById('ev-add-raffle-prize').addEventListener('click', function() {
    if (rafflePrizeItems.length >= MAX_RAFFLE_PRIZES) return;
    rafflePrizeItems.push(emptyRafflePrize());
    renderRafflePrizes();
});

document.getElementById('ev-raffle-prizes-list').addEventListener('input', function(e) {
    const input = e.target.closest('.js-raffle-prize-name');
    if (!input) return;
    const card = input.closest('.raffle-prize-card');
    rafflePrizeItems[Number(card.dataset.index)].name = input.value;
});

document.getElementById('ev-raffle-prizes-list').addEventListener('click', function(e) {
    const card = e.target.closest('.raffle-prize-card');
    if (!card) return;
    const idx = Number(card.dataset.index);
    if (e.target.closest('.js-raffle-prize-img')) {
        card.querySelector('.js-raffle-prize-file').click();
        return;
    }
    if (e.target.closest('.js-raffle-prize-remove')) {
        rafflePrizeItems.splice(idx, 1);
        if (!rafflePrizeItems.length) rafflePrizeItems.push(emptyRafflePrize());
        renderRafflePrizes();
    }
});

document.getElementById('ev-raffle-prizes-list').addEventListener('change', async function(e) {
    const input = e.target.closest('.js-raffle-prize-file');
    if (!input) return;
    const card = input.closest('.raffle-prize-card');
    const idx = Number(card.dataset.index);
    const file = (input.files || [])[0];
    input.value = '';
    if (!file) return;
    const ready = await prepareImage(file, 'A imagem do prêmio');
    if (!ready) return;
    rafflePrizeItems[idx].file = ready.file;
    rafflePrizeItems[idx].preview = ready.preview;
    rafflePrizeItems[idx].image_url = '';
    renderRafflePrizes();
});

function collectRafflePrizes() {
    const prizes = rafflePrizeItems.map(function(item) {
        return {
            name: String(item.name || '').trim(),
            image_url: item.image_url || '',
            file: item.file || null,
            winner_number: item.winner_number || null
        };
    }).filter(function(item) {
        return item.name || item.image_url || item.file || item.winner_number;
    });
    if (!prizes.length) throw new Error('Cadastre ao menos um prêmio para a rifa.');
    if (prizes.length > MAX_RAFFLE_PRIZES) throw new Error('A rifa pode ter no máximo 3 prêmios.');
    prizes.forEach(function(item, i) {
        if (item.name.length < 2) throw new Error('O prêmio ' + (i + 1) + ' precisa de um nome.');
    });
    return prizes;
}

// Comprime a imagem (compressImage de core/image.js) e devolve { file, preview }
// pronto para uso; null em caso de erro (já avisa por toast). `label`
// personaliza a mensagem de "passou de 5 MB".
async function prepareImage(file, label) {
    try {
        const out = await compressImage(file, { maxDim: 1600, quality: 0.82 });
        if (out.size > 5 * 1024 * 1024) {
            adminToast((label || 'A imagem') + ' continua acima de 5 MB mesmo após a compressão. Reduza o tamanho e tente de novo.', 'error');
            return null;
        }
        const preview = await new Promise(function(res, rej) {
            const r = new FileReader();
            r.onload  = function() { res(r.result); };
            r.onerror = function() { rej(new Error('read')); };
            r.readAsDataURL(out);
        });
        return { file: out, preview: preview };
    } catch (err) {
        console.error('prepareImage:', err);
        adminToast('Não foi possível processar essa imagem. Tente outra.', 'error');
        return null;
    }
}

// ── Salvar evento ───────────────────────────────────────
document.getElementById('event-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const btn = document.getElementById('ev-save-btn');
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
        const type = document.getElementById('ev-type').value;
        const name = document.getElementById('ev-name').value.trim();
        const starts = document.getElementById('ev-starts').value;
        const ends   = document.getElementById('ev-ends').value;

        if (ends < starts) throw new Error('A data de fim não pode ser anterior à de início.');

        const rTotal = document.getElementById('ev-raffle-total').value;
        const rPrice = document.getElementById('ev-raffle-price').value;
        if (type === 'rifa' && (!rTotal || !rPrice))
            throw new Error('Rifa exige quantidade de números e valor por número.');

        let rafflePrizes = [];
        if (type === 'rifa') rafflePrizes = collectRafflePrizes();

        // Venda: valida os produtos antes de gravar o evento (falha cedo).
        let formProducts = [];
        if (type === 'venda') formProducts = collectFormProducts();

        const slug = slugify(name, 'evento');

        // upload da capa
        let coverUrl = coverItem.url;
        if (coverItem.file) coverUrl = await Events.uploadEventImage(coverItem.file, slug);

        // upload da galeria
        const gallery = [];
        for (const item of photoItems) {
            if (item.file) gallery.push(await Events.uploadEventImage(item.file, slug));
            else if (item.url) gallery.push(item.url);
        }

        const savedRafflePrizes = [];
        for (let i = 0; i < rafflePrizes.length; i++) {
            const prize = rafflePrizes[i];
            let imageUrl = prize.image_url;
            if (prize.file) imageUrl = await Events.uploadEventImage(prize.file, slug + '-premio-' + (i + 1));
            savedRafflePrizes.push({
                name: prize.name,
                image_url: imageUrl || '',
                winner_number: prize.winner_number || null
            });
        }

        const goal = document.getElementById('ev-goal').value;
        const payload = {
            type: type,
            name: name,
            description: document.getElementById('ev-description').value.trim() || null,
            starts_at: starts,
            ends_at: ends,
            goal_amount: goal ? Number(goal) : null,
            cover_url: coverUrl,
            gallery: gallery,
            pix_key: document.getElementById('ev-pix-key').value.trim() || null,
            pix_merchant_name: document.getElementById('ev-pix-name').value.trim() || null,
            pix_merchant_city: document.getElementById('ev-pix-city').value.trim() || null,
            pix_payload: document.getElementById('ev-pix-payload').value.trim() || null,
            payment_instructions: document.getElementById('ev-pay-instructions').value.trim() || null,
            raffle_total_numbers: type === 'rifa' ? Number(rTotal) : null,
            raffle_number_price:  type === 'rifa' ? Number(rPrice) : null,
            raffle_max_per_reservation: type === 'rifa' ? (Number(document.getElementById('ev-raffle-max').value) || 5) : 5,
            raffle_prizes: type === 'rifa' ? savedRafflePrizes : [],
            raffle_prize: type === 'rifa' && savedRafflePrizes[0] ? savedRafflePrizes[0].name : null,
            raffle_winner_number: type === 'rifa' && savedRafflePrizes[0] ? savedRafflePrizes[0].winner_number : null
        };

        let eventId = editingEventId;
        let error;
        if (editingEventId) {
            ({ error } = await Events.updateEvent(editingEventId, payload));
        } else {
            let data;
            ({ data, error } = await Events.insertEvent(payload));
            if (!error && data) eventId = data.id;
        }
        if (error) throw error;

        // Produtos: sincroniza os da venda; em rifa, limpa eventuais órfãos.
        await reconcileProducts(eventId, type === 'venda' ? formProducts : []);

        closeEventModal();
        await loadEvents();
        if (currentEvent) refreshReservationContext();
    } catch (err) {
        showEvAlert(err.message || 'Erro ao salvar.', 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Salvar';
    }
});

function showEvAlert(msg, type) {
    const el = document.getElementById('ev-form-alert');
    el.textContent = msg; el.className = 'alert alert-' + type + ' show';
}

// ════════════ RESERVAS ════════════
function openReservations(ev) {
    currentEvent = ev;
    document.getElementById('reservations-section').style.display = '';
    refreshReservationContext();
    loadReservations();
    if (ev.type === 'venda') loadEventProducts(); else eventProducts = [];
    document.getElementById('reservations-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeReservations() {
    currentEvent = null;
    allReservations = [];
    eventProducts = [];
    document.getElementById('reservations-section').style.display = 'none';
}
document.getElementById('rc-close').addEventListener('click', closeReservations);

// Evento arquivado = histórico congelado: as reservas viram somente-leitura
// (sem editar/remover/trocar status/nova reserva). Para corrigir, reabra o
// evento pelo card (volta a "Encerrado").
function reservationsLocked() {
    return !!currentEvent && currentEvent.status === 'arquivado';
}

function refreshReservationContext() {
    if (!currentEvent) return;
    document.getElementById('rc-event-name').textContent = currentEvent.name;
    const parts = [
        (currentEvent.type === 'rifa' ? 'Rifa' : 'Venda'),
        EVENT_STATUS_LABEL[currentEvent.status],
        formatDate(currentEvent.starts_at) + ' a ' + formatDate(currentEvent.ends_at)
    ];
    if (currentEvent.type === 'rifa')
        parts.push(currentEvent.raffle_total_numbers + ' números a ' + formatMoney(currentEvent.raffle_number_price));
    if (reservationsLocked()) parts.push('histórico congelado (somente leitura)');
    document.getElementById('rc-event-meta').textContent = parts.join(' · ');
    document.getElementById('th-items').textContent = currentEvent.type === 'rifa' ? 'Números' : 'Itens';
    // Em evento arquivado, oculta "+ Nova reserva" (sem novas escritas no histórico).
    document.getElementById('add-reservation-btn').style.display = reservationsLocked() ? 'none' : '';
}

async function loadReservations() {
    const tbody = document.getElementById('reservations-tbody');
    tbody.innerHTML = '<tr class="loading-row"><td colspan="6">Carregando…</td></tr>';
    const { data, error } = await Reservations.listReservations(currentEvent.id);
    if (error) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="6">Erro: ' + esc(error.message) + '</td></tr>';
        return;
    }
    allReservations = data || [];
    renderTotals();
    renderReservations();
}

function renderTotals() {
    const active = allReservations.filter(r => r.status !== 'cancelado');
    const itemsOf = r => (r.reservation_items || []);
    const sum = (rs, fn) => rs.reduce((acc, r) => acc + itemsOf(r).reduce((a, it) => a + fn(it), 0), 0);

    const money = it => (it.quantity || 0) * Number(it.unit_price || 0);
    // "A receber" e "Confirmado" são mutuamente exclusivos: ao marcar
    // como pago, o valor sai de um e entra no outro (sem dupla contagem).
    const pending = active.filter(r => r.status === 'reservado');
    const paid    = active.filter(r => r.status === 'pago' || r.status === 'entregue');

    const reservationCount = active.length;
    const itemsSold     = sum(active, it => it.quantity || 0);
    const amountPending = sum(pending, money);
    const amountPaid    = sum(paid, money);

    const cards = [];
    cards.push(card(reservationCount, 'Reservas ativas'));
    if (currentEvent.type === 'rifa') {
        cards.push(card(itemsSold + ' / ' + (currentEvent.raffle_total_numbers || '—'), 'Números vendidos'));
    } else {
        cards.push(card(itemsSold, 'Itens vendidos'));
    }
    cards.push(card(formatMoney(amountPending), 'A receber (reservado)', 'pending'));
    cards.push(card(formatMoney(amountPaid), 'Confirmado (pago)', 'available'));
    document.getElementById('totals-panel').innerHTML = cards.join('');

    function card(value, label, cls) {
        return '<div class="stat-card ' + (cls || '') + '">' +
            '<div class="stat-value">' + esc(value) + '</div>' +
            '<div class="stat-label">' + esc(label) + '</div></div>';
    }
}

function itemsLabel(r) {
    const items = r.reservation_items || [];
    if (!items.length) return '<span class="muted-hint">—</span>';
    return '<div class="res-items">' + items.map(function(it) {
        if (it.raffle_number != null)
            return '<span class="res-chip">Nº ' + it.raffle_number + '</span>';
        const prod = eventProducts.find(p => p.id === it.product_id);
        const name = prod ? prod.name : 'Produto';
        let v = it.variation ? Object.keys(it.variation).map(k => it.variation[k]).join('/') : '';
        return '<span class="res-chip">' + (it.quantity || 1) + 'x ' + esc(name) + (v ? ' (' + esc(v) + ')' : '') + '</span>';
    }).join('') + '</div>';
}

function getFilteredReservations() {
    const q = document.getElementById('res-search').value.trim().toLowerCase();
    const st = document.getElementById('res-filter-status').value;
    return allReservations.filter(function(r) {
        if (st && r.status !== st) return false;
        if (!q) return true;
        if ((r.customer_name || '').toLowerCase().includes(q)) return true;
        if ((r.contact || '').toLowerCase().includes(q)) return true;
        // busca por ID da reserva (prefixo curto exibido ou UUID completo colado)
        if ((r.id || '').toLowerCase().includes(q.replace(/^#/, ''))) return true;
        const nums = (r.reservation_items || []).map(it => String(it.raffle_number)).join(' ');
        return nums.includes(q);
    });
}

function renderReservations() {
    const tbody = document.getElementById('reservations-tbody');
    const list = getFilteredReservations();
    tbody.innerHTML = '';
    if (!list.length) {
        tbody.innerHTML = '<tr class="loading-row"><td colspan="6">Nenhuma reserva encontrada.</td></tr>';
        return;
    }
    list.forEach(function(r) {
        const tr = document.createElement('tr');
        if (r.status === 'cancelado') tr.className = 'row-inactive';
        tr.innerHTML =
            '<td><strong>' + esc(r.customer_name) + '</strong>' +
                // contato embutido: visível só no mobile, onde a coluna Contato some
                '<small class="res-contact-inline">' + esc(r.contact) + '</small>' +
                // ID da reserva: handle estável p/ achar a linha no banco; clique copia o UUID completo
                '<button type="button" class="res-id js-res-copy" data-id="' + r.id + '"' +
                    ' title="Copiar ID completo da reserva (para localizar no banco)">#' + esc(r.id.slice(0, 8)) + '</button>' +
                (r.notes ? '<br><small class="muted-hint">' + esc(r.notes) + '</small>' : '') + '</td>' +
            '<td>' + esc(r.contact) + '</td>' +
            '<td>' + itemsLabel(r) + '</td>' +
            '<td>' + statusSelect(r) + '</td>' +
            '<td>' + formatDate(r.created_at) + '</td>' +
            '<td><div class="actions">' +
                (reservationsLocked()
                    ? '<span class="muted-hint">—</span>'
                    : '<button class="btn btn-edit btn-sm js-res-edit" data-id="' + r.id + '">Editar</button>' +
                      '<button class="btn btn-danger btn-sm js-res-delete" data-id="' + r.id + '">Remover</button>') +
            '</div></td>';
        tbody.appendChild(tr);
    });
}

function statusSelect(r) {
    // Congelado: mostra o status como texto, sem permitir troca.
    if (reservationsLocked())
        return '<span class="status-locked">' + STATUS_LABEL[r.status] + '</span>';
    const opts = ['reservado','pago','entregue','cancelado'].map(function(s) {
        return '<option value="' + s + '"' + (r.status === s ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>';
    }).join('');
    return '<select class="status-select js-res-status" data-id="' + r.id + '">' + opts + '</select>';
}

document.getElementById('res-search').addEventListener('input', renderReservations);
document.getElementById('res-filter-status').addEventListener('change', renderReservations);

// Delegação da tabela de reservas
document.getElementById('reservations-tbody').addEventListener('change', async function(e) {
    const sel = e.target.closest('.js-res-status');
    if (!sel) return;
    const r = allReservations.find(x => x.id === sel.dataset.id);
    if (!r || r.status === sel.value) return;
    const newStatus = sel.value;
    const { error } = await Reservations.updateReservation(r.id, { status: newStatus });
    if (error) { alert('Erro ao alterar status: ' + error.message); sel.value = r.status; return; }
    await loadReservations();
});

document.getElementById('reservations-tbody').addEventListener('click', function(e) {
    const copyB = e.target.closest('.js-res-copy');
    const editB = e.target.closest('.js-res-edit');
    const delB  = e.target.closest('.js-res-delete');
    if (copyB) {
        const id = copyB.dataset.id;
        const done = function() {
            const prev = copyB.textContent;
            copyB.textContent = 'copiado!';
            copyB.classList.add('is-copied');
            setTimeout(function() { copyB.textContent = prev; copyB.classList.remove('is-copied'); }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(id).then(done).catch(function() { window.prompt('ID da reserva:', id); });
        } else {
            window.prompt('ID da reserva:', id);
        }
        return;
    }
    if (editB) {
        const r = allReservations.find(x => x.id === editB.dataset.id);
        if (r) openReservationModal(r);
    } else if (delB) {
        const r = allReservations.find(x => x.id === delB.dataset.id);
        if (r) askConfirm('Remover reserva?',
            'Remover a reserva de "' + r.customer_name + '" permanentemente? Para apenas liberar o número, use o status "Cancelado".',
            function() { return deleteReservation(r.id); });
    }
});

async function deleteReservation(id) {
    const { error } = await Reservations.deleteReservation(id);
    if (error) return Promise.reject(error);
    await loadReservations();
}

// ── Modal de reserva ────────────────────────────────────
document.getElementById('add-reservation-btn').addEventListener('click', function() {
    if (reservationsLocked()) return;  // sem novas reservas em evento arquivado
    openReservationModal(null);
});

function openReservationModal(r) {
    editingReservationId = r ? r.id : null;
    document.getElementById('res-modal-title').textContent = r ? 'Editar reserva' : 'Nova reserva';
    document.getElementById('res-form-alert').className = 'alert';
    document.getElementById('res-id').value      = r ? r.id : '';
    document.getElementById('res-name').value    = r ? r.customer_name : '';
    document.getElementById('res-contact').value = r ? r.contact : '';
    document.getElementById('res-status').value  = r ? r.status : 'reservado';
    document.getElementById('res-notes').value   = r && r.notes ? r.notes : '';

    const isRifa = currentEvent.type === 'rifa';
    document.getElementById('res-raffle-block').style.display = isRifa ? '' : 'none';
    document.getElementById('res-venda-block').style.display  = isRifa ? 'none' : '';
    if (isRifa) {
        const nums = (r ? (r.reservation_items || []).filter(it => it.raffle_number != null).map(it => it.raffle_number) : []);
        renderNumberInputs(nums.length ? nums : ['']);
        document.getElementById('res-numbers-hint').textContent =
            'Números de 1 a ' + currentEvent.raffle_total_numbers + '. Números já tomados por outra reserva ativa serão rejeitados.';
    } else {
        document.getElementById('res-venda-empty').style.display = eventProducts.length ? 'none' : '';
        const prodItems = (r ? (r.reservation_items || []).filter(it => it.product_id != null) : []);
        renderProductItemRows(prodItems.length ? prodItems : [null]);
        updateOrderTotal();
    }

    document.getElementById('reservation-modal').classList.add('open');
}

function closeReservationModal() {
    document.getElementById('reservation-modal').classList.remove('open');
    editingReservationId = null;
}
document.getElementById('res-modal-close').addEventListener('click', closeReservationModal);
document.getElementById('res-modal-cancel').addEventListener('click', closeReservationModal);
document.getElementById('reservation-modal').addEventListener('click', function(e) { if (e.target === this) closeReservationModal(); });

function renderNumberInputs(values) {
    const wrap = document.getElementById('res-numbers-list');
    wrap.innerHTML = '';
    values.forEach(function(v) { wrap.appendChild(numberRow(v)); });
}
function numberRow(value) {
    const row = document.createElement('div');
    row.className = 'res-item-row';
    row.innerHTML =
        '<input type="number" class="js-res-number" min="1" max="' + (currentEvent.raffle_total_numbers || 10000) +
            '" value="' + (value === '' ? '' : value) + '" placeholder="Número">' +
        '<button type="button" class="btn btn-ghost btn-sm js-remove-number">&times;</button>';
    return row;
}
document.getElementById('res-add-number').addEventListener('click', function() {
    document.getElementById('res-numbers-list').appendChild(numberRow(''));
});
document.getElementById('res-numbers-list').addEventListener('click', function(e) {
    const rm = e.target.closest('.js-remove-number');
    if (rm) rm.closest('.res-item-row').remove();
});

// ── Salvar reserva (criar/editar) ───────────────────────
document.getElementById('reservation-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const btn = document.getElementById('res-save-btn');
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
        const name    = document.getElementById('res-name').value.trim();
        const contact = document.getElementById('res-contact').value.trim();
        const status  = document.getElementById('res-status').value;
        const notes   = document.getElementById('res-notes').value.trim() || null;
        if (name.length < 2) throw new Error('Informe o nome do cliente.');
        if (contact.length < 8) throw new Error('Informe um contato válido (telefone ou e-mail).');

        const isRifa = currentEvent.type === 'rifa';
        let numbers = [];
        let productItems = [];
        if (isRifa) {
            numbers = Array.from(document.querySelectorAll('.js-res-number'))
                .map(i => parseInt(i.value, 10))
                .filter(n => !isNaN(n));
            numbers = Array.from(new Set(numbers));
            for (const n of numbers) {
                if (n < 1 || n > currentEvent.raffle_total_numbers)
                    throw new Error('Número ' + n + ' fora do intervalo (1 a ' + currentEvent.raffle_total_numbers + ').');
            }
        } else {
            productItems = collectProductItems();
            if (!productItems.length) throw new Error('Adicione ao menos um produto ao pedido.');
        }

        const resPayload = { event_id: currentEvent.id, customer_name: name, contact: contact, status: status, notes: notes };

        let reservationId = editingReservationId;
        if (editingReservationId) {
            const { error } = await Reservations.updateReservation(editingReservationId, resPayload);
            if (error) throw error;
        } else {
            const { data, error } = await Reservations.insertReservation(resPayload);
            if (error) throw error;
            reservationId = data.id;
        }

        if (isRifa) await syncRaffleNumbers(reservationId, numbers, status);
        else        await syncProductItems(reservationId, productItems);

        closeReservationModal();
        await loadReservations();
    } catch (err) {
        showResAlert(translateItemError(err), 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Salvar';
    }
});

// Reconcilia os números da reserva com os digitados.
async function syncRaffleNumbers(reservationId, numbers, status) {
    const existing = (allReservations.find(r => r.id === reservationId) || {}).reservation_items || [];
    const existingNums = existing.filter(it => it.raffle_number != null).map(it => it.raffle_number);
    const released = (status === 'cancelado');

    // remover os que saíram
    const toDelete = existing.filter(it => it.raffle_number != null && numbers.indexOf(it.raffle_number) === -1);
    for (const it of toDelete) {
        const { error } = await Reservations.deleteReservationItem(it.id);
        if (error) throw error;
    }
    // inserir os novos
    const toInsert = numbers.filter(n => existingNums.indexOf(n) === -1).map(function(n) {
        return {
            reservation_id: reservationId, event_id: currentEvent.id, raffle_number: n,
            released: released, quantity: 1, unit_price: currentEvent.raffle_number_price
        };
    });
    if (toInsert.length) {
        const { error } = await Reservations.insertReservationItems(toInsert);
        if (error) throw error;
    }
}

// ── Itens de venda (produto + variação + quantidade) ────
function renderProductItemRows(items) {
    const wrap = document.getElementById('res-products-list');
    wrap.innerHTML = '';
    items.forEach(function(it) { wrap.appendChild(productRow(it)); });
}

function productRow(item) {
    const row = document.createElement('div');
    row.className = 'res-product-row';
    const opts = '<option value="">Produto…</option>' + eventProducts.map(function(p) {
        return '<option value="' + p.id + '"' + (item && item.product_id === p.id ? ' selected' : '') + '>' +
            esc(p.name) + ' — ' + formatMoney(p.price) + '</option>';
    }).join('');
    row.innerHTML =
        '<select class="js-res-product">' + opts + '</select>' +
        '<span class="js-res-variations"></span>' +
        '<input type="number" class="js-res-qty" min="1" max="100" value="' + (item && item.quantity ? item.quantity : 1) + '">' +
        '<button type="button" class="btn btn-ghost btn-sm js-remove-product" aria-label="Remover item">&times;</button>';
    fillVariations(row, item ? item.product_id : '', item ? item.variation : null);
    return row;
}

// Reconstrói os selects de variação conforme o produto escolhido na linha.
function fillVariations(row, productId, currentVariation) {
    const wrap = row.querySelector('.js-res-variations');
    wrap.innerHTML = '';
    const product = eventProducts.find(p => p.id === productId);
    if (!product) return;
    (product.attributes || []).forEach(function(attr) {
        const opts = attr.options || [];
        const single = opts.length === 1;   // opção única: já vem selecionada
        const sel = document.createElement('select');
        sel.className = 'js-res-variation';
        sel.dataset.attr = attr.name;
        let html = single ? '' : '<option value="">' + esc(attr.name) + '…</option>';
        opts.forEach(function(opt) {
            const isSel = single || (currentVariation && currentVariation[attr.name] === opt);
            html += '<option value="' + esc(opt) + '"' + (isSel ? ' selected' : '') + '>' + esc(opt) + '</option>';
        });
        sel.innerHTML = html;
        wrap.appendChild(sel);
    });
}

// Lê as linhas do pedido; valida produto + variações completas + quantidade.
function collectProductItems() {
    const rows = document.querySelectorAll('#res-products-list .res-product-row');
    const items = [];
    rows.forEach(function(row) {
        const pid = row.querySelector('.js-res-product').value;
        if (!pid) return;
        const product = eventProducts.find(p => p.id === pid);
        if (!product) return;
        const variation = {};
        let ok = true;
        row.querySelectorAll('.js-res-variation').forEach(function(sel) {
            if (!sel.value) ok = false; else variation[sel.dataset.attr] = sel.value;
        });
        if (!ok) throw new Error('Escolha todas as opções de "' + product.name + '".');
        let qty = parseInt(row.querySelector('.js-res-qty').value, 10);
        if (isNaN(qty) || qty < 1) qty = 1;
        if (qty > 100) qty = 100;
        items.push({ product_id: pid, variation: variation, quantity: qty, unit_price: Number(product.price) });
    });
    return items;
}

function updateOrderTotal() {
    let total = 0;
    try {
        collectProductItems().forEach(function(it) { total += it.quantity * it.unit_price; });
    } catch (e) { /* pedido incompleto: total parcial não exibido */ }
    const el = document.getElementById('res-order-total');
    el.textContent = total ? 'Total do pedido: ' + formatMoney(total) : '';
}

// Reescreve os itens de produto da reserva (admin grava direto na tabela).
async function syncProductItems(reservationId, items) {
    const existing = (allReservations.find(r => r.id === reservationId) || {}).reservation_items || [];
    const prodItems = existing.filter(it => it.product_id != null);
    for (const it of prodItems) {
        const { error } = await Reservations.deleteReservationItem(it.id);
        if (error) throw error;
    }
    const toInsert = items.map(function(it) {
        return {
            reservation_id: reservationId, event_id: currentEvent.id,
            product_id: it.product_id, variation: it.variation,
            quantity: it.quantity, unit_price: it.unit_price
        };
    });
    if (toInsert.length) {
        const { error } = await Reservations.insertReservationItems(toInsert);
        if (error) throw error;
    }
}

document.getElementById('res-add-product').addEventListener('click', function() {
    document.getElementById('res-products-list').appendChild(productRow(null));
});
document.getElementById('res-products-list').addEventListener('click', function(e) {
    const rm = e.target.closest('.js-remove-product');
    if (rm) { rm.closest('.res-product-row').remove(); updateOrderTotal(); }
});
document.getElementById('res-products-list').addEventListener('change', function(e) {
    const psel = e.target.closest('.js-res-product');
    if (psel) fillVariations(psel.closest('.res-product-row'), psel.value, null);
    updateOrderTotal();
});

function translateItemError(err) {
    const m = (err && err.message) || '';
    if (/raffle_numero_unico|duplicate key/.test(m))
        return 'Um dos números já está reservado por outra pessoa. Escolha outro.';
    return m || 'Erro ao salvar a reserva.';
}

function showResAlert(msg, type) {
    const el = document.getElementById('res-form-alert');
    el.textContent = msg; el.className = 'alert alert-' + type + ' show';
}

// ════════════ PRODUTOS (eventos de venda) ════════════
// Leitura para a tela de reservas (montador de pedido + chips).
async function loadEventProducts() {
    if (!currentEvent) { eventProducts = []; return; }
    const { data, error } = await Events.listEventProducts(currentEvent.id);
    eventProducts = error ? [] : (data || []);
    if (allReservations.length) renderReservations();   // atualiza nomes nos chips
}

// ── Produtos dentro do modal do evento (cards inline) ───
async function loadProductsIntoForm(eventId) {
    const { data } = await Events.listEventProducts(eventId);
    const list = data || [];
    loadedProductIds = list.map(function(p) { return p.id; });
    list.forEach(addProductCard);
}

function prodCard(pid) {
    return document.querySelector('#ev-products-list .ev-product-card[data-pid="' + pid + '"]');
}

function addProductCard(product) {
    const pid = 'p' + (pidCounter++);
    // Estado do card: até 3 imagens + imagem da tabela de medidas.
    // Cada imagem = { url, file, preview }. URLs existentes vêm do banco.
    const imgs = (product && Array.isArray(product.images) ? product.images : [])
        .filter(function(u) { return u; }).slice(0, 3)
        .map(function(u) { return { url: u, file: null, preview: u }; });
    const sizeImg = product && product.size_chart_image
        ? { url: product.size_chart_image, file: null, preview: product.size_chart_image } : null;
    formProductImages[pid] = { images: imgs, sizeImage: sizeImg };

    const manualRows = product && Array.isArray(product.size_chart) ? product.size_chart : [];
    const mode = sizeImg ? 'image' : (manualRows.length ? 'manual' : 'none');

    const card = document.createElement('div');
    card.className = 'ev-product-card';
    card.dataset.pid = pid;
    card.dataset.id  = product && product.id ? product.id : '';
    card.innerHTML =
        '<div class="ev-product-head">' +
            '<input type="text" class="js-prod-name" maxlength="80" placeholder="Nome do produto" value="' + (product ? esc(product.name) : '') + '">' +
            '<input type="number" class="js-prod-price" min="0.01" step="0.01" placeholder="Preço" value="' + (product && product.price != null ? product.price : '') + '">' +
            '<button type="button" class="btn btn-danger btn-sm js-prod-remove" aria-label="Remover produto">&times;</button>' +
        '</div>' +
        '<div class="ev-product-body">' +
            '<div class="ev-product-media">' +
                '<div class="prod-images js-prod-images"></div>' +
                '<input type="file" class="js-prod-img-file" accept="image/jpeg,image/jpg,image/png,image/webp" multiple style="display:none">' +
                '<small class="prod-media-hint">Até 3 imagens · a 1ª é a capa</small>' +
            '</div>' +
            '<div class="ev-product-attrs">' +
                '<div class="prod-attrs-list"></div>' +
                '<button type="button" class="btn btn-ghost btn-sm js-add-attr">+ Adicionar opção</button>' +
            '</div>' +
        '</div>' +
        '<div class="ev-product-sizechart">' +
            '<div class="sizechart-label">Tabela de medidas <span class="muted">(opcional)</span></div>' +
            '<div class="size-modes">' +
                '<label><input type="radio" name="size-' + pid + '" class="js-size-mode" value="none"' + (mode === 'none' ? ' checked' : '') + '> Nenhuma</label>' +
                '<label><input type="radio" name="size-' + pid + '" class="js-size-mode" value="image"' + (mode === 'image' ? ' checked' : '') + '> Imagem</label>' +
                '<label><input type="radio" name="size-' + pid + '" class="js-size-mode" value="manual"' + (mode === 'manual' ? ' checked' : '') + '> Manual</label>' +
            '</div>' +
            '<div class="js-size-image" style="display:none">' +
                '<div class="ev-product-img js-size-img-wrap">' +
                    '<img class="js-size-img" alt="" style="display:none">' +
                    '<div class="js-size-img-ph img-preview-placeholder">Imagem da tabela</div>' +
                    '<input type="file" class="js-size-img-file" accept="image/jpeg,image/jpg,image/png,image/webp" style="display:none">' +
                '</div>' +
            '</div>' +
            '<div class="js-size-manual" style="display:none">' +
                '<div class="js-size-rows"></div>' +
                '<button type="button" class="btn btn-ghost btn-sm js-size-add-row">+ Adicionar linha</button>' +
            '</div>' +
        '</div>';
    document.getElementById('ev-products-list').appendChild(card);

    const attrsList = card.querySelector('.prod-attrs-list');
    (product && Array.isArray(product.attributes) ? product.attributes : []).forEach(function(a) {
        attrsList.appendChild(attrRow(a));
    });
    const rowsBox = card.querySelector('.js-size-rows');
    manualRows.forEach(function(r) { rowsBox.appendChild(sizeRow(r)); });

    renderProdImages(pid);
    renderSizeChart(pid);
    return card;
}

function attrRow(attr) {
    const row = document.createElement('div');
    row.className = 'prod-attr-row';
    const chips = (attr && Array.isArray(attr.options) ? attr.options : [])
        .map(function(o) { return attrChipHtml(o); }).join('');
    row.innerHTML =
        '<input type="text" class="js-attr-name" maxlength="40" placeholder="Variação (ex: Tamanho)" value="' + (attr ? esc(attr.name) : '') + '">' +
        '<div class="js-attr-chips attr-chips">' + chips +
            '<input type="text" class="js-attr-chip-input" maxlength="40" placeholder="Opção + Enter (ex: P)">' +
        '</div>' +
        '<button type="button" class="btn btn-ghost btn-sm js-remove-attr" aria-label="Remover variação">&times;</button>';
    return row;
}

function attrChipHtml(val) {
    return '<span class="attr-chip" data-val="' + esc(val) + '">' + esc(val) +
           '<button type="button" class="attr-chip-x js-chip-remove" aria-label="Remover opção">&times;</button></span>';
}

// Adiciona um ou mais chips (aceita vírgulas) na variação; ignora vazios
// e duplicatas (case-insensitive). Insere antes do input de digitação.
function commitChipInput(input) {
    const box = input.closest('.js-attr-chips');
    input.value.split(',').forEach(function(part) {
        const val = part.trim();
        if (!val) return;
        const dup = Array.prototype.some.call(box.querySelectorAll('.attr-chip'),
            function(c) { return c.dataset.val.toLowerCase() === val.toLowerCase(); });
        if (!dup) input.insertAdjacentHTML('beforebegin', attrChipHtml(val));
    });
    input.value = '';
}

function sizeRow(r) {
    const row = document.createElement('div');
    row.className = 'size-row';
    row.innerHTML =
        '<input type="text" class="js-size-label" maxlength="40" placeholder="Medida (ex: Altura)" value="' + (r ? esc(r.label) : '') + '">' +
        '<input type="text" class="js-size-value" maxlength="40" placeholder="Valor (ex: 30 cm)" value="' + (r ? esc(r.value) : '') + '">' +
        '<button type="button" class="btn btn-ghost btn-sm js-size-remove-row" aria-label="Remover linha">&times;</button>';
    return row;
}

// Galeria de imagens do produto (thumbs + botão de adicionar até 3).
function renderProdImages(pid) {
    const card = prodCard(pid);
    if (!card) return;
    const box  = card.querySelector('.js-prod-images');
    const list = (formProductImages[pid] && formProductImages[pid].images) || [];
    let html = list.map(function(it, i) {
        return '<div class="prod-thumb">' +
                '<img src="' + esc(it.preview) + '" alt="">' +
                (i === 0 ? '<span class="prod-thumb-cover">Capa</span>' : '') +
                '<button type="button" class="prod-thumb-remove js-prod-img-remove" data-idx="' + i + '" aria-label="Remover imagem">&times;</button>' +
            '</div>';
    }).join('');
    if (list.length < 3)
        html += '<button type="button" class="prod-add-img js-prod-img-add"><span>+</span>Imagem</button>';
    box.innerHTML = html;
}

// Mostra/esconde imagem×manual conforme o modo e renderiza o preview da
// imagem de medidas.
function renderSizeChart(pid) {
    const card = prodCard(pid);
    if (!card) return;
    const mode = (card.querySelector('.js-size-mode:checked') || {}).value || 'none';
    card.querySelector('.js-size-image').style.display  = mode === 'image'  ? '' : 'none';
    card.querySelector('.js-size-manual').style.display = mode === 'manual' ? '' : 'none';
    const st  = formProductImages[pid] && formProductImages[pid].sizeImage;
    const img = card.querySelector('.js-size-img');
    const ph  = card.querySelector('.js-size-img-ph');
    if (st && st.preview) { img.src = st.preview; img.style.display = 'block'; ph.style.display = 'none'; }
    else { img.style.display = 'none'; ph.style.display = 'flex'; }
}

document.getElementById('ev-add-product').addEventListener('click', function() { addProductCard(null); });

// Delegação dos cards de produto (remover produto/variação/imagem/linha,
// adicionar variação/imagem/linha, abrir seletores de arquivo).
document.getElementById('ev-products-list').addEventListener('click', function(e) {
    const card = e.target.closest('.ev-product-card');
    if (!card) return;
    if (e.target.closest('.js-prod-remove'))   { card.remove(); return; }
    if (e.target.closest('.js-add-attr'))       { card.querySelector('.prod-attrs-list').appendChild(attrRow(null)); return; }
    if (e.target.closest('.js-remove-attr'))    { e.target.closest('.prod-attr-row').remove(); return; }
    if (e.target.closest('.js-chip-remove'))     { e.target.closest('.attr-chip').remove(); return; }
    if (e.target.closest('.js-prod-img-add'))   { card.querySelector('.js-prod-img-file').click(); return; }
    const rmImg = e.target.closest('.js-prod-img-remove');
    if (rmImg) {
        formProductImages[card.dataset.pid].images.splice(parseInt(rmImg.dataset.idx, 10), 1);
        renderProdImages(card.dataset.pid);
        return;
    }
    if (e.target.closest('.js-size-img-wrap'))  { card.querySelector('.js-size-img-file').click(); return; }
    if (e.target.closest('.js-size-add-row'))    { card.querySelector('.js-size-rows').appendChild(sizeRow(null)); return; }
    if (e.target.closest('.js-size-remove-row')) { e.target.closest('.size-row').remove(); return; }
});
// Chips das variações: Enter/vírgula confirma, Backspace em campo vazio
// apaga o último chip; ao sair do campo, confirma o texto pendente.
document.getElementById('ev-products-list').addEventListener('keydown', function(e) {
    const input = e.target.closest('.js-attr-chip-input');
    if (!input) return;
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitChipInput(input); }
    else if (e.key === 'Backspace' && !input.value) {
        const chips = input.closest('.js-attr-chips').querySelectorAll('.attr-chip');
        if (chips.length) chips[chips.length - 1].remove();
    }
});
document.getElementById('ev-products-list').addEventListener('focusout', function(e) {
    const input = e.target.closest('.js-attr-chip-input');
    if (input) commitChipInput(input);
});
document.getElementById('ev-products-list').addEventListener('change', async function(e) {
    const card = e.target.closest('.ev-product-card');
    if (!card) return;
    const pid = card.dataset.pid;

    if (e.target.classList.contains('js-size-mode')) { renderSizeChart(pid); return; }

    const prodFile = e.target.closest('.js-prod-img-file');
    if (prodFile) {
        const files = Array.from(prodFile.files || []);
        prodFile.value = '';
        const st = formProductImages[pid];
        for (const file of files) {
            if (st.images.length >= 3) break;
            const ready = await prepareImage(file, 'A imagem do produto');
            if (!ready) continue;
            st.images.push({ url: null, file: ready.file, preview: ready.preview });
            renderProdImages(pid);
        }
        return;
    }

    const sizeFile = e.target.closest('.js-size-img-file');
    if (sizeFile) {
        const file = (sizeFile.files || [])[0];
        sizeFile.value = '';
        if (!file) return;
        const ready = await prepareImage(file, 'A imagem da tabela de medidas');
        if (!ready) return;
        formProductImages[pid].sizeImage = { url: null, file: ready.file, preview: ready.preview };
        renderSizeChart(pid);
    }
});

// Lê as variações de um card. Valida opções e nomes únicos no produto.
function collectAttributesIn(card) {
    const rows = card.querySelectorAll('.prod-attr-row');
    const attrs = [];
    rows.forEach(function(row) {
        const name = row.querySelector('.js-attr-name').value.trim();
        const chipsBox = row.querySelector('.js-attr-chips');
        commitChipInput(chipsBox.querySelector('.js-attr-chip-input'));   // captura texto não confirmado
        const options = Array.prototype.map.call(chipsBox.querySelectorAll('.attr-chip'),
            function(c) { return c.dataset.val; });
        if (!name) return;   // variação sem nome: ignorada
        if (!options.length) throw new Error('A variação "' + name + '" precisa de ao menos uma opção.');
        attrs.push({ name: name, options: options });
    });
    const names = attrs.map(function(a) { return a.name.toLowerCase(); });
    if (new Set(names).size !== names.length)
        throw new Error('Há variações com o mesmo nome no mesmo produto.');
    return attrs;
}

// Lê as linhas da tabela de medidas manual de um card. Retorna null se
// não houver linhas preenchidas (= sem tabela).
function collectSizeRows(card) {
    const rows = [];
    card.querySelectorAll('.size-row').forEach(function(row) {
        const label = row.querySelector('.js-size-label').value.trim();
        const value = row.querySelector('.js-size-value').value.trim();
        if (!label && !value) return;   // linha vazia: ignorada
        if (!label || !value) throw new Error('Cada linha da tabela de medidas precisa de medida e valor.');
        rows.push({ label: label, value: value });
    });
    return rows.length ? rows : null;
}

// Lê os cards de produto do modal e valida (≥1 produto, nome e preço).
function collectFormProducts() {
    const cards = document.querySelectorAll('#ev-products-list .ev-product-card');
    const products = [];
    cards.forEach(function(card) {
        const name  = card.querySelector('.js-prod-name').value.trim();
        const price = Number(card.querySelector('.js-prod-price').value);
        if (name.length < 2) throw new Error('Cada produto precisa de um nome (mín. 2 letras).');
        if (!(price > 0))    throw new Error('O produto "' + (name || '?') + '" precisa de um preço maior que zero.');
        const sizeMode = (card.querySelector('.js-size-mode:checked') || {}).value || 'none';
        products.push({
            id: card.dataset.id || null, pid: card.dataset.pid,
            name: name, price: price, attributes: collectAttributesIn(card),
            sizeMode: sizeMode,
            sizeRows: sizeMode === 'manual' ? collectSizeRows(card) : null
        });
    });
    if (!products.length) throw new Error('Cadastre ao menos um produto para o evento de venda.');
    return products;
}

// Sincroniza os produtos do evento no banco: insere/atualiza os do form e
// remove os que saíram (bloqueado se o produto já está em uma reserva).
async function reconcileProducts(eventId, formProducts) {
    const keepIds = [];
    for (let i = 0; i < formProducts.length; i++) {
        const fp = formProducts[i];
        const st = formProductImages[fp.pid] || { images: [], sizeImage: null };

        // Imagens do produto: mantém as URLs já salvas e sobe as novas.
        const images = [];
        for (const it of st.images) {
            if (it.file)     images.push(await Events.uploadEventImage(it.file, slugify(fp.name, 'produto')));
            else if (it.url) images.push(it.url);
        }

        // Tabela de medidas: imagem OU manual (nunca ambos).
        let sizeChartImage = null, sizeChart = null;
        if (fp.sizeMode === 'image') {
            if (st.sizeImage && st.sizeImage.file)     sizeChartImage = await Events.uploadEventImage(st.sizeImage.file, slugify(fp.name, 'medidas'));
            else if (st.sizeImage && st.sizeImage.url) sizeChartImage = st.sizeImage.url;
        } else if (fp.sizeMode === 'manual') {
            sizeChart = fp.sizeRows;   // null se não houver linhas
        }

        const payload = {
            event_id: eventId, name: fp.name, price: fp.price,
            images: images, attributes: fp.attributes,
            size_chart_image: sizeChartImage, size_chart: sizeChart,
            sort_order: i
        };
        if (fp.id) {
            const { error } = await Events.updateProduct(fp.id, payload);
            if (error) throw error;
            keepIds.push(fp.id);
        } else {
            const { data, error } = await Events.insertProduct(payload);
            if (error) throw error;
            keepIds.push(data.id);
        }
    }
    const toDelete = loadedProductIds.filter(function(id) { return keepIds.indexOf(id) === -1; });
    for (const id of toDelete) {
        const { error } = await Events.deleteProduct(id);
        if (error) throw new Error('Um produto removido já está em uma reserva e não pôde ser excluído. Cancele/limpe as reservas dele antes.');
    }
}

// ── Exportar CSV ────────────────────────────────────────
// Monta e baixa o CSV de reservas de um evento. Reusado pelo botão "Exportar
// CSV" e pelo backup obrigatório antes da limpeza de dados (LGPD).
function downloadReservationsCsv(ev, reservations) {
    const rows = [['reserva_id','cliente','contato','status','criada_em','tipo_item','numero_rifa','variacao','quantidade','preco_unit']];
    reservations.forEach(function(r) {
        const items = r.reservation_items || [];
        if (!items.length) {
            rows.push([r.id, r.customer_name, r.contact, r.status, r.created_at, '', '', '', '', '']);
            return;
        }
        items.forEach(function(it) {
            rows.push([
                r.id, r.customer_name, r.contact, r.status, r.created_at,
                it.raffle_number != null ? 'rifa' : 'produto',
                it.raffle_number != null ? it.raffle_number : '',
                it.variation ? JSON.stringify(it.variation) : '',
                it.quantity, it.unit_price
            ]);
        });
    });
    const csv = rows.map(function(row) {
        return row.map(function(cell) {
            const s = String(cell == null ? '' : cell);
            return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(',');
    }).join('\r\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'reservas-' + slugify(ev.name, 'evento') + '-' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}

document.getElementById('export-csv-btn').addEventListener('click', function() {
    downloadReservationsCsv(currentEvent, allReservations);
});

// ── Limpeza de dados / LGPD ─────────────────────────────
// 2 passos obrigatórios: (1) baixa o CSV de backup; (2) confirma e chama
// purge_event_data, que grava os agregados não pessoais em events.summary e
// apaga reservas/itens na mesma transação. Só aparece em evento arquivado
// ainda não limpo (ver eventActions).
async function startPurgeFlow(ev) {
    // A tela pode não estar aberta neste evento — busca as reservas dele.
    const { data, error } = await Reservations.listReservations(ev.id);
    if (error) { alert('Erro ao buscar reservas: ' + error.message); return; }
    const reservations = data || [];
    if (!reservations.length) { alert('Este evento não tem reservas para limpar.'); return; }

    // Passo 1 — backup obrigatório (download imediato).
    downloadReservationsCsv(ev, reservations);

    // Passo 2 — confirmação explícita da exclusão irreversível.
    askConfirm('Limpar dados pessoais (LGPD)',
        'O backup CSV de "' + ev.name + '" (' + reservations.length + ' reserva(s)) foi baixado agora. ' +
        'Confirmar a remoção definitiva dos dados pessoais (nomes/contatos e reservas)? ' +
        'O histórico público continua pelo resumo agregado. Esta ação não pode ser desfeita.',
        function() { return purgeEventData(ev.id); });
}

async function purgeEventData(id) {
    const { error } = await Events.purgeEventData(id);
    if (error) return Promise.reject(error);
    if (currentEvent && currentEvent.id === id) loadReservations();  // recarrega se aberto
    await loadEvents();
}

// ── Confirmação genérica ────────────────────────────────
function askConfirm(title, msg, cb) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent = msg;
    confirmCallback = cb;
    document.getElementById('confirm-overlay').classList.add('open');
}
document.getElementById('confirm-cancel').addEventListener('click', function() {
    document.getElementById('confirm-overlay').classList.remove('open');
    confirmCallback = null;
});
document.getElementById('confirm-ok').addEventListener('click', async function() {
    const cb = confirmCallback;
    confirmCallback = null;
    document.getElementById('confirm-overlay').classList.remove('open');
    if (!cb) return;
    try { await cb(); }
    catch (err) { alert('Erro: ' + (err.message || err)); }
});

function bindGlobal() {
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeEventModal();
            closeReservationModal();
            document.getElementById('confirm-overlay').classList.remove('open');
        }
    });
    setupAutoRefresh();
}

// Recarrega os dados ao voltar o foco para a aba — assim mudanças
// feitas em outro dispositivo aparecem sem precisar recarregar à mão.
// Não recarrega se houver modal aberto (admin no meio de uma edição)
// nem em rajada (intervalo mínimo entre recargas).
function setupAutoRefresh() {
    let lastRefresh = Date.now();
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - lastRefresh < 3000) return;
        if (document.querySelector('.modal-overlay.open, .confirm-overlay.open')) return;
        lastRefresh = Date.now();
        loadEvents();
        if (currentEvent) loadReservations();
    });
}

init();
