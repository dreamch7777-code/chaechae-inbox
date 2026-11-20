import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const path = new URL('./gift-checkout-flow.js', import.meta.url);
const flow = fs.existsSync(path) ? require('./gift-checkout-flow.js') : {};
const card = { id: 'card-1', name: '받는 분', kakaoRoomId: 'room-1' };
const line = { it: { productId: 42, productName: '커피', price: 5000 }, picked: ['뜨거운'], qty: 2 };
const intent = () => flow.createIntent(card, line, 11000, 'inbox-test-1');
const ready = () => ({ ok: true, status: 'ready_for_user_payment', cardId: 'card-1', purchaseId: 'inbox-test-1', intentFingerprint: 'fingerprint-1', productId: '42', quantity: 2, optionLabels: ['뜨거운'], total: 10500, recipient: { roomId: 'room-1', displayName: '받는 분' }, paymentActionTaken: false, finalPaymentByUser: true });

test('checkout request binds recipient and explicit cap independently of merchandise estimate', () => {
  assert.equal(typeof flow.createIntent, 'function');
  const i = intent();
  assert.equal(i.expectedTotal, 10000);
  assert.equal(i.spendingLimit, 11000);
  assert.equal(i.productId, '42');
  assert.equal(i.roomId, 'room-1');
  for (const cap of [0, -1, NaN, Infinity, 9999, 10500.5, '11000']) assert.throws(() => flow.createIntent(card, line, cap, 'inbox-test-1'));
});
test('pending order blocks duplicates and persists only recovery metadata', () => {
  assert.equal(typeof flow.begin, 'function');
  const p = flow.begin(null, intent());
  assert.equal(p.status, 'preparing');
  assert.throws(() => flow.begin(p, intent()), /pending/i);
  const saved = flow.restore(flow.serialize({ ...p, bill: { cardNumber: 'private' }, code: 'secret', checkoutUrl: 'private' }));
  assert.equal(saved.purchaseId, 'inbox-test-1');
  assert.equal(saved.bill, undefined);
  assert.equal(saved.code, undefined);
  assert.equal(saved.checkoutUrl, undefined);
  assert.equal(flow.restore('{bad'), null);
});
test('ready bill requires exact intent, recipient, cap and no automatic payment', () => {
  assert.equal(typeof flow.bindReady, 'function');
  const p = flow.bindReady(intent(), ready());
  assert.equal(p.total, 10500);
  for (const patch of [{ cardId: 'wrong' }, { purchaseId: 'other' }, { productId: '43' }, { quantity: 1 }, { optionLabels: ['차가운'] }, { total: 11001 }, { total: '10500' }, { paymentActionTaken: true }, { finalPaymentByUser: false }, { recipient: { roomId: 'room-2', displayName: '받는 분' } }, { recipient: { roomId: 'room-1', displayName: '다른 분' } }]) assert.throws(() => flow.bindReady(intent(), { ...ready(), ...patch }));
});
test('only verified and fully bound paid status provides gift draft, never sends', () => {
  assert.equal(typeof flow.paidDraft, 'function');
  const p = flow.bindReady(intent(), ready());
  const paid = { ...ready(), status: 'paid', paymentVerified: true, codes: [{ code: 'CODE-1', link: 'https://gift.kakao.com/receive/abc' }, { code: 'CODE-2', link: 'https://gift.kakao.com/receive/def' }] };
  assert.deepEqual(flow.paidDraft(p, paid), ['커피 선물이야 !! 🎁', 'https://gift.kakao.com/receive/abc', 'https://gift.kakao.com/receive/def']);
  for (const patch of [{ paymentVerified: false }, { paymentActionTaken: true }, { finalPaymentByUser: false }, { intentFingerprint: 'other' }, { purchaseId: 'other' }, { cardId: 'other' }, { total: 10400 }, { recipient: { roomId: 'room-2', displayName: '받는 분' } }, { productId: '43' }, { codes: [] }, { codes: [{ link: 'https://evil.example/gift' }, { code: 'TWO' }] }, { codes: [{ link: 'https://gift.kakao.com.evil.example/gift' }, { code: 'TWO' }] }, { codes: [{ link: 'https://user:pass@gift.kakao.com/gift' }, { code: 'TWO' }] }, { codes: [{ code: 'SAME' }, { code: 'SAME' }] }]) assert.throws(() => flow.paidDraft(p, { ...paid, ...patch }));
  for (const status of ['waiting', 'ready_for_user_payment', 'not_paid', 'failed', 'cancelled', 'hold']) assert.equal(flow.paidDraft(p, { ...ready(), status }), null);
});
test('recovery keeps same purchase and rejects malformed or foreign pending state', () => {
  assert.equal(typeof flow.belongsTo, 'function');
  const p = flow.bindReady(intent(), ready());
  const recovered = flow.restore(flow.serialize(p));
  assert.equal(recovered.intentFingerprint, 'fingerprint-1');
  assert.equal(flow.belongsTo(recovered, card), true);
  assert.equal(flow.belongsTo(recovered, { ...card, id: 'card-2' }), false);
  assert.equal(flow.belongsTo(recovered, { ...card, name: '다른 분' }), false);
  assert.equal(flow.restore(JSON.stringify({ ...p, spendingLimit: null })), null);
});

