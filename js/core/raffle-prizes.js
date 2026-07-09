export const MAX_RAFFLE_PRIZES = 3;

function cleanName(value) {
    return String(value || '').trim();
}

function cleanImage(value) {
    return String(value || '').trim();
}

function cleanWinner(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

export function normalizeRafflePrizes(eventOrPrizes) {
    const ev = Array.isArray(eventOrPrizes) ? null : (eventOrPrizes || {});
    const raw = Array.isArray(eventOrPrizes)
        ? eventOrPrizes
        : (Array.isArray(ev.raffle_prizes) ? ev.raffle_prizes : []);

    let prizes = raw.slice(0, MAX_RAFFLE_PRIZES).map(function(item) {
        return {
            name: cleanName(item && item.name),
            image_url: cleanImage(item && (item.image_url || item.image)),
            winner_number: cleanWinner(item && (item.winner_number || item.winner))
        };
    }).filter(function(item) {
        return item.name || item.image_url || item.winner_number !== null;
    });

    if (!prizes.length && ev && (ev.raffle_prize || ev.raffle_winner_number != null)) {
        prizes = [{
            name: cleanName(ev.raffle_prize),
            image_url: '',
            winner_number: cleanWinner(ev.raffle_winner_number)
        }];
    }

    return prizes;
}

export function emptyRafflePrize() {
    return { name: '', image_url: '', winner_number: null };
}

export function prizeDisplayName(prize, index) {
    return cleanName(prize && prize.name) || ('Prêmio ' + (index + 1));
}
