// Eventos de Arrecadação — banner na home (#event-banner) e página
// dedicada (#event-area): evento ativo com grade da rifa + reserva via
// RPC create_reservation, e histórico dos últimos eventos encerrados.
// Dados vêm do Supabase (tabelas events/event_totals/raffle_board).
// Eventos de venda (type='venda') mostram a vitrine de produtos com
// carrinho (variação + quantidade) e reservam pela mesma RPC.
// Módulo ES (Fase D): leitura/RPC anon via core/rest.js (fetchJson). PixBRCode
// (js/pix.js) e QRCode (qrcodejs) continuam globais clássicos.
import { fetchJson } from './core/rest.js';
import { normalizeRafflePrizes, prizeDisplayName } from './core/raffle-prizes.js';

(function() {
    // Mensagens amigáveis para os códigos de erro da RPC
    var ERROR_MESSAGES = {
        'NUMERO_INDISPONIVEL':    'Esse número acabou de ser reservado por outra pessoa. Escolha outro número.',
        'LIMITE_RESERVAS_HORA':   'Você fez várias reservas em pouco tempo. Aguarde um pouco e tente novamente.',
        'LIMITE_RESERVAS_EVENTO': 'Este contato já atingiu o limite de reservas neste evento. Fale com o abrigo.',
        'EVENTO_INDISPONIVEL':    'Este evento não está mais recebendo reservas.',
        'NOME_INVALIDO':          'Informe seu nome completo (mínimo 2 letras).',
        'CONTATO_INVALIDO':       'Informe um telefone ou e-mail válido.',
        'NUMERO_INVALIDO':        'Número inválido para esta rifa. Recarregue a página e tente novamente.',
        'RIFA_LIMITE_NUMEROS':    'Você selecionou números demais para uma única reserva. Reduza a quantidade.',
        'PRODUTO_INVALIDO':       'Um dos produtos do pedido não está mais disponível. Recarregue a página.',
        'QUANTIDADE_INVALIDA':    'Quantidade inválida em um dos itens do pedido.',
        'VARIACAO_INVALIDA':      'Há uma opção inválida no seu pedido. Recarregue a página e refaça a seleção.',
        'ITEM_INVALIDO':          'Há um item inválido no seu pedido. Recarregue a página e tente novamente.',
        'ITENS_INVALIDOS':        'Adicione ao menos um item ao pedido antes de reservar.'
    };

    // Escapa texto para uso em innerHTML (nomes/opções vêm do admin).
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // "M · Masculina" a partir do objeto de variação
    function variationLabel(variation) {
        if (!variation) return '';
        return Object.keys(variation).map(function(k) { return variation[k]; }).join(' · ');
    }

    function friendlyError(err) {
        var code = (err && err.code) || '';
        for (var key in ERROR_MESSAGES) {
            if (code.indexOf(key) !== -1) return ERROR_MESSAGES[key];
        }
        return 'Não foi possível concluir a reserva. Verifique sua conexão e tente novamente.';
    }

    function formatDate(isoDate) {
        if (!isoDate) return '';
        var parts = isoDate.split('-'); // YYYY-MM-DD (sem fuso)
        return parts[2] + '/' + parts[1] + '/' + parts[0];
    }

    function formatMoney(value) {
        return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    function todayISO() {
        var d = new Date();
        return d.getFullYear() + '-' +
               String(d.getMonth() + 1).padStart(2, '0') + '-' +
               String(d.getDate()).padStart(2, '0');
    }

    function isOpenForReservations(ev) {
        var today = todayISO();
        return ev.status === 'ativo' && today >= ev.starts_at && today <= ev.ends_at;
    }

    // ── Banner na home ──────────────────────────────────────────
    function renderHomeBanner(container, ev) {
        container.innerHTML = '';
        var card = document.createElement('a');
        card.className = 'event-banner-card';
        card.href = 'pages/eventos.html';

        if (ev.cover_url) {
            var img = document.createElement('img');
            img.src = ev.cover_url;
            img.alt = 'Imagem do evento ' + ev.name;
            img.loading = 'lazy';
            card.appendChild(img);
        }

        var body = document.createElement('div');
        body.className = 'event-banner-body';

        var tag = document.createElement('span');
        tag.className = 'event-banner-tag';
        tag.textContent = ev.type === 'rifa' ? 'Rifa beneficente' : 'Venda beneficente';

        var name = document.createElement('span');
        name.className = 'event-banner-name';
        name.textContent = ev.name;

        var period = document.createElement('span');
        period.className = 'event-banner-period';
        period.textContent = 'Até ' + formatDate(ev.ends_at);

        var btn = document.createElement('span');
        btn.className = 'event-banner-button';
        btn.textContent = 'Participar';

        body.appendChild(tag);
        body.appendChild(name);
        body.appendChild(period);
        body.appendChild(btn);
        card.appendChild(body);
        container.appendChild(card);
    }

    // ── Cabeçalho do evento (página dedicada) ───────────────────
    function buildEventHeader(ev, totals) {
        var header = document.createElement('section');
        header.className = 'event-header';

        if (ev.cover_url) {
            var cover = document.createElement('img');
            cover.className = 'event-cover';
            cover.src = ev.cover_url;
            cover.alt = 'Imagem do evento ' + ev.name;
            header.appendChild(cover);
        }

        var info = document.createElement('div');
        info.className = 'event-info';

        var name = document.createElement('h2');
        name.textContent = ev.name;
        info.appendChild(name);

        var tags = document.createElement('div');
        tags.className = 'event-tags';
        var tagData = [
            ev.type === 'rifa' ? 'Rifa beneficente' : 'Venda beneficente',
            formatDate(ev.starts_at) + ' a ' + formatDate(ev.ends_at)
        ];
        if (ev.type === 'rifa' && ev.raffle_number_price) {
            tagData.push(formatMoney(ev.raffle_number_price) + ' por número');
        }
        tagData.forEach(function(text) {
            var span = document.createElement('span');
            span.textContent = text;
            tags.appendChild(span);
        });
        info.appendChild(tags);

        if (ev.description) {
            var desc = document.createElement('p');
            desc.className = 'event-description';
            desc.textContent = ev.description;
            info.appendChild(desc);
        }

        var rafflePrizes = ev.type === 'rifa' ? normalizeRafflePrizes(ev) : [];
        if (rafflePrizes.length) {
            var prizes = document.createElement('div');
            prizes.className = 'event-prizes';
            var heading = document.createElement('strong');
            heading.textContent = rafflePrizes.length > 1 ? 'Prêmios:' : 'Prêmio:';
            prizes.appendChild(heading);
            var list = document.createElement('div');
            list.className = 'event-prize-list';
            rafflePrizes.forEach(function(prize, i) {
                var item = document.createElement('div');
                item.className = 'event-prize';
                if (prize.image_url) {
                    var img = document.createElement('img');
                    img.src = prize.image_url;
                    img.alt = prizeDisplayName(prize, i);
                    img.loading = 'lazy';
                    item.appendChild(img);
                }
                var name = document.createElement('span');
                name.textContent = prizeDisplayName(prize, i);
                item.appendChild(name);
                list.appendChild(item);
            });
            prizes.appendChild(list);
            info.appendChild(prizes);
        }

        // Barra de progresso — rifa: números vendidos (valores arrecadados
        // não são expostos ao público); venda: arrecadação da meta
        if (ev.type === 'rifa' && totals && ev.raffle_total_numbers) {
            var sold    = Number(totals.items_sold || 0);
            var percent = Math.min(100, Math.round((sold / ev.raffle_total_numbers) * 100));
            var text;
            if (sold === 0) {
                text = 'Todos os ' + ev.raffle_total_numbers + ' números estão disponíveis!';
            } else if (sold === 1) {
                text = 'Já foi vendido 1 dos ' + ev.raffle_total_numbers + ' números!';
            } else {
                text = 'Já foram vendidos ' + sold + ' dos ' + ev.raffle_total_numbers + ' números!';
            }
            var goal = document.createElement('div');
            goal.className = 'event-goal';
            goal.innerHTML =
                '<div class="event-goal-bar"><div class="event-goal-fill" style="width: ' + percent + '%"></div></div>' +
                '<span class="event-goal-text">' + text + '</span>';
            info.appendChild(goal);
        } else if (ev.goal_amount && totals) {
            var raised   = Number(totals.amount_reserved || 0);
            var percentG = Math.min(100, Math.round((raised / Number(ev.goal_amount)) * 100));
            var goalEl = document.createElement('div');
            goalEl.className = 'event-goal';
            goalEl.innerHTML =
                '<div class="event-goal-bar"><div class="event-goal-fill" style="width: ' + percentG + '%"></div></div>' +
                '<span class="event-goal-text">' + formatMoney(raised) + ' arrecadados da meta de ' + formatMoney(ev.goal_amount) + '</span>';
            info.appendChild(goalEl);
        }

        header.appendChild(info);

        // Galeria de divulgação (imagens extras)
        if (ev.gallery && ev.gallery.length) {
            var gallery = document.createElement('div');
            gallery.className = 'event-gallery';
            ev.gallery.forEach(function(src, i) {
                var img = document.createElement('img');
                img.src = src;
                img.alt = 'Divulgação ' + (i + 1) + ' do evento ' + ev.name;
                img.loading = 'lazy';
                gallery.appendChild(img);
            });
            header.appendChild(gallery);
        }
        return header;
    }

    // ── Grade da rifa ───────────────────────────────────────────
    function buildRaffleGrid(ev, takenByNumber, clickable) {
        var section = document.createElement('section');
        section.className = 'raffle-section';

        // Banner do número sorteado — só o número (nenhum dado pessoal
        // na página pública; o nome do ganhador é anunciado na transmissão)
        var rafflePrizes = normalizeRafflePrizes(ev);
        var winnerNumbers = rafflePrizes
            .map(function(prize) { return prize.winner_number; })
            .filter(function(n) { return n != null; });
        if (!winnerNumbers.length && ev.raffle_winner_number) winnerNumbers = [ev.raffle_winner_number];
        if (winnerNumbers.length) {
            var winner = document.createElement('div');
            winner.className = 'raffle-winner';
            winner.textContent = winnerNumbers.length === 1
                ? 'Número sorteado: ' + winnerNumbers[0] + ' — parabéns ao ganhador!'
                : 'Números sorteados: ' + winnerNumbers.join(', ') + ' — parabéns aos ganhadores!';
            section.appendChild(winner);
        }

        var title = document.createElement('h3');
        title.textContent = 'Escolha seus números';
        section.appendChild(title);

        if (clickable) {
            var hint = document.createElement('p');
            hint.className = 'raffle-hint';
            var maxPer = ev.raffle_max_per_reservation || 5;
            hint.textContent = maxPer > 1
                ? 'Toque para selecionar até ' + maxPer + ' números e depois toque em "Reservar".'
                : 'Toque em um número para reservar.';
            section.appendChild(hint);
        }

        var legend = document.createElement('div');
        legend.className = 'raffle-legend';
        legend.innerHTML =
            '<span><i class="raffle-dot raffle-dot-free"></i> Disponível</span>' +
            '<span><i class="raffle-dot raffle-dot-selected"></i> Selecionado</span>' +
            '<span><i class="raffle-dot raffle-dot-taken"></i> Reservado</span>';
        section.appendChild(legend);

        var grid = document.createElement('div');
        grid.className = 'raffle-grid';
        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-label', 'Números da rifa');

        var fragment = document.createDocumentFragment();
        for (var n = 1; n <= ev.raffle_total_numbers; n++) {
            var cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'raffle-cell';
            cell.dataset.number = n;
            var taken = takenByNumber[n];
            if (taken) {
                cell.classList.add('is-taken');
                cell.disabled = true;
                // não revela quem reservou — apenas marca como tomado
                cell.innerHTML = '<span class="raffle-cell-number">' + n + '</span>' +
                                 '<span class="raffle-cell-name">Reservado</span>';
                cell.title = 'Número ' + n + ' já reservado';
            } else {
                cell.disabled = !clickable;
                cell.innerHTML = '<span class="raffle-cell-number">' + n + '</span>';
                cell.setAttribute('aria-label', 'Selecionar número ' + n);
                cell.setAttribute('aria-pressed', 'false');
            }
            if (winnerNumbers.indexOf(n) !== -1) cell.classList.add('is-winner');
            fragment.appendChild(cell);
        }
        grid.appendChild(fragment);
        section.appendChild(grid);

        if (!clickable && !winnerNumbers.length) {
            var closed = document.createElement('p');
            closed.className = 'raffle-closed';
            closed.textContent = 'Este evento não está recebendo novas reservas.';
            section.appendChild(closed);
        }
        return section;
    }

    // ── Histórico de eventos anteriores ─────────────────────────
    function renderPastEvents(container, events) {
        container.innerHTML = '';
        events.forEach(function(ev) {
            var card = document.createElement('article');
            card.className = 'past-event-card';

            if (ev.cover_url) {
                var img = document.createElement('img');
                img.src = ev.cover_url;
                img.alt = 'Imagem do evento ' + ev.name;
                img.loading = 'lazy';
                card.appendChild(img);
            }

            var body = document.createElement('div');
            body.className = 'past-event-body';

            var name = document.createElement('span');
            name.className = 'past-event-name';
            name.textContent = ev.name;
            body.appendChild(name);

            var period = document.createElement('span');
            period.className = 'past-event-period';
            period.textContent = formatDate(ev.starts_at) + ' a ' + formatDate(ev.ends_at);
            body.appendChild(period);

            // Resultado: summary (pós-limpeza LGPD) ou número sorteado
            var resultParts = [];
            if (ev.type === 'rifa') {
                var winners = normalizeRafflePrizes(ev)
                    .map(function(prize) { return prize.winner_number; })
                    .filter(function(n) { return n != null; });
                if (!winners.length && ev.raffle_winner_number) winners = [ev.raffle_winner_number];
                if (winners.length)
                    resultParts.push((winners.length === 1 ? 'Número sorteado: ' : 'Números sorteados: ') + winners.join(', '));
            }
            if (ev.summary && ev.summary.total_raised > 0) {
                resultParts.push(formatMoney(ev.summary.total_raised) + ' arrecadados');
            }
            if (resultParts.length) {
                var result = document.createElement('span');
                result.className = 'past-event-result';
                result.textContent = resultParts.join(' · ');
                body.appendChild(result);
            }
            card.appendChild(body);
            container.appendChild(card);
        });
    }

    // ── Modal de reserva (rifa) ─────────────────────────────────
    // items = payload da RPC (rifa: [{raffle_number}], venda: [{product_id,quantity,variation}])
    // summary/total alimentam o passo de confirmação + PIX.
    var modalState = { event: null, items: [], total: 0, summary: '' };

    function describeNumbers(numbers) {
        if (numbers.length === 1) return 'o número ' + numbers[0];
        return 'os números ' + numbers.join(', ');
    }

    // Abre o modal de reserva de forma genérica.
    // opts = { title, subtitle, items, total, summary }
    function openReserveModal(ev, opts) {
        modalState.event   = ev;
        modalState.items   = opts.items;
        modalState.total   = opts.total;
        modalState.summary = opts.summary;

        document.getElementById('reserve-title').textContent    = opts.title;
        document.getElementById('reserve-subtitle').textContent = opts.subtitle;

        document.getElementById('reserve-form-step').style.display = '';
        document.getElementById('reserve-success-step').style.display = 'none';
        document.getElementById('reserve-error').style.display = 'none';
        document.getElementById('reserve-form').reset();
        document.getElementById('reserve-submit').disabled = false;
        document.getElementById('reserve-submit').textContent = 'Confirmar reserva';

        var modal = document.getElementById('reserve-modal');
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        document.getElementById('reserve-name').focus();
    }

    // Rifa: monta os parâmetros do modal a partir dos números selecionados.
    function openRaffleReserveModal(ev, numbers) {
        var total = numbers.length * Number(ev.raffle_number_price || 0);
        openReserveModal(ev, {
            title: numbers.length === 1 ? 'Reservar o número ' + numbers[0]
                                        : 'Reservar ' + numbers.length + ' números',
            subtitle: ev.name + ' — ' + describeNumbers(numbers) + '. Total: ' + formatMoney(total) + '.',
            items: numbers.map(function(n) { return { raffle_number: n }; }),
            total: total,
            summary: numbers.length === 1 ? 'Número ' + numbers[0] + ' reservado'
                                          : 'Números ' + numbers.join(', ') + ' reservados'
        });
    }

    // Venda: monta os parâmetros do modal a partir do pedido (carrinho).
    function openSaleReserveModal(ev, order) {
        var total = order.reduce(function(a, o) { return a + o.quantity * Number(o.product.price || 0); }, 0);
        var lines = order.map(function(o) {
            var v = variationLabel(o.variation);
            return o.quantity + 'x ' + o.product.name + (v ? ' (' + v + ')' : '');
        });
        openReserveModal(ev, {
            title: 'Concluir pedido',
            subtitle: ev.name + ' — ' + lines.join('; ') + '. Total: ' + formatMoney(total) + '.',
            items: order.map(function(o) {
                return { product_id: o.product.id, quantity: o.quantity, variation: o.variation };
            }),
            total: total,
            summary: 'Pedido confirmado: ' + lines.join('; ')
        });
    }

    function closeReserveModal() {
        var modal = document.getElementById('reserve-modal');
        if (!modal) return;
        modal.style.display = 'none';
        document.body.style.overflow = '';
        document.getElementById('pix-qrcode').innerHTML = '';
    }

    function showReserveError(message) {
        var el = document.getElementById('reserve-error');
        el.textContent = message;
        el.style.display = '';
    }

    // Confirmação + PIX (QR Code e copia-e-cola) — usa o modalState atual
    function showSuccess() {
        var ev    = modalState.event;
        var total = modalState.total;
        document.getElementById('reserve-form-step').style.display = 'none';
        document.getElementById('reserve-success-step').style.display = '';
        document.getElementById('reserve-success-summary').textContent =
            modalState.summary + ' em "' + ev.name + '". Valor: ' + formatMoney(total) + '.';

        // pix_payload pronto (ex: PagSeguro) tem prioridade;
        // senão o site monta o BR Code com chave + nome + cidade
        var payload = ev.pix_payload && ev.pix_payload.trim() ? ev.pix_payload.trim() : null;
        if (payload && window.PixBRCode && PixBRCode.setAmount) {
            // injeta o valor da reserva para o app do banco pré-preencher
            payload = PixBRCode.setAmount(payload, Number(total));
        }
        if (!payload && window.PixBRCode) {
            payload = PixBRCode.buildPayload({
                key:    ev.pix_key,
                name:   ev.pix_merchant_name,
                city:   ev.pix_merchant_city,
                amount: Number(total)
            });
        }

        var pixBox = document.getElementById('pix-box');
        var qrEl   = document.getElementById('pix-qrcode');
        qrEl.innerHTML = '';
        if (payload) {
            pixBox.style.display = '';
            if (typeof QRCode !== 'undefined') {
                new QRCode(qrEl, { text: payload, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
            }
            var copyBtn = document.getElementById('pix-copy');
            copyBtn.style.display = '';
            copyBtn.onclick = function() {
                navigator.clipboard.writeText(payload).then(function() {
                    copyBtn.textContent = 'Código copiado!';
                    setTimeout(function() { copyBtn.textContent = 'Copiar código PIX'; }, 2500);
                }, function() {
                    // Fallback: exibe o código para cópia manual
                    window.prompt('Copie o código PIX:', payload);
                });
            };
        } else {
            pixBox.style.display = 'none';
        }

        var instructions = document.getElementById('pix-instructions');
        instructions.textContent = ev.payment_instructions || '';
        instructions.style.display = ev.payment_instructions ? '' : 'none';
    }

    // ── Contato: detecta e-mail × telefone e formata em tempo real ──
    // Tem letra ou @ → e-mail; só dígitos/sinais → telefone.
    function isEmail(v)      { return /[a-zA-Z@]/.test(v); }
    function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

    // Máscara de telefone brasileiro: aceita +55 opcional, DDD e corpo
    // 8 (fixo, 4-4) ou 9 dígitos (celular, 5-4). Sem separador "preso":
    // os parênteses/traço só entram quando há dígito depois.
    function maskPhoneBR(value) {
        var hasCountry = /^\s*\+/.test(value);
        var d = value.replace(/\D/g, '');
        var cc = '';
        if (hasCountry) { cc = d.slice(0, 2); d = d.slice(2); }
        d = d.slice(0, 11);                       // DDD (2) + até 9 dígitos
        var out = hasCountry ? '+' + cc : '';
        if (!d) return out;
        if (d.length <= 2) {
            out += (hasCountry ? ' ' : '') + '(' + d;
        } else {
            var ddd  = d.slice(0, 2);
            var body = d.slice(2);
            out += (hasCountry ? ' ' : '') + '(' + ddd + ') ';
            out += body.length <= 4
                ? body
                : body.slice(0, body.length - 4) + '-' + body.slice(body.length - 4);
        }
        return out;
    }

    function phoneDigitCount(v) {
        var d = v.replace(/\D/g, '');
        if (/^\s*\+/.test(v)) d = d.slice(2);     // desconta o código do país
        return d.length;
    }

    function setupContactField() {
        var input = document.getElementById('reserve-contact');
        if (!input) return;

        // Formata em tempo real, mas sem mensagens de "válido": a verificação
        // do e-mail só é mostrada ao enviar (deixa a digitação mais limpa).
        input.addEventListener('input', function() {
            if (!this.value.trim()) { this.removeAttribute('inputmode'); return; }

            if (isEmail(this.value)) {
                // virou e-mail: remove resíduos da máscara de telefone
                // (parênteses e espaços) caso tenha começado com dígitos,
                // ex.: "(12) 3eusou…" → "123eusou…"
                var cleaned = this.value.replace(/[()\s]/g, '');
                if (cleaned !== this.value) this.value = cleaned;
                this.setAttribute('inputmode', 'email');
            } else {
                // telefone: aplica a máscara brasileira enquanto digita
                this.setAttribute('inputmode', 'tel');
                this.value = maskPhoneBR(this.value);
            }
        });
    }

    function setupReserveModal(reloadGrid, clearSelection) {
        var modal = document.getElementById('reserve-modal');
        if (!modal) return;
        setupContactField();

        document.getElementById('reserve-modal-close').addEventListener('click', closeReserveModal);
        document.getElementById('reserve-done').addEventListener('click', closeReserveModal);
        modal.addEventListener('click', function(e) { if (e.target === modal) closeReserveModal(); });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && modal.style.display === 'flex') closeReserveModal();
        });

        document.getElementById('reserve-form').addEventListener('submit', async function(e) {
            e.preventDefault();
            var name    = document.getElementById('reserve-name').value.trim();
            var contact = document.getElementById('reserve-contact').value.trim();
            var website = document.getElementById('reserve-website').value;

            if (name.length < 2) { showReserveError(ERROR_MESSAGES.NOME_INVALIDO); return; }
            if (isEmail(contact)) {
                if (!isValidEmail(contact)) { showReserveError('Confira o e-mail informado (ex.: nome@email.com).'); return; }
            } else if (phoneDigitCount(contact) < 10) {
                showReserveError('Informe um telefone com DDD (ex.: (11) 98765-4321).'); return;
            }

            var submitBtn = document.getElementById('reserve-submit');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Reservando…';
            document.getElementById('reserve-error').style.display = 'none';

            try {
                var result = await fetchJson('rpc/create_reservation', {
                    body: {
                        p_event_id: modalState.event.id,
                        p_name:     name,
                        p_contact:  contact,
                        p_items:    modalState.items,
                        p_website:  website
                    }
                });
                modalState.total = result.total;   // total autoritativo do banco
                showSuccess();
                if (clearSelection) clearSelection();
                if (reloadGrid) reloadGrid();
            } catch (err) {
                showReserveError(friendlyError(err));
                submitBtn.disabled = false;
                submitBtn.textContent = 'Confirmar reserva';
                // Conflito de número: atualiza a grade para refletir a realidade
                if (err.code && err.code.indexOf('NUMERO_INDISPONIVEL') !== -1 && reloadGrid) reloadGrid();
            }
        });
    }

    // ── Página dedicada ─────────────────────────────────────────
    async function renderEventPage(area, ev) {
        area.innerHTML = '';

        var totals = null;
        try {
            var totalsRows = await fetchJson('event_totals?event_id=eq.' + ev.id);
            totals = totalsRows && totalsRows[0];
        } catch (e) { /* totais são opcionais */ }

        area.appendChild(buildEventHeader(ev, totals));

        if (ev.type === 'rifa') {
            var gridContainer = document.createElement('div');
            area.appendChild(gridContainer);

            // Barra de ação fixa (mobile-first): aparece ao selecionar números
            var actionBar = document.createElement('div');
            actionBar.className = 'raffle-actionbar';
            actionBar.style.display = 'none';
            area.appendChild(actionBar);

            var maxPer    = ev.raffle_max_per_reservation || 5;
            var openForRes = isOpenForReservations(ev);
            var selected  = [];   // números escolhidos, na ordem de clique

            // Reflete a seleção e o limite nas células já renderizadas
            function updateCells() {
                var atMax = selected.length >= maxPer;
                var cells = gridContainer.querySelectorAll('.raffle-cell');
                cells.forEach(function(cell) {
                    if (cell.classList.contains('is-taken') || cell.disabled) return;
                    var num   = parseInt(cell.dataset.number, 10);
                    var isSel = selected.indexOf(num) !== -1;
                    cell.classList.toggle('is-selected', isSel);
                    cell.classList.toggle('is-limited', atMax && !isSel);
                    cell.setAttribute('aria-pressed', isSel ? 'true' : 'false');
                });
            }

            function renderActionBar() {
                document.body.classList.toggle('has-raffle-bar', selected.length > 0);
                if (!selected.length) { actionBar.style.display = 'none'; actionBar.innerHTML = ''; return; }
                var nums  = selected.slice().sort(function(a, b) { return a - b; });
                var count = nums.length;
                var total = count * Number(ev.raffle_number_price || 0);
                actionBar.style.display = '';
                actionBar.innerHTML =
                    '<div class="raffle-actionbar-info">' +
                        '<strong>' + count + (count > 1 ? ' números selecionados' : ' número selecionado') + '</strong>' +
                        '<span class="raffle-actionbar-nums">' + nums.join(', ') + '</span>' +
                        '<span class="raffle-actionbar-total">' + formatMoney(total) + '</span>' +
                        (count >= maxPer ? '<span class="raffle-actionbar-limit">Limite de ' + maxPer + ' por reserva atingido</span>' : '') +
                    '</div>' +
                    '<div class="raffle-actionbar-buttons">' +
                        '<button type="button" class="raffle-clear" id="raffle-clear">Limpar</button>' +
                        '<button type="button" class="raffle-reserve" id="raffle-reserve">Reservar</button>' +
                    '</div>';
            }

            function refreshSelection() { updateCells(); renderActionBar(); }

            function toggleSelect(num) {
                var idx = selected.indexOf(num);
                if (idx !== -1) {
                    selected.splice(idx, 1);
                } else if (selected.length < maxPer) {
                    selected.push(num);
                } else {
                    return; // no limite: ignora novas seleções (células ficam esmaecidas)
                }
                refreshSelection();
            }

            async function loadGrid() {
                var taken = {};
                try {
                    var board = await fetchJson('raffle_board?event_id=eq.' + ev.id);
                    board.forEach(function(entry) { taken[entry.raffle_number] = entry; });
                } catch (e) { /* grade sem nomes é melhor que nada */ }
                gridContainer.innerHTML = '';
                gridContainer.appendChild(buildRaffleGrid(ev, taken, openForRes));
                // remove da seleção números que outra pessoa tomou nesse meio tempo
                selected = selected.filter(function(n) { return !taken[n]; });
                refreshSelection();
            }

            function clearSelection() { selected = []; refreshSelection(); }

            gridContainer.addEventListener('click', function(e) {
                var cell = e.target.closest('.raffle-cell');
                if (!cell || cell.disabled || cell.classList.contains('is-taken') || !openForRes) return;
                toggleSelect(parseInt(cell.dataset.number, 10));
            });

            actionBar.addEventListener('click', function(e) {
                if (e.target.closest('#raffle-reserve')) {
                    if (selected.length) openRaffleReserveModal(ev, selected.slice().sort(function(a, b) { return a - b; }));
                } else if (e.target.closest('#raffle-clear')) {
                    clearSelection();
                }
            });

            setupReserveModal(loadGrid, clearSelection);
            await loadGrid();
        } else {
            await renderSaleSection(area, ev);
        }
    }

    // ── Venda de produtos: vitrine + carrinho + reserva ─────────

    // Ícone de régua (inline, currentColor) do botão "Medidas".
    var RULER_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M15.4 22H8.6C8.26863 22 8 21.7314 8 21.4V2.6C8 2.26863 8.26863 2 8.6 2H15.4C15.7314 2 16 2.26863 16 2.6V21.4C16 21.7314 15.7314 22 15.4 22Z"/>' +
        '<path d="M16 17H13"/><path d="M16 7H13"/>' +
        '<path d="M13 12H23M23 12L21 14M23 12L21 10"/>' +
        '<path d="M1 12L3 10M1 12L3 14M1 12H8"/>' +
        '</svg>';

    function hasSizeChart(product) {
        return !!(product.size_chart_image || (Array.isArray(product.size_chart) && product.size_chart.length));
    }

    // Galeria do card (até 3 imagens): trilho deslizante + pontos.
    // Mobile: swipe + pontos. Desktop: também setas (em hover, via CSS) e
    // arrastar com o mouse. As setas ficam escondidas no mobile.
    function saleGalleryHtml(imgs, name) {
        var slides = imgs.map(function(u) {
            return '<img src="' + esc(u) + '" alt="' + esc(name) + '" loading="lazy" draggable="false">';
        }).join('');
        var extras = imgs.length > 1 ?
            '<div class="sale-gallery-dots">' + imgs.map(function(_u, i) {
                return '<span class="sale-gallery-dot' + (i === 0 ? ' is-active' : '') + '" data-i="' + i + '"></span>';
            }).join('') + '</div>' +
            '<button type="button" class="sale-gallery-arrow sale-gallery-prev" aria-label="Imagem anterior">‹</button>' +
            '<button type="button" class="sale-gallery-arrow sale-gallery-next" aria-label="Próxima imagem">›</button>' : '';
        return '<div class="sale-card-gallery" data-idx="0" data-count="' + imgs.length + '">' +
                  '<div class="sale-gallery-track">' + slides + '</div>' + extras +
               '</div>';
    }

    // Move a galeria para o slide idx (com clamp) e atualiza os pontos.
    function setSlide(gallery, idx) {
        var count = parseInt(gallery.dataset.count, 10) || 1;
        idx = Math.max(0, Math.min(count - 1, idx));
        gallery.dataset.idx = idx;
        gallery.querySelector('.sale-gallery-track').style.transform = 'translateX(' + (-idx * 100) + '%)';
        gallery.querySelectorAll('.sale-gallery-dot').forEach(function(d, i) {
            d.classList.toggle('is-active', i === idx);
        });
    }

    // Liga setas, pontos, swipe (mobile) e arrastar-com-mouse (desktop) das
    // galerias dentro de `root`.
    function wireGalleries(root) {
        root.querySelectorAll('.sale-card-gallery').forEach(function(gallery) {
            var swiped = false;   // evita abrir o lightbox ao terminar swipe/drag
            function go(dir) { setSlide(gallery, (+gallery.dataset.idx) + dir); }
            function markSwiped() { swiped = true; setTimeout(function() { swiped = false; }, 50); }

            gallery.addEventListener('click', function(e) {
                var arrow = e.target.closest('.sale-gallery-arrow');
                if (arrow) { go(arrow.classList.contains('sale-gallery-next') ? 1 : -1); return; }
                var dot = e.target.closest('.sale-gallery-dot');
                if (dot) { setSlide(gallery, parseInt(dot.dataset.i, 10)); return; }
                if (!swiped && e.target.closest('.sale-gallery-track')) {
                    var srcs = Array.prototype.map.call(
                        gallery.querySelectorAll('.sale-gallery-track img'),
                        function(im) { return im.src; });
                    openLightbox(srcs, +gallery.dataset.idx);
                }
            });

            // Swipe (mobile).
            var x0 = null;
            gallery.addEventListener('touchstart', function(e) { x0 = e.touches[0].clientX; }, { passive: true });
            gallery.addEventListener('touchend', function(e) {
                if (x0 === null) return;
                var dx = e.changedTouches[0].clientX - x0;
                if (Math.abs(dx) > 40) { go(dx < 0 ? 1 : -1); markSwiped(); }
                x0 = null;
            });

            // Arrastar com o mouse (desktop), espelhando o swipe. O listener de
            // mouseup é ligado só durante o arraste (não vaza ao re-renderizar).
            var mx0 = null;
            function onUp(e) {
                document.removeEventListener('mouseup', onUp);
                if (mx0 === null) return;
                var dx = e.clientX - mx0;
                mx0 = null;
                if (Math.abs(dx) > 40) { go(dx < 0 ? 1 : -1); markSwiped(); }
            }
            gallery.addEventListener('mousedown', function(e) {
                if (e.button !== 0 || !e.target.closest('.sale-gallery-track')) return;
                mx0 = e.clientX;
                e.preventDefault();   // impede seleção/arraste-fantasma da imagem
                document.addEventListener('mouseup', onUp);
            });
        });
    }

    // Modal de medidas (singleton, criado sob demanda). Mostra a imagem da
    // tabela OU a tabela manual (rótulo/valor).
    function ensureMeasureModal() {
        var m = document.getElementById('measure-modal');
        if (m) return m;
        m = document.createElement('div');
        m.id = 'measure-modal';
        m.className = 'measure-modal';
        m.style.display = 'none';
        m.innerHTML =
            '<div class="measure-modal-content">' +
                '<button type="button" class="measure-modal-close" aria-label="Fechar">&times;</button>' +
                '<h3 class="measure-modal-title">Tabela de medidas</h3>' +
                '<div class="measure-modal-body"></div>' +
            '</div>';
        document.body.appendChild(m);
        function close() { m.style.display = 'none'; }
        m.addEventListener('click', function(e) {
            if (e.target === m || e.target.closest('.measure-modal-close')) close();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && m.style.display !== 'none') close();
        });
        return m;
    }

    // Carrega a imagem da tabela refletindo o estado real: spinner enquanto
    // baixa, a imagem ao concluir, ou um erro com "Tentar novamente" se falhar.
    // `bust` força nova requisição (usado no retry).
    function renderMeasureImage(body, product, bust) {
        body.innerHTML =
            '<div class="measure-loading" role="status">' +
                '<span class="measure-spinner" aria-hidden="true"></span>' +
                '<span>Carregando tabela…</span>' +
            '</div>' +
            '<img class="measure-img" alt="Tabela de medidas de ' + esc(product.name) + '" style="display:none">';
        var img    = body.querySelector('.measure-img');
        var status = body.querySelector('.measure-loading');
        img.onload = function() {
            status.remove();
            img.style.display = 'block';
        };
        img.onerror = function() {
            status.className = 'measure-error';
            status.innerHTML =
                '<span>Não foi possível carregar a tabela de medidas. Verifique sua conexão.</span>' +
                '<button type="button" class="measure-retry">Tentar novamente</button>';
            status.querySelector('.measure-retry').addEventListener('click', function() {
                renderMeasureImage(body, product, true);
            });
        };
        var src = product.size_chart_image;
        if (bust) src += (src.indexOf('?') === -1 ? '?' : '&') + 'r=' + Date.now();
        img.src = src;   // src depois dos handlers: dispara onload mesmo se cacheada
    }

    function openMeasureModal(product) {
        var m = ensureMeasureModal();
        m.querySelector('.measure-modal-title').textContent = 'Medidas — ' + product.name;
        var body = m.querySelector('.measure-modal-body');
        if (product.size_chart_image) {
            renderMeasureImage(body, product, false);
        } else {
            var rows = (product.size_chart || []).map(function(r) {
                return '<tr><th>' + esc(r.label) + '</th><td>' + esc(r.value) + '</td></tr>';
            }).join('');
            body.innerHTML = '<table class="measure-table">' + rows + '</table>';
        }
        m.style.display = 'flex';
    }

    // Lightbox: toque na imagem do card amplia em tela cheia (com navegação).
    function ensureLightbox() {
        var lb = document.getElementById('sale-lightbox');
        if (lb) return lb;
        lb = document.createElement('div');
        lb.id = 'sale-lightbox';
        lb.className = 'sale-lightbox';
        lb.style.display = 'none';
        lb.innerHTML =
            '<button type="button" class="sale-lightbox-close" aria-label="Fechar">&times;</button>' +
            '<button type="button" class="sale-lightbox-arrow sale-lightbox-prev" aria-label="Imagem anterior">‹</button>' +
            '<img class="sale-lightbox-img" alt="">' +
            '<button type="button" class="sale-lightbox-arrow sale-lightbox-next" aria-label="Próxima imagem">›</button>';
        document.body.appendChild(lb);
        function close() { lb.style.display = 'none'; lb._srcs = null; }
        function show(i) {
            var srcs = lb._srcs || [];
            if (!srcs.length) return;
            lb._idx = (i + srcs.length) % srcs.length;
            lb.querySelector('.sale-lightbox-img').src = srcs[lb._idx];
            var multi = srcs.length > 1 ? '' : 'none';
            lb.querySelector('.sale-lightbox-prev').style.display = multi;
            lb.querySelector('.sale-lightbox-next').style.display = multi;
        }
        lb._show = show;
        lb.addEventListener('click', function(e) {
            if (e.target.closest('.sale-lightbox-next'))      show(lb._idx + 1);
            else if (e.target.closest('.sale-lightbox-prev')) show(lb._idx - 1);
            else if (e.target === lb || e.target.closest('.sale-lightbox-close')) close();
        });
        document.addEventListener('keydown', function(e) {
            if (lb.style.display === 'none') return;
            if (e.key === 'Escape')           close();
            else if (e.key === 'ArrowRight')  show(lb._idx + 1);
            else if (e.key === 'ArrowLeft')   show(lb._idx - 1);
        });
        var x0 = null;
        lb.addEventListener('touchstart', function(e) { x0 = e.touches[0].clientX; }, { passive: true });
        lb.addEventListener('touchend', function(e) {
            if (x0 === null) return;
            var dx = e.changedTouches[0].clientX - x0;
            if (Math.abs(dx) > 40) show(lb._idx + (dx < 0 ? 1 : -1));
            x0 = null;
        });
        return lb;
    }

    function openLightbox(srcs, idx) {
        var lb = ensureLightbox();
        lb._srcs = srcs;
        lb.style.display = 'flex';
        lb._show(idx || 0);
    }

    function buildProductCard(product, idx, openForRes) {
        var card = document.createElement('div');
        card.className = 'sale-card';
        card.dataset.index = idx;
        var imgs  = Array.isArray(product.images) ? product.images.filter(function(u) { return u; }) : [];
        var attrs = Array.isArray(product.attributes) ? product.attributes : [];

        // Cabeçalho: "Nome | Preço"
        var html = '<div class="sale-card-title">' +
                       '<span class="sale-card-name">' + esc(product.name) + '</span>' +
                       '<span class="sale-card-sep">|</span>' +
                       '<span class="sale-card-price">' + formatMoney(product.price) + '</span>' +
                   '</div>';

        // Corpo: imagem (esq.) + opções (dir.). Sem imagem → opções ocupam tudo.
        html += '<div class="sale-card-main' + (imgs.length ? '' : ' sale-card-main--nomedia') + '">';
        if (imgs.length)
            html += '<div class="sale-card-media">' + saleGalleryHtml(imgs, product.name) + '</div>';

        html += '<div class="sale-card-options">';
        if (attrs.length) html += '<p class="sale-options-head">Escolha Seu Modelo</p>';
        attrs.forEach(function(attr) {
            var opts = attr.options || [];
            var single = opts.length === 1;   // opção única: já vem selecionada
            html += '<label class="sale-attr"><span>' + esc(attr.name) + '</span>' +
                    '<select class="sale-attr-select" data-attr="' + esc(attr.name) + '">';
            if (!single) html += '<option value="">Selecione…</option>';
            opts.forEach(function(opt) {
                html += '<option value="' + esc(opt) + '"' + (single ? ' selected' : '') + '>' + esc(opt) + '</option>';
            });
            html += '</select></label>';
        });
        if (hasSizeChart(product))
            html += '<button type="button" class="sale-measure-btn">' + RULER_ICON + '<span>Medidas</span></button>';
        if (openForRes) {
            html += '<div class="sale-card-actions">' +
                    '<input type="number" class="sale-qty" min="1" max="100" value="1" aria-label="Quantidade">' +
                    '<button type="button" class="sale-add">Adicionar ao pedido</button>' +
                    '</div>' +
                    '<p class="sale-card-msg" style="display:none"></p>';
        } else {
            html += '<p class="sale-card-msg sale-card-closed">Pedidos encerrados.</p>';
        }
        html += '</div></div>';   // .sale-card-options + .sale-card-main
        card.innerHTML = html;
        return card;
    }

    async function renderSaleSection(area, ev) {
        var products = [];
        try {
            products = await fetchJson('event_products?event_id=eq.' + ev.id + '&order=sort_order.asc,created_at.asc');
        } catch (e) { /* lista vazia abaixo */ }

        if (!products || !products.length) {
            var note = document.createElement('p');
            note.className = 'event-sale-note';
            note.textContent = 'Os produtos deste evento ainda não foram cadastrados. Acompanhe nossas redes sociais!';
            area.appendChild(note);
            return;
        }

        var openForRes = isOpenForReservations(ev);
        var order = [];   // { product, variation:{}, quantity }

        var section = document.createElement('div');
        section.className = 'sale-section';
        var grid = document.createElement('div');
        grid.className = 'sale-grid';
        section.appendChild(grid);
        area.appendChild(section);
        products.forEach(function(p, i) { grid.appendChild(buildProductCard(p, i, openForRes)); });
        wireGalleries(grid);

        // Painel do pedido (carrinho) + barra de ação fixa (reusa estilos da rifa)
        var orderPanel = document.createElement('div');
        orderPanel.className = 'sale-order';
        orderPanel.style.display = 'none';
        section.appendChild(orderPanel);

        var actionBar = document.createElement('div');
        actionBar.className = 'raffle-actionbar';
        actionBar.style.display = 'none';
        area.appendChild(actionBar);

        function renderOrder() {
            var totalItems = order.reduce(function(a, o) { return a + o.quantity; }, 0);
            var total      = order.reduce(function(a, o) { return a + o.quantity * Number(o.product.price || 0); }, 0);
            document.body.classList.toggle('has-raffle-bar', order.length > 0);
            if (!order.length) {
                orderPanel.style.display = 'none'; orderPanel.innerHTML = '';
                actionBar.style.display  = 'none'; actionBar.innerHTML  = '';
                return;
            }
            orderPanel.style.display = '';
            orderPanel.innerHTML = '<h3>Seu pedido</h3>' + order.map(function(o, i) {
                var v = variationLabel(o.variation);
                return '<div class="sale-order-row">' +
                    '<span class="sale-order-name">' + esc(o.product.name) + (v ? ' <small>' + esc(v) + '</small>' : '') + '</span>' +
                    '<span class="sale-order-qty">' + o.quantity + 'x ' + formatMoney(o.product.price) + '</span>' +
                    '<span class="sale-order-line">' + formatMoney(o.quantity * o.product.price) + '</span>' +
                    '<button type="button" class="sale-order-remove" data-i="' + i + '" aria-label="Remover item">&times;</button>' +
                    '</div>';
            }).join('');
            actionBar.style.display = '';
            actionBar.innerHTML =
                '<div class="raffle-actionbar-info">' +
                    '<strong>' + totalItems + (totalItems > 1 ? ' itens no pedido' : ' item no pedido') + '</strong>' +
                    '<span class="raffle-actionbar-total">' + formatMoney(total) + '</span>' +
                '</div>' +
                '<div class="raffle-actionbar-buttons">' +
                    '<button type="button" class="raffle-clear" id="sale-clear">Limpar</button>' +
                    '<button type="button" class="raffle-reserve" id="sale-reserve">Reservar</button>' +
                '</div>';
        }

        function clearOrder() { order = []; renderOrder(); }

        grid.addEventListener('click', function(e) {
            var measure = e.target.closest('.sale-measure-btn');
            if (measure) {
                var mc = measure.closest('.sale-card');
                openMeasureModal(products[parseInt(mc.dataset.index, 10)]);
                return;
            }
            var add = e.target.closest('.sale-add');
            if (!add || !openForRes) return;
            var card = add.closest('.sale-card');
            var product = products[parseInt(card.dataset.index, 10)];
            var msg = card.querySelector('.sale-card-msg');

            var variation = {};
            var ok = true;
            card.querySelectorAll('.sale-attr-select').forEach(function(sel) {
                if (!sel.value) ok = false; else variation[sel.dataset.attr] = sel.value;
            });
            if (!ok) {
                msg.textContent = 'Escolha todas as opções antes de adicionar.';
                msg.style.display = '';
                return;
            }
            msg.style.display = 'none';

            var qty = parseInt(card.querySelector('.sale-qty').value, 10);
            if (isNaN(qty) || qty < 1) qty = 1;
            if (qty > 100) qty = 100;

            // mesma combinação produto+variação acumula quantidade
            var vKey = JSON.stringify(variation);
            var existing = order.filter(function(o) {
                return o.product.id === product.id && JSON.stringify(o.variation) === vKey;
            })[0];
            if (existing) existing.quantity = Math.min(100, existing.quantity + qty);
            else order.push({ product: product, variation: variation, quantity: qty });
            renderOrder();
        });

        orderPanel.addEventListener('click', function(e) {
            var rm = e.target.closest('.sale-order-remove');
            if (!rm) return;
            order.splice(parseInt(rm.dataset.i, 10), 1);
            renderOrder();
        });

        actionBar.addEventListener('click', function(e) {
            if (e.target.closest('#sale-reserve')) {
                if (order.length) openSaleReserveModal(ev, order);
            } else if (e.target.closest('#sale-clear')) {
                clearOrder();
            }
        });

        setupReserveModal(null, clearOrder);
    }

    function renderEmpty(area) {
        area.innerHTML = '';
        var empty = document.createElement('p');
        empty.className = 'events-empty';
        empty.textContent = 'Nenhum evento ativo no momento. Acompanhe nossas redes sociais para saber das próximas campanhas!';
        area.appendChild(empty);
    }

    async function init() {
        var banner = document.getElementById('event-banner');
        var area   = document.getElementById('event-area');
        if (!banner && !area) return;

        try {
            var active = await fetchJson('events?status=eq.ativo&limit=1');
            var ev = active && active[0];

            if (banner) {
                var section = banner.closest('#events-section');
                if (ev) {
                    section.style.display = '';
                    renderHomeBanner(banner, ev);
                } else {
                    section.style.display = 'none';
                }
            }

            if (area) {
                if (ev) {
                    await renderEventPage(area, ev);
                } else {
                    renderEmpty(area);
                }

                // Histórico: últimos eventos encerrados/arquivados
                try {
                    var past = await fetchJson('events?status=in.(encerrado,arquivado)&order=ends_at.desc&limit=3');
                    if (past && past.length) {
                        document.getElementById('past-events').style.display = '';
                        renderPastEvents(document.getElementById('past-events-list'), past);
                    }
                } catch (e) { /* histórico é opcional */ }
            }
        } catch (err) {
            if (banner) banner.closest('#events-section').style.display = 'none';
            if (area) renderEmpty(area);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