test('lost prepare response retains purchase identity and recovery never creates another order', async () => {
  assert.equal(typeof flow.createSession, 'function');
  let stored = null;
  const calls = [];
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async (op, args) => { calls.push({ op, args }); if (calls.length === 1) throw new Error('timeout'); return ready(); } });
  await assert.rejects(session.prepare(intent()), /timeout/);
  assert.equal(stored.purchaseId, 'inbox-test-1');
  await assert.rejects(session.prepare({ ...intent(), purchaseId: 'inbox-other' }), /pending/i);
  await session.recover(card);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => [c.op, c.args.purchaseId]), [['checkout', 'inbox-test-1'], ['checkout', 'inbox-test-1']]);
  assert.equal(stored.status, 'ready_for_user_payment');
});
test('checking is serialized, bound to the same card and retains waiting state', async () => {
  assert.equal(typeof flow.createSession, 'function');
  let stored = flow.bindReady(intent(), ready());
  let release;
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async (op, args) => { assert.equal(op, 'checkout-status'); assert.deepEqual(args, { purchaseId: 'inbox-test-1', intentFingerprint: 'fingerprint-1', cardId: 'card-1' }); return await new Promise(resolve => { release = resolve; }); } });
  await assert.rejects(session.recover({ ...card, id: 'other' }));
  const checking = session.recover(card);
  await assert.rejects(session.recover(card), /busy/i);
  release({ ...ready(), status: 'waiting' });
  assert.equal((await checking).status, 'waiting');
  assert.equal(stored.purchaseId, 'inbox-test-1');
  assert.equal(stored.status, 'waiting');
});

test('verified gift becomes an idempotent draft and cannot change an approved or foreign card', () => {
  assert.equal(typeof flow.draftUpdate, 'function');
  const p = flow.bindReady(intent(), ready());
  const paid = { ...ready(), status: 'paid', paymentVerified: true, codes: [{ code: 'ONE' }, { code: 'TWO' }] };
  const update = flow.draftUpdate({ ...card, status: 'draft', draftMessages: ['안녕'] }, p, paid, ['수정 중인 답장']);
  assert.deepEqual(update.draftMessages, ['수정 중인 답장', '커피 선물이야 !! 🎁', 'ONE', 'TWO']);
  assert.equal(update.status, 'draft');
  assert.equal(update.approval, undefined);
  assert.equal(flow.draftUpdate({ ...card, ...update }, p, paid), null);
  assert.throws(() => flow.draftUpdate({ ...card, status: 'approved' }, p, paid));
  assert.throws(() => flow.draftUpdate({ ...card, status: 'deleted' }, p, paid));
  assert.throws(() => flow.draftUpdate({ ...card, id: 'other', status: 'draft' }, p, paid));
});

