import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const section = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function context(overrides = {}) {
  const state = { mediaUrl: {}, editing: {}, sent: {}, avatars: {}, shotOpen: {}, favs: [], emoOpen: {} };
  const ctx = vm.createContext({ state, esc, URL, Blob, CSS: {escape: x => x}, document: {querySelectorAll: () => []}, setTimeout, console, ...overrides });
  return ctx;
}
function mediaContext(api) {
  const ctx = context({api});
  vm.runInContext(section('state.mediaUrl = {};', 'async function blobOf'), ctx);
  return ctx;
}
test('a second media consumer waits for the same in-flight image', async () => {
  let finish;
  const ctx = mediaContext(() => new Promise(resolve => { finish = resolve; }));
  const first = vm.runInContext("loadMedia('media/photo.jpg')", ctx);
  const second = vm.runInContext("loadMedia('media/photo.jpg')", ctx);
  let secondDone = false; second.then(() => { secondDone = true; });
  await Promise.resolve();
  assert.equal(secondDone, false);
  finish(new Response(new Blob(['image'], {type:'image/jpeg'})));
  await Promise.all([first, second]);
  assert.match(ctx.state.mediaUrl['media/photo.jpg'], /^blob:/);
});
test('a failed HD photo still renders the available thumbnail', async () => {
  const scheduled = [];
  const ctx = mediaContext(async p => p.includes('hd') ? new Response('', {status:404}) : new Response(new Blob(['image'], {type:'image/jpeg'})));
  Object.assign(ctx, { setTimeout: fn => { scheduled.push(fn); }, sendState: () => '', hasBlank: () => false, avatar: () => '', avatarSrc: () => '', whoAvatar: () => '', linkify: x => x, draftLinesHtml: () => '', IC: {}, fmt: x => x });
  vm.runInContext(section('const splitT =', '// 프사(data:'), ctx);
  vm.runInContext(section('function card(c)', '// 보낼 답장:'), ctx);
  ctx.c = {id:'synthetic', name:'테스트', status:'skipped', messages:[{sender:'me', text:'사진', time:'11/22 09:05', img:'media/thumb.jpg', imgHd:['media/hd.jpg']} ]};
  vm.runInContext('card(c)', ctx);
  await Promise.all(scheduled.map(fn => fn()));
  const rendered = vm.runInContext('card(c)', ctx);
  assert.match(rendered, /src="blob:/);
});
test('message ISO timestamps display the Korean date across UTC midnight', () => {
  const ctx = context();
  vm.runInContext(section('const splitT =', '// 프사(data:'), ctx);
  assert.deepEqual(Array.from(vm.runInContext("splitT('2026-11-21T16:05:00Z')", ctx)), ['2026-11-22', '오전 1:05']);
  assert.match(vm.runInContext("dayPill('2026-11-22')", ctx), /2026년 11월 22일 일요일/);
});
test('legacy timestamps retain unknown year rather than guessing a weekday', () => {
  const ctx = context();
  vm.runInContext(section('const splitT =', '// 프사(data:'), ctx);
  assert.deepEqual(Array.from(vm.runInContext("splitT('11/22 13:05')", ctx)), ['11/22', '오후 1:05']);
  const pill = vm.runInContext("dayPill('11/22')", ctx);
  assert.match(pill, /11월 22일/);
  assert.doesNotMatch(pill, /요일|NaN/);
});
test('unavailable image files produce an explicit status instead of an empty photo', async () => {
  const scheduled = [];
  const ctx = mediaContext(async () => new Response('', {status:404}));
  Object.assign(ctx, { setTimeout: fn => { scheduled.push(fn); }, sendState: () => '', hasBlank: () => false, avatar: () => '', avatarSrc: () => '', whoAvatar: () => '', linkify: x => x, draftLinesHtml: () => '', IC: {}, fmt: x => x });
  vm.runInContext(section('const splitT =', '// 프사(data:'), ctx);
  vm.runInContext(section('function card(c)', '// 보낼 답장:'), ctx);
  ctx.c = {id:'synthetic', name:'테스트', status:'skipped', messages:[{sender:'me', text:'사진 2장', time:'11/22 09:05', img:'media/thumb.jpg', imgHd:['media/hd1.jpg','media/hd2.jpg']} ]};
  vm.runInContext('card(c)', ctx);
  await Promise.all(scheduled.map(fn => fn()));
  const rendered = vm.runInContext('card(c)', ctx);
  assert.match(rendered, /사진 파일이 아직 없거나 불러올 수 없어요/);
});
test('DB timestamp takes precedence over a yearless UI timestamp', () => {
  const ctx = context();
  vm.runInContext(section('const splitT =', '// 프사(data:'), ctx);
  ctx.m = {time:'11/21 16:05', dbTimestamp:'2026-11-21T16:05:00Z'};
  assert.deepEqual(Array.from(vm.runInContext('messageTime(m)', ctx)), ['2026-11-22','오전 1:05']);
  assert.deepEqual(Array.from(vm.runInContext("splitT('2026-11-22T00:05:00')", ctx)), ['2026-11-22','오전 12:05']);
});
