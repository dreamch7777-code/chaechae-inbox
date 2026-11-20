(function (root) {
  'use strict';
  const check = (ok, message) => { if (!ok) throw new Error(message || '주문 정보가 일치하지 않아요. PC 주문서를 확인해 주세요.'); };
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const amount = value => Number.isSafeInteger(value) && value > 0;
  const sameOptions = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => typeof v === 'string' && v === b[i]);
  function validateIntent(i) {
    check(i && text(i.cardId) && text(i.recipientName) && text(i.productId) && text(i.productName) && /^inbox-[a-zA-Z0-9-]+$/.test(i.purchaseId));
    check(Number.isInteger(i.quantity) && i.quantity >= 1 && i.quantity <= 10 && sameOptions(i.optionLabels, i.optionLabels));
    check(amount(i.expectedTotal) && amount(i.spendingLimit) && i.spendingLimit >= i.expectedTotal, '최대 결제 금액을 상품 예상 금액 이상인 원 단위 숫자로 적어 주세요.');
    check(i.roomId === undefined || text(i.roomId));
  }
  function createIntent(card, line, spendingLimit, purchaseId) {
    const i = { cardId: card.id, recipientName: card.name, ...(card.kakaoRoomId ? { roomId: card.kakaoRoomId } : {}), purchaseId, productId: String(line.it.productId), productName: line.it.productName, quantity: line.qty, optionLabels: [...line.picked], expectedTotal: line.it.price * line.qty, spendingLimit };
    validateIntent(i);
    return i;
  }
  function begin(pending, intent) {
    check(!pending, 'pending: 먼저 준비한 주문의 결제 상태를 확인해 주세요.');
    validateIntent(intent);
    return { ...intent, optionLabels: [...intent.optionLabels], status: 'preparing' };
  }
  function checkBinding(i, r) {
    check(r && r.ok === true && r.cardId === i.cardId && r.purchaseId === i.purchaseId && r.productId === i.productId && r.quantity === i.quantity && sameOptions(r.optionLabels, i.optionLabels));
    check(r.recipient && text(r.recipient.roomId) && r.recipient.displayName === i.recipientName && (!i.roomId || r.recipient.roomId === i.roomId));
    const unknownTotal = r.total === null && ['waiting', 'hold', 'failed', 'cancelled', 'not_paid'].includes(r.status) && !amount(i.total);
    check(unknownTotal || (amount(r.total) && (r.total <= i.spendingLimit || r.status === 'hold')), '최종 결제 금액이 없거나 설정한 최대 금액을 넘었어요. PC 주문서를 확인해 주세요.');
    check(text(r.intentFingerprint));
    if (i.intentFingerprint) check(r.intentFingerprint === i.intentFingerprint && (!amount(i.total) || r.total === i.total));
  }
  function bindReady(intent, response) {
    validateIntent(intent);
    checkBinding(intent, response);
    check(response.status === 'ready_for_user_payment' && response.paymentActionTaken === false && response.finalPaymentByUser === true, '자동 결제 없이 준비된 주문서만 사용할 수 있어요.');
    return { ...intent, roomId: response.recipient.roomId, intentFingerprint: response.intentFingerprint, total: response.total, status: 'ready_for_user_payment' };
  }
  function verifyStatus(pending, response) {
    checkBinding(pending, response);
    check(response.paymentActionTaken === false && response.finalPaymentByUser === true, '사용자가 직접 결제하는 주문인지 확인하지 못했어요.');
    check(['ready_for_user_payment', 'waiting', 'paid', 'failed', 'cancelled', 'not_paid', 'hold'].includes(response.status));
    return response.status;
  }
  function officialGiftLink(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['gift.kakao.com', 'kko.to'].includes(u.hostname); } catch (_) { return false; }
  }
  function paidDraft(pending, response) {
    const status = verifyStatus(pending, response);
    if (status !== 'paid') return null;
    check(response.paymentVerified === true, '결제 완료를 검증하지 못했어요. 다시 상태를 확인해 주세요.');
    check(Array.isArray(response.codes) && response.codes.length === pending.quantity, '선물 코드 수량을 확인하지 못했어요.');
    const gifts = response.codes.map(item => {
      check(item && (text(item.link) || text(item.code)));
      if (item.link) { check(officialGiftLink(item.link), '공식 카카오 선물 링크인지 확인하지 못했어요.'); return item.link; }
      check(text(item.code) && !/https?:|[\r\n]/i.test(item.code));
      return item.code;
    });
    check(new Set(gifts).size === gifts.length, '선물 코드가 중복되어 있어요. 상태를 다시 확인해 주세요.');
    return [pending.productName + ' 선물이야 !! 🎁', ...gifts];
  }
  function belongsTo(pending, card) {
    return !!pending && pending.cardId === card.id && pending.recipientName === card.name && (!card.kakaoRoomId || pending.roomId === card.kakaoRoomId);
  }
  function serialize(pending) {
    if (!pending) return 'null';
    validateIntent(pending);
    const fields = ['cardId', 'recipientName', 'roomId', 'purchaseId', 'productId', 'productName', 'quantity', 'optionLabels', 'expectedTotal', 'spendingLimit', 'proposedSpendingLimit', 'intentFingerprint', 'total', 'status'];
    return JSON.stringify(Object.fromEntries(fields.filter(k => pending[k] !== undefined).map(k => [k, pending[k]])));
  }
  function restore(raw) {
    try {
      const pending = JSON.parse(raw);
      validateIntent(pending);
      check(['preparing', 'ready_for_user_payment', 'waiting', 'hold'].includes(pending.status));
      if (pending.status !== 'preparing') check(text(pending.intentFingerprint) && (amount(pending.total) ? pending.total <= pending.spendingLimit || pending.status === 'hold' : pending.total === null && ['waiting', 'hold'].includes(pending.status)) && text(pending.roomId));
      if (pending.proposedSpendingLimit !== undefined) check(pending.status === 'hold' && amount(pending.total) && amount(pending.proposedSpendingLimit) && pending.proposedSpendingLimit >= pending.total && pending.proposedSpendingLimit > pending.spendingLimit);
      return JSON.parse(serialize(pending));
    } catch (_) { return null; }
  }
  function createSession({ read, write, ask }) {
    let running = false;
    const exclusive = async fn => {
      check(!running, 'busy: 주문 상태를 확인하고 있어요.');
      running = true;
      try { return await fn(); } finally { running = false; }
    };
    async function requestReady(pending) {
      const response = await ask('checkout', JSON.parse(serialize(pending)));
      if (response && response.ok === false && response.status === 'hold' && response.purchaseId === pending.purchaseId && response.cardId === pending.cardId && response.orderCreated === false && response.safeToRetry === true) {
        write(null);
        throw new Error(response.message || '주문서를 만들기 전에 중단했어요. 상품과 최대 결제 금액을 확인해 주세요.');
      }
      const status = verifyStatus(pending, response);
      check(response.paymentActionTaken === false && response.finalPaymentByUser === true, '자동 결제 없이 준비한 주문서만 사용할 수 있어요.');
      const bound = { ...pending, roomId: response.recipient.roomId, intentFingerprint: response.intentFingerprint, total: response.total, status: ['ready_for_user_payment', 'waiting', 'hold'].includes(status) ? status : 'waiting' };
      const draft = paidDraft(bound, response);
      write(bound);
      return { pending: bound, status, response, draft };
    }
    async function requestRevision(pending) {
      const spendingLimit = pending.proposedSpendingLimit;
      const response = await ask('checkout-revise-limit', { cardId: pending.cardId, purchaseId: pending.purchaseId, intentFingerprint: pending.intentFingerprint, spendingLimit });
      check(response && response.spendingLimit === spendingLimit && response.intentFingerprint !== pending.intentFingerprint);
      const revised = { ...pending, spendingLimit, intentFingerprint: undefined };
      const status = verifyStatus(revised, response);
      check(['ready_for_user_payment', 'paid'].includes(status) && response.total === pending.total);
      const bound = { ...pending, spendingLimit, intentFingerprint: response.intentFingerprint, status: status === 'paid' ? 'waiting' : status };
      delete bound.proposedSpendingLimit;
      const draft = paidDraft(bound, response);
      write(bound);
      return { pending: bound, status, response, draft };
    }
    return {
      prepare: intent => exclusive(async () => {
        const pending = begin(read(), intent);
        write(pending);
        return requestReady(pending);
      }),
      recover: card => exclusive(async () => {
        const pending = read();
        check(belongsTo(pending, card), '이 받는 분의 주문이 아니에요. 먼저 준비한 주문의 답장 카드를 열어 주세요.');
        if (pending.proposedSpendingLimit !== undefined) return requestRevision(pending);
        if (!pending.intentFingerprint) return requestReady(pending);
        const response = await ask('checkout-status', { purchaseId: pending.purchaseId, intentFingerprint: pending.intentFingerprint, cardId: pending.cardId });
        const status = verifyStatus(pending, response);
        const draft = paidDraft(pending, response);
        const bound = { ...pending, total: response.total };
        if (['ready_for_user_payment', 'waiting', 'hold'].includes(status)) write({ ...bound, status });
        return { pending: bound, status, response, draft };
      }),
      reviseLimit: (card, spendingLimit) => exclusive(async () => {
        const pending = read();
        check(belongsTo(pending, card), '이 상대의 주문이 아니에요.');
        check(pending.status === 'hold' && amount(pending.total) && pending.total > pending.spendingLimit && text(pending.intentFingerprint) && pending.proposedSpendingLimit === undefined, '진행 중인 최대 금액 수정 결과를 먼저 확인해 주세요.');
        check(amount(spendingLimit) && spendingLimit >= pending.total, '최대 결제 금액을 주문서 최종 금액 이상인 원 단위 숫자로 적어 주세요.');
        const proposed = { ...pending, proposedSpendingLimit: spendingLimit };
        write(proposed);
        return requestRevision(proposed);
      })
    };
  }
  function draftUpdate(card, pending, response, currentLines) {
    check(belongsTo(pending, card), '받는 분의 답장 카드가 달라졌어요.');
    check(!['approved', 'sent', 'skipped', 'deleted'].includes(card.status), '이미 승인하거나 정리한 답장이에요. 선물 코드는 보관하고 새 답장 초안에서 확인해 주세요.');
    const lines = paidDraft(pending, response);
    check(lines);
    if ((card.giftCheckoutPurchases || []).includes(pending.purchaseId)) return null;
    return { draftMessages: [...(currentLines && currentLines.length ? currentLines : (card.draftMessages || [])), ...lines], toneBase: null, status: 'draft', giftCheckoutPurchases: [...(card.giftCheckoutPurchases || []), pending.purchaseId] };
  }
  const api = { createIntent, begin, bindReady, verifyStatus, paidDraft, belongsTo, serialize, restore, createSession, draftUpdate };
  root.GiftCheckout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