test('unknown initial outcome binds fingerprint without fabricating a bill and recovers by status only', async () => {
  let stored = null;
  const calls = [];
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async (op) => { calls.push(op); return calls.length === 1 ? { ...ready(), status: 'waiting', total: null, recoveryRequired: true } : ready(); } });
  await session.prepare(intent());
  assert.equal(stored.intentFingerprint, 'fingerprint-1');
  assert.equal(stored.total, null);
  assert.equal(flow.restore(flow.serialize(stored)).total, null);
  await session.recover(card);
  assert.deepEqual(calls, ['checkout', 'checkout-status']);
  assert.equal(stored.total, 10500);
});

test('replay can recover a verified paid order after prepare response was lost', async () => {
  let stored = flow.begin(null, intent());
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async () => ({ ...ready(), status: 'paid', paymentVerified: true, codes: [{ code: 'ONE' }, { code: 'TWO' }] }) });
  const result = await session.recover(card);
  assert.equal(result.status, 'paid');
  assert.deepEqual(result.draft, ['커피 선물이야 !! 🎁', 'ONE', 'TWO']);
  assert.equal(stored.intentFingerprint, 'fingerprint-1');
});

test('proven rejection before order creation unlocks editing without creating another order', async () => {
  let stored = null;
  let calls = 0;
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async () => { calls++; return { ok: false, status: 'hold', purchaseId: 'inbox-test-1', cardId: 'card-1', orderCreated: false, safeToRetry: true, message: '상한액을 확인해 주세요' }; } });
  await assert.rejects(session.prepare(intent()), /상한액/);
  assert.equal(stored, null);
  assert.equal(calls, 1);
});

test('unbound or uncertain rejection never clears pending order', async () => {
  for (const patch of [{ purchaseId: 'other' }, { cardId: 'other' }, { orderCreated: true }, { orderCreated: undefined }, { safeToRetry: false }, { safeToRetry: undefined }, { status: 'failed' }, { ok: true }]) {
    let stored = null;
    const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async () => ({ ok: false, status: 'hold', purchaseId: 'inbox-test-1', cardId: 'card-1', orderCreated: false, safeToRetry: true, ...patch }) });
    await assert.rejects(session.prepare(intent()));
    assert.equal(stored.purchaseId, 'inbox-test-1');
  }
});

test('over-cap hold preserves actual bill without permitting ready or paid draft', async () => {
  let stored = null;
  const overCap = { ...ready(), status: 'hold', total: 12500, code: 'SPENDING_LIMIT_EXCEEDED' };
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async () => overCap });
  const result = await session.prepare(intent());
  assert.equal(result.draft, null);
  assert.equal(stored.spendingLimit, 11000);
  assert.equal(stored.total, 12500);
  assert.equal(flow.restore(flow.serialize(stored)).total, 12500);
  for (const status of ['ready_for_user_payment', 'paid', 'waiting']) assert.throws(() => flow.verifyStatus(stored, { ...overCap, status }));
});

test('explicit cap revision changes only cap and fingerprint on the same order', async () => {
  let stored = { ...intent(), roomId: 'room-1', intentFingerprint: 'fingerprint-1', status: 'hold', total: 12500 };
  const calls = [];
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async (op, args) => { calls.push({ op, args }); assert.equal(stored.proposedSpendingLimit, 13000); return { ...ready(), total: 12500, spendingLimit: 13000, intentFingerprint: 'fingerprint-2' }; } });
  assert.equal(typeof session.reviseLimit, 'function');
  await assert.rejects(session.reviseLimit(card, 12499));
  assert.equal(calls.length, 0);
  await session.reviseLimit(card, 13000);
  assert.deepEqual(calls, [{ op: 'checkout-revise-limit', args: { cardId: 'card-1', purchaseId: 'inbox-test-1', intentFingerprint: 'fingerprint-1', spendingLimit: 13000 } }]);
  assert.equal(stored.purchaseId, 'inbox-test-1');
  assert.equal(stored.spendingLimit, 13000);
  assert.equal(stored.intentFingerprint, 'fingerprint-2');
  assert.equal(stored.proposedSpendingLimit, undefined);
});

