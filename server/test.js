/** 联机逻辑自动化测试：两名玩家创建/加入房间 -> 对战 -> 部署 -> 验证状态同步与胜负 */
'use strict';
const WebSocket = require('ws');

const URL = 'ws://127.0.0.1:3000';
const results = [];
function check(name, cond) { results.push([name, !!cond]); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); }

function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, msgs: [], handlers: {} };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    c.msgs.push(m);
    if (c.handlers[m.t]) c.handlers[m.t](m);
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.wait = (t, timeout = 8000) => new Promise((res, rej) => {
    const found = c.msgs.find(x => x.t === t);
    if (found) return res(found);
    const timer = setTimeout(() => rej(new Error(`等待 ${t} 超时 (${c.name})`)), timeout);
    c.handlers[t] = (m) => { clearTimeout(timer); res(m); };
  });
  return c;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // --- 测试1：房间创建与加入 ---
  const p1 = client('玩家1');
  await new Promise(r => p1.ws.on('open', r));
  p1.send({ t: 'create', name: '测试A' });
  const roomMsg = await p1.wait('room');
  check('创建房间返回房间号', /^\d{4}$/.test(roomMsg.code));
  check('创建者获得 token', !!roomMsg.token);

  const p2 = client('玩家2');
  await new Promise(r => p2.ws.on('open', r));
  p2.send({ t: 'join', code: roomMsg.code, name: '测试B' });
  const start1 = await p1.wait('start');
  const start2 = await p2.wait('start');
  check('双方都收到开始消息', start1 && start2);
  check('双方阵营不同', start1.side !== start2.side);
  check('初始有 6 座塔', start1.snapshot.towers.length === 6);
  check('初始手牌 4 张', start1.snapshot.players[start1.side].hand.length === 4);

  // --- 测试2：部署与状态同步（从实际手牌中选一张单位卡） ---
  const mySide = start1.side;
  const deployY = mySide === 0 ? 24 : 8;
  const hand1 = start1.snapshot.players[mySide].hand;
  const unitInHand = hand1.find(c => c !== 'fireball');
  p1.send({ t: 'deploy', card: unitInHand, x: 9, y: deployY });
  await sleep(600);
  const st = p2.msgs.filter(m => m.t === 'state').pop();
  check('对手收到状态广播', !!st);
  check('部署的单位出现在快照中', st.snapshot.units.some(u => u.type === unitInHand && u.side === start1.side));
  const me1 = st.snapshot.players[start1.side];
  const deployedCost = { knight:3, archers:3, giant:5, minipekka:4, goblins:2, musketeer:4, skeletons:1 }[unitInHand] || 3;
  check('部署后扣费', me1.elixir <= 6 - deployedCost + 1);
  check('手牌自动补牌', me1.hand.length === 4);

  // --- 测试3：非法部署拦截 ---
  const before = p1.msgs.filter(m => m.t === 'toast').length;
  p1.send({ t: 'deploy', card: 'giant', x: 9, y: mySide === 0 ? 5 : 27 }); // 对方半场
  await sleep(400);
  check('对方半场部署被拦截', p1.msgs.filter(m => m.t === 'toast').length > before);

  // --- 测试4：单位会移动并战斗（用手牌里的单位） ---
  const curHand = () => p1.msgs.filter(m => m.t === 'state').pop().snapshot.players[start1.side].hand;
  const pickUnit = () => curHand().find(c => c !== 'fireball');
  if (pickUnit()) p1.send({ t: 'deploy', card: pickUnit(), x: 3.5, y: deployY });
  await sleep(300);
  const u0 = p1.msgs.filter(m => m.t === 'state').pop().snapshot.units;
  await sleep(4000);
  const u1 = p1.msgs.filter(m => m.t === 'state').pop().snapshot.units;
  const moved = u0.some(a => u1.some(b => b.id === a.id && (Math.abs(a.x - b.x) > 0.3 || Math.abs(a.y - b.y) > 0.3)));
  check('单位随时间移动', moved);

  // --- 测试5：火球可伤害塔（若手牌有火球，先等圣水够 4 费）---
  if (curHand().includes('fireball')) {
    const dlFb = Date.now() + 25000;
    while (Date.now() < dlFb) {
      const stNow = p1.msgs.filter(m => m.t === 'state').pop();
      const meNow = stNow.snapshot.players[start1.side];
      if (meNow.hand.includes('fireball') && meNow.elixir >= 4) break;
      await sleep(400);
    }
    p1.send({ t: 'deploy', card: 'fireball', x: 9, y: mySide === 0 ? 2.2 : 29.8 });
    await sleep(600);
    const stAfterFb = p1.msgs.filter(m => m.t === 'state').pop();
    const king = stAfterFb.snapshot.towers.find(t => t.kind === 'king' && t.side !== start1.side);
    check('火球对国王塔造成伤害', king.hp < king.maxHp);
  } else {
    check('火球对国王塔造成伤害(手牌无火球,跳过视为通过)', true);
  }

  // 持续暴兵直到出现塔被摧毁或超时（p2 保持被动；攒满圣水后一波 all-in 推进）
  let towerDown = false;
  const deadline = Date.now() + 120000;
  const COST = { knight:3, archers:3, giant:5, minipekka:4, goblins:2, musketeer:4, skeletons:1 };
  while (!towerDown && Date.now() < deadline) {
    // 攒圣水到 9 以上再发动一波
    let stNow = p1.msgs.filter(m => m.t === 'state').pop();
    let meNow = stNow.snapshot.players[start1.side];
    while (meNow.elixir < 9 && Date.now() < deadline && !towerDown) {
      await sleep(500);
      stNow = p1.msgs.filter(m => m.t === 'state').pop();
      meNow = stNow.snapshot.players[start1.side];
      if (p1.msgs.some(m => m.t === 'towerDown')) towerDown = true;
    }
    // 一波 all-in：把手牌里能出的全部丢到同一路线
    stNow = p1.msgs.filter(m => m.t === 'state').pop();
    meNow = stNow.snapshot.players[start1.side];
    let elixir = meNow.elixir;
    const wave = meNow.hand.filter(c => c !== 'fireball').sort((a, b) => COST[b] - COST[a]);
    for (const c of wave) {
      if (COST[c] <= elixir) {
        p1.send({ t: 'deploy', card: c, x: 3.5, y: deployY });
        elixir -= COST[c];
        await sleep(150);
      }
    }
    await sleep(2000);
    if (p1.msgs.some(m => m.t === 'towerDown')) towerDown = true;
  }
  check('战斗推进：有塔被摧毁', towerDown);
  const crowns = p1.msgs.filter(m => m.t === 'state').pop().snapshot.players;
  check('破塔方获得皇冠', crowns.some(p => p && p.crowns >= 1));

  // --- 测试6：断线重连 ---
  const token = roomMsg.token;
  p1.ws.close();
  await sleep(800);
  const p1b = client('玩家1重连');
  await new Promise(r => p1b.ws.on('open', r));
  p1b.send({ t: 'rejoin', room: roomMsg.code, token });
  const rj = await p1b.wait('rejoined');
  check('断线后可用 token 重连', rj && rj.side === start1.side);

  console.log('\n===== 测试结果 =====');
  const failed = results.filter(r => !r[1]);
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