test('lost revision response is persisted and retried with same original fingerprint', async () => {
  let stored = { ...intent(), roomId: 'room-1', intentFingerprint: 'fingerprint-1', status: 'hold', total: 12500 };
  const calls = [];
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async (op, args) => { calls.push({ op, args }); if (calls.length === 1) throw new Error('timeout'); return { ...ready(), total: 12500, spendingLimit: 13000, intentFingerprint: 'fingerprint-2' }; } });
  assert.equal(typeof session.reviseLimit, 'function');
  await assert.rejects(session.reviseLimit(card, 13000), /timeout/);
  stored = flow.restore(flow.serialize(stored));
  assert.equal(stored.proposedSpendingLimit, 13000);
  assert.equal(stored.spendingLimit, 11000);
  await session.recover(card);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(stored.spendingLimit, 13000);
});

test('revision rejects changed gift, wrong cap or unknown payment and keeps proposed intent', async () => {
  for (const patch of [{ cardId: 'other' }, { purchaseId: 'other' }, { productId: '43' }, { quantity: 1 }, { optionLabels: ['다른 옵션'] }, { recipient: { roomId: 'other', displayName: '받는 분' } }, { spendingLimit: 14000 }, { total: 12600 }, { intentFingerprint: 'fingerprint-1' }, { paymentActionTaken: true }, { finalPaymentByUser: false }]) {
    let stored = { ...intent(), roomId: 'room-1', intentFingerprint: 'fingerprint-1', status: 'hold', total: 12500 };
    const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async () => ({ ...ready(), total: 12500, spendingLimit: 13000, intentFingerprint: 'fingerprint-2', ...patch }) });
    assert.equal(typeof session.reviseLimit, 'function');
    await assert.rejects(session.reviseLimit(card, 13000));
    assert.equal(stored.purchaseId, 'inbox-test-1');
    assert.equal(stored.spendingLimit, 11000);
    assert.equal(stored.intentFingerprint, 'fingerprint-1');
    assert.equal(stored.proposedSpendingLimit, 13000);
  }
});

test('cap revision accepts paid replay only after rechecking full payment proof', async () => {
  for (const paymentVerified of [false, true]) {
    let stored = { ...intent(), roomId: 'room-1', intentFingerprint: 'fingerprint-1', status: 'hold', total: 12500 };
    const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, ask: async () => ({ ...ready(), status: 'paid', total: 12500, spendingLimit: 13000, intentFingerprint: 'fingerprint-2', paymentVerified, codes: [{ code: 'ONE' }, { code: 'TWO' }] }) });
    if (!paymentVerified) {
      await assert.rejects(session.reviseLimit(card, 13000));
      assert.equal(stored.spendingLimit, 11000);
      assert.equal(stored.proposedSpendingLimit, 13000);
    } else {
      const result = await session.reviseLimit(card, 13000);
      assert.deepEqual(result.draft, ['커피 선물이야 !! 🎁', 'ONE', 'TWO']);
      assert.equal(stored.spendingLimit, 13000);
      assert.equal(result.pending.purchaseId, 'inbox-test-1');
    }
  }
});

const paymentNow = 1900000000000;
const quoteResponse = () => ({ ...ready(), challengeId: 'challenge-1', quoteFingerprint: 'quote-fingerprint-1', expiresAt: paymentNow + 120000, paymentMethod: { id: 'kakaopay', label: '카카오페이 · 기본 결제 수단', privatePaymentData: 'must-not-persist' } });
test('fresh payment quote is bound to exact gift and does not initiate payment', async () => {
  let stored = flow.bindReady(intent(), ready());
  const calls = [];
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, now: () => paymentNow, ask: async (op,args) => { calls.push({op,args}); return quoteResponse(); } });
  assert.equal(typeof session.paymentQuote, 'function');
  await session.paymentQuote(card);
  assert.deepEqual(calls, [{ op: 'checkout-payment-quote', args: { cardId: 'card-1', purchaseId: 'inbox-test-1', intentFingerprint: 'fingerprint-1' } }]);
  assert.equal(stored.paymentAttemptId, undefined);
  assert.deepEqual(flow.restore(flow.serialize(stored)).paymentQuote, { challengeId: 'challenge-1', quoteFingerprint: 'quote-fingerprint-1', expiresAt: 1900000120000, total: 10500, intentFingerprint: 'fingerprint-1', paymentMethodLabel: '카카오페이 · 기본 결제 수단' });
  assert.equal(flow.serialize(stored).includes('must-not-persist'),false);
});

test('expired or changed quote cannot authorize payment', async () => {
  for (const patch of [{ expiresAt: paymentNow }, { expiresAt: paymentNow + 120001 }, { expiresAt: '1900000120000' }, { total: 10400 }, { cardId: 'other' }, { intentFingerprint: 'other' }, { productId: '43' }, { quantity: 1 }, { optionLabels: ['other'] }, { challengeId: '' }, { quoteFingerprint: '' }, { paymentActionTaken: true }]) {
    let stored = flow.bindReady(intent(), ready());
    const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, now: () => paymentNow, ask: async () => ({ ...quoteResponse(), ...patch }) });
    assert.equal(typeof session.paymentQuote, 'function');
    await assert.rejects(session.paymentQuote(card));
    assert.equal(stored.paymentQuote, undefined);
    assert.equal(stored.paymentAttemptId, undefined);
  }
});

test('explicit payment call persists immutable attempt before transmission and sends direct UI approval', async () => {
  let stored = flow.bindReady(intent(), ready());
  const calls = [];
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, now: () => paymentNow, ask: async (op,args) => {
    calls.push({op,args});
    if (op==='checkout-payment-quote') return quoteResponse();
    assert.equal(stored.paymentAttemptId, 'pay-test-1');
    assert.equal(stored.paymentQuote.challengeId, 'challenge-1');
    return { ...ready(), status: 'waiting', attemptId: 'pay-test-1', paymentState: 'waiting_for_user_auth', paymentActionTaken: true, finalPaymentByUser: false };
  } });
  assert.equal(typeof session.pay, 'function');
  await assert.rejects(session.pay(card, 'pay-test-1'));
  assert.equal(calls.length, 0);
  await session.paymentQuote(card);
  const result = await session.pay(card, 'pay-test-1');
  assert.equal(result.status, 'waiting');
  assert.deepEqual(calls[1], { op: 'checkout-pay', args: { cardId: 'card-1', purchaseId: 'inbox-test-1', intentFingerprint: 'fingerprint-1', total: 10500, attemptId: 'pay-test-1', approval: { challengeId: 'challenge-1', quoteFingerprint: 'quote-fingerprint-1', approvedAt: 1900000000000, expiresAt: 1900000120000, channel: 'direct-ui' } } });
  await assert.rejects(session.pay(card, 'pay-test-2'));
  assert.equal(calls.length, 2);
});

test('reload after lost payment response checks status only and preserves one payment attempt', async () => {
  let stored = flow.bindReady(intent(), ready());
  const calls = [];
  let session = flow.createSession({ read: () => stored, write: p => { stored = p; }, now: () => paymentNow, ask: async (op,args) => { calls.push({op,args}); if(op==='checkout-payment-quote') return quoteResponse(); throw new Error('timeout'); } });
  assert.equal(typeof session.pay, 'function');
  await session.paymentQuote(card);
  await assert.rejects(session.pay(card,'pay-test-1'), /timeout/);
  stored = flow.restore(flow.serialize(stored));
  assert.equal(stored.paymentAttemptId,'pay-test-1');
  assert.equal(stored.paymentState,'payment_uncertain');
  session = flow.createSession({ read: () => stored, write: p => { stored = p; }, now: () => paymentNow + 300000, ask: async (op,args) => { calls.push({op,args}); return { ...ready(), status:'waiting', attemptId:'pay-test-1', paymentState:'payment_uncertain', paymentActionTaken:true, finalPaymentByUser:false }; } });
  await session.recover(card);
  await assert.rejects(session.pay(card,'pay-test-2'));
  await assert.rejects(session.paymentQuote(card));
  assert.deepEqual(calls.map(x=>x.op), ['checkout-payment-quote','checkout-pay','checkout-status']);
  assert.equal(calls[2].args.attemptId,'pay-test-1');
});

test('payment authorization expires before click and foreign cards cannot execute it', async () => {
  let stored = flow.bindReady(intent(), ready()), now = paymentNow;
  let calls = 0;
  const session = flow.createSession({ read: () => stored, write: p => { stored = p; }, now: () => now, ask: async () => { calls++; return quoteResponse(); } });
  assert.equal(typeof session.pay, 'function');
  await session.paymentQuote(card);
  await assert.rejects(session.pay({ ...card, id: 'other' }, 'pay-test-1'));
  now += 120000;
  await assert.rejects(session.pay(card,'pay-test-1'));
  assert.equal(calls,1);
  assert.equal(stored.paymentAttemptId,undefined);
});

test('assisted paid receipt needs bound stored attempt and verified codes', () => {
  const pending = { ...flow.bindReady(intent(),ready()), paymentAttemptId:'pay-test-1', paymentState:'payment_uncertain' };
  const paid = { ...ready(), status:'paid', attemptId:'pay-test-1', paymentActionTaken:true, finalPaymentByUser:false, paymentVerified:true, codes:[{code:'ONE'},{code:'TWO'}] };
  assert.deepEqual(flow.paidDraft(pending,paid), ['커피 선물이야 !! 🎁','ONE','TWO']);
  for (const patch of [{ attemptId:'pay-other' }, { attemptId:undefined }, { paymentVerified:false }, { total:10400 }, { codes:[] }]) assert.throws(()=>flow.paidDraft(pending,{...paid,...patch}));
  assert.throws(()=>flow.paidDraft(flow.bindReady(intent(),ready()),paid));
});

test('changing pending amount or fingerprint invalidates already displayed payment quote', async () => {
  for(const patch of [{total:10400},{intentFingerprint:'other'}]) {
    let stored=flow.bindReady(intent(),ready()), calls=0;
    const session=flow.createSession({read:()=>stored,write:p=>{stored=p;},now:()=>paymentNow,ask:async()=>{calls++;return quoteResponse();}});
    await session.paymentQuote(card);
    stored={...stored,...patch};
    await assert.rejects(session.pay(card,'pay-test-1'));
    assert.equal(calls,1);
    assert.equal(stored.paymentAttemptId,undefined);
  }
});

test('authoritative rejection before any payment attempt releases only the exact rejected approval', async () => {
  let stored=flow.bindReady(intent(),ready());
  const calls=[];
  const session=flow.createSession({read:()=>stored,write:p=>{stored=p;},now:()=>paymentNow,ask:async(op,args)=>{calls.push({op,args});if(op==='checkout-payment-quote')return quoteResponse();return {ok:false,status:'hold',purchaseId:'inbox-test-1',intentFingerprint:'fingerprint-1',attemptId:'pay-test-1',paymentActionTaken:false,finalPaymentByUser:true,paymentAttempted:false,safeToRetryPayment:true,message:'승인 시간이 지났어요'};}});
  await session.paymentQuote(card);
  await assert.rejects(session.pay(card,'pay-test-1'),e=>e.safeToRetryPayment===true);
  assert.equal(stored.paymentAttemptId,undefined);
  assert.equal(stored.paymentQuote,undefined);
  assert.equal(stored.status,'ready_for_user_payment');
  assert.equal(stored.purchaseId,'inbox-test-1');
  await session.paymentQuote(card);
  assert.equal(calls.filter(x=>x.op==='checkout-pay').length,1);
});

test('uncertain or foreign rejection never resets a saved payment attempt', async () => {
  for(const patch of [{purchaseId:'other'},{intentFingerprint:'other'},{attemptId:'pay-other'},{paymentActionTaken:true},{finalPaymentByUser:false},{paymentAttempted:true},{paymentAttempted:undefined},{safeToRetryPayment:false},{safeToRetryPayment:undefined},{ok:true},{status:'waiting'},{cardId:'other'}]) {
    let stored=flow.bindReady(intent(),ready());
    const session=flow.createSession({read:()=>stored,write:p=>{stored=p;},now:()=>paymentNow,ask:async op=>op==='checkout-payment-quote'?quoteResponse():({ok:false,status:'hold',purchaseId:'inbox-test-1',intentFingerprint:'fingerprint-1',attemptId:'pay-test-1',paymentActionTaken:false,finalPaymentByUser:true,paymentAttempted:false,safeToRetryPayment:true,...patch})});
    await session.paymentQuote(card);
    await assert.rejects(session.pay(card,'pay-test-1'));
    assert.equal(stored.paymentAttemptId,'pay-test-1');
    assert.equal(stored.paymentState,'payment_uncertain');
    await assert.rejects(session.pay(card,'pay-test-2'));
  }
});

test('unknown execution with no proven click retains attempt and never resubmits payment', async () => {
  let stored=flow.bindReady(intent(),ready());
  const calls=[];
  const session=flow.createSession({read:()=>stored,write:p=>{stored=p;},now:()=>paymentNow,ask:async(op,args)=>{calls.push({op,args});return op==='checkout-payment-quote'?quoteResponse():({...ready(),status:'waiting',attemptId:'pay-test-1',paymentState:'payment_uncertain',paymentActionTaken:false,finalPaymentByUser:true});}});
  await session.paymentQuote(card);
  await session.pay(card,'pay-test-1');
  assert.equal(stored.paymentAttemptId,'pay-test-1');
  assert.equal(stored.paymentState,'payment_uncertain');
  await session.recover(card);
  await assert.rejects(session.pay(card,'pay-test-2'));
  assert.deepEqual(calls.map(x=>x.op),['checkout-payment-quote','checkout-pay','checkout-status']);
  assert.equal(stored.paymentAttemptId,'pay-test-1');
});

test('assisted latch before financial click accepts false flags only for owned attempt', () => {
  const pending={...flow.bindReady(intent(),ready()),paymentAttemptId:'pay-test-1',paymentState:'payment_uncertain'};
  const waiting={...ready(),status:'waiting',attemptId:'pay-test-1',paymentState:'waiting_for_user_auth',paymentActionTaken:false,finalPaymentByUser:false};
  assert.equal(flow.verifyStatus(pending,waiting),'waiting');
  assert.equal(flow.paidDraft(pending,waiting),null);
  assert.throws(()=>flow.verifyStatus(pending,{...waiting,attemptId:'pay-other'}));
  assert.throws(()=>flow.verifyStatus(pending,{...waiting,attemptId:undefined}));
  assert.throws(()=>flow.verifyStatus(flow.bindReady(intent(),ready()),waiting));
  assert.throws(()=>flow.verifyStatus(pending,{...waiting,paymentActionTaken:undefined}));
});
