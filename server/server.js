/**
 * Crown War 联机对战服务器（权威服务端）
 * 皇室战争风格：所有战斗模拟在服务器运算，客户端只发送指令与渲染。
 * 功能：快速匹配 / 房间号约战 / 人机练习 / 断线重连
 * 启动：node server.js  （默认端口 3000，可用 PORT 环境变量修改）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'client');
const TICK_MS = 100;          // 10Hz 模拟与广播
const MATCH_TIME = 180;       // 常规 3 分钟
const OVERTIME = 60;          // 加时 1 分钟（双倍圣水 + 突然死亡）
const ELIXIR_MAX = 10;
const ELIXIR_RATE = 1 / 2.8;  // 每秒圣水
const RECONNECT_GRACE = 60000; // 断线保留 60 秒

// ---------------- 卡牌与单位定义 ----------------
// 坐标：逻辑竞技场 18 x 32，河在 y=16，桥在 x=3.5 / 14.5
const CARD_DEFS = {
  knight:    { name: '骑士',     cost: 3, kind: 'unit', count: 1, hp: 1400, dmg: 160, speed: 1.0, range: 0.9,  hitSpeed: 1.1, sight: 5.5, radius: 0.45, color: '#e67e22' },
  archers:   { name: '弓箭手',   cost: 3, kind: 'unit', count: 2, hp: 252,  dmg: 96,  speed: 1.0, range: 5.0,  hitSpeed: 1.2, sight: 5.5, radius: 0.35, color: '#e91e63' },
  giant:     { name: '巨人',     cost: 5, kind: 'unit', count: 1, hp: 3300, dmg: 210, speed: 0.5, range: 1.1,  hitSpeed: 1.5, sight: 7.5, radius: 0.6,  color: '#795548', onlyBuildings: true },
  minipekka: { name: '迷你皮卡', cost: 4, kind: 'unit', count: 1, hp: 1150, dmg: 520, speed: 1.6, range: 0.9,  hitSpeed: 1.8, sight: 5.5, radius: 0.45, color: '#3f51b5' },
  goblins:   { name: '哥布林',   cost: 2, kind: 'unit', count: 3, hp: 180,  dmg: 105, speed: 1.7, range: 0.7,  hitSpeed: 1.1, sight: 5.5, radius: 0.3,  color: '#4caf50' },
  musketeer: { name: '火枪手',   cost: 4, kind: 'unit', count: 1, hp: 620,  dmg: 190, speed: 1.0, range: 6.0,  hitSpeed: 1.1, sight: 6.5, radius: 0.4,  color: '#9c27b0' },
  skeletons: { name: '骷髅兵',   cost: 1, kind: 'unit', count: 3, hp: 72,   dmg: 62,  speed: 1.7, range: 0.7,  hitSpeed: 1.0, sight: 5.5, radius: 0.28, color: '#cfd8dc' },
  fireball:  { name: '火球术',   cost: 4, kind: 'spell', dmg: 480, radius: 2.5, towerFactor: 0.35, color: '#ff5722' },
};
const DECK = Object.keys(CARD_DEFS); // 8 张固定卡组

const TOWER_DEFS = {
  princess: { hp: 2500, dmg: 120, range: 7.5, hitSpeed: 0.8 },
  king:     { hp: 4000, dmg: 120, range: 7.0, hitSpeed: 1.0 },
};

const ARENA_W = 18, ARENA_H = 32, RIVER_Y = 16;
const BRIDGES = [3.5, 14.5];

// ---------------- 工具 ----------------
const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
const dist = (a, b) => Math.sqrt(dist2(a, b));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = v => Math.round(v * 10) / 10;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------- 游戏房间 ----------------
class Room {
  constructor(code) {
    this.code = code;
    this.players = [null, null];   // side 0 = 下方, side 1 = 上方
    this.state = 'waiting';        // waiting | playing | ended
    this.startedAt = 0;
    this.elapsed = 0;
    this.overtime = false;
    this.nextId = 1;
    this.timer = null;
    this.matchmaking = false;
    this.botSide = -1;             // 人机模式时机器人所在边
    this.botTimer = 0;
    this.emptySince = 0;
  }

  sideOf(sock) { return this.players.findIndex(p => p && p.sock === sock); }

  addPlayer(sock, name) {
    const side = this.players[0] ? 1 : 0;
    this.players[side] = this.makePlayer(side, name, sock);
    return side;
  }

  makePlayer(side, name, sock) {
    const deck = shuffle(DECK.slice());
    return {
      side, name: name || `玩家${side + 1}`, sock, token: crypto.randomBytes(12).toString('hex'),
      connected: true, elixir: 6, elixirFrac: 0,
      hand: deck.slice(0, 4), next: deck.slice(4),
      crowns: 0, disconnectedAt: 0,
    };
  }

  initBattlefield() {
    this.units = [];
    this.projectiles = [];
    this.effects = [];
    this.towers = [];
    const mk = (side, kind, x, y) => {
      const def = TOWER_DEFS[kind];
      this.towers.push({ id: this.nextId++, side, kind, x, y, hp: def.hp, maxHp: def.hp, alive: true, active: kind === 'princess', cd: 0 });
    };
    // side0 下方, side1 上方
    mk(0, 'king', 9, 29.8); mk(0, 'princess', 4, 27.5); mk(0, 'princess', 14, 27.5);
    mk(1, 'king', 9, 2.2);  mk(1, 'princess', 4, 4.5);  mk(1, 'princess', 14, 4.5);
  }

  start() {
    this.state = 'playing';
    this.startedAt = Date.now();
    this.elapsed = 0;
    this.overtime = false;
    this.initBattlefield();
    for (const p of this.players) if (p) this.send(p, { t: 'start', side: p.side, snapshot: this.snapshot() });
    this.timer = setInterval(() => this.tick(), TICK_MS);
    console.log(`[房间 ${this.code}] 对战开始`);
  }

  send(p, msg) {
    if (p && p.sock && p.connected && p.sock.readyState === WebSocket.OPEN) {
      try { p.sock.send(JSON.stringify(msg)); } catch (_) {}
    }
  }
  broadcast(msg) { const s = JSON.stringify(msg); for (const p of this.players) if (p && p.connected && p.sock && p.sock.readyState === WebSocket.OPEN) { try { p.sock.send(s); } catch (_) {} } }

  // ---------- 客户端指令 ----------
  handleDeploy(p, data) {
    if (this.state !== 'playing') return;
    const { card, x, y } = data || {};
    const def = CARD_DEFS[card];
    if (!def || !p.hand.includes(card)) return this.send(p, { t: 'toast', msg: '手中没有这张牌' });
    if (p.elixir < def.cost) return this.send(p, { t: 'toast', msg: '圣水不足' });
    const cx = clamp(+x, 0.5, ARENA_W - 0.5), cy = clamp(+y, 0.5, ARENA_H - 0.5);
    if (def.kind === 'unit') {
      // 只能放在自己半场（己方公主塔被摧毁后可延伸到该侧桥头区域）
      const ownMin = p.side === 0 ? RIVER_Y + 0.5 : 0.5;
      const ownMax = p.side === 0 ? ARENA_H - 0.5 : RIVER_Y - 0.5;
      if (cy < ownMin || cy > ownMax) return this.send(p, { t: 'toast', msg: '只能部署在自己半场' });
      this.spawnUnits(p, card, cx, cy);
    } else {
      this.castSpell(p, card, cx, cy);
    }
    p.elixir -= def.cost;
    // 换牌
    p.hand = p.hand.filter(c => c !== card);
    p.hand.push(p.next.shift());
    p.next.push(card);
    this.broadcast({ t: 'deployed', side: p.side, card, x: r1(cx), y: r1(cy) });
  }

  spawnUnits(p, card, x, y) {
    const def = CARD_DEFS[card];
    for (let i = 0; i < def.count; i++) {
      const off = def.count > 1 ? 0.55 : 0;
      const ang = (i / def.count) * Math.PI * 2;
      this.units.push({
        id: this.nextId++, side: p.side, type: card,
        x: clamp(x + Math.cos(ang) * off, 0.5, ARENA_W - 0.5),
        y: clamp(y + Math.sin(ang) * off, 0.5, ARENA_H - 0.5),
        hp: def.hp, maxHp: def.hp, cd: 0, spawnCd: 1.0,
      });
    }
  }

  castSpell(p, card, x, y) {
    const def = CARD_DEFS[card];
    this.effects.push({ id: this.nextId++, kind: 'fireball', x, y, radius: def.radius, ttl: 0.6 });
    for (const u of this.units) {
      if (u.side !== p.side && dist2(u, { x, y }) <= def.radius * def.radius) u.hp -= def.dmg;
    }
    for (const t of this.towers) {
      if (t.side !== p.side && t.alive && dist2(t, { x, y }) <= def.radius * def.radius) {
        this.damageTower(t, def.dmg * def.towerFactor, p.side);
      }
    }
  }

  damageTower(t, dmg, bySide) {
    if (!t.alive) return;
    t.hp -= dmg;
    if (t.kind === 'king') t.active = true;
    if (t.hp <= 0) {
      t.hp = 0; t.alive = false;
      const attacker = this.players[bySide];
      if (attacker) attacker.crowns += t.kind === 'king' ? 3 : 1;
      this.effects.push({ id: this.nextId++, kind: 'boom', x: t.x, y: t.y, radius: 1.6, ttl: 0.8 });
      // 公主塔被毁会激活国王塔
      if (t.kind === 'princess') {
        const king = this.towers.find(k => k.side === t.side && k.kind === 'king');
        if (king) king.active = true;
      }
      this.broadcast({ t: 'towerDown', side: t.side, kind: t.kind, by: bySide });
      if (t.kind === 'king') return this.endGame(bySide, '摧毁国王塔');
      if (this.overtime) return this.endGame(bySide, '加时赛首冠');
    }
  }

  // ---------- 模拟主循环 ----------
  tick() {
    if (this.state !== 'playing') return;
    const dt = TICK_MS / 1000;
    this.elapsed += dt;
    const total = MATCH_TIME + (this.overtime ? OVERTIME : 0);
    const remaining = total - this.elapsed;

    if (!this.overtime && this.elapsed >= MATCH_TIME) {
      const [a, b] = this.players.map(p => p ? p.crowns : 0);
      if (a !== b) return this.endGame(a > b ? 0 : 1, '时间结束');
      this.overtime = true;
      this.broadcast({ t: 'overtime' });
    } else if (remaining <= 0) {
      const [a, b] = this.players.map(p => p ? p.crowns : 0);
      return this.endGame(a === b ? -1 : (a > b ? 0 : 1), '加时结束');
    }

    const doubleElixir = this.overtime || this.elapsed >= MATCH_TIME - 60;

    // 圣水
    for (const p of this.players) {
      if (!p) continue;
      if (p.elixir < ELIXIR_MAX) {
        p.elixirFrac += ELIXIR_RATE * (doubleElixir ? 2 : 1) * dt;
        if (p.elixirFrac >= 1) { p.elixir += Math.floor(p.elixirFrac); p.elixirFrac %= 1; p.elixir = Math.min(p.elixir, ELIXIR_MAX); }
      }
    }

    this.simUnits(dt);
    this.simTowers(dt);
    this.simProjectiles(dt);
    this.effects = this.effects.filter(e => (e.ttl -= dt) > 0);
    this.units = this.units.filter(u => u.hp > 0);

    if (this.botSide >= 0) this.simBot(dt);

    this.broadcast({ t: 'state', snapshot: this.snapshot() });
  }

  enemyOf(side) { return side === 0 ? 1 : 0; }

  // 单位 AI：寻敌 → 攻击 / 移动（含过桥寻路）
  simUnits(dt) {
    for (const u of this.units) {
      if (u.spawnCd > 0) { u.spawnCd -= dt; continue; }
      const def = CARD_DEFS[u.type];
      const enemy = this.enemyOf(u.side);
      u.cd = Math.max(0, u.cd - dt);

      // 找目标：视野内最近敌方单位（巨人只看建筑）
      let target = null, best = Infinity;
      if (!def.onlyBuildings) {
        for (const o of this.units) {
          if (o.side !== enemy || o.hp <= 0) continue;
          const d = dist(u, o);
          if (d <= def.sight && d < best) { best = d; target = { kind: 'unit', ref: o, d }; }
        }
      }
      for (const t of this.towers) {
        if (t.side !== enemy || !t.alive) continue;
        const d = dist(u, t) - 0.6;
        if (d <= def.sight && d < best) { best = d; target = { kind: 'tower', ref: t, d }; }
      }
      // 无视野内目标：向敌方推进（默认瞄准最近存活的公主塔，否则国王塔）
      if (!target) {
        const enemyTowers = this.towers.filter(t => t.side === enemy && t.alive);
        const princess = enemyTowers.filter(t => t.kind === 'princess');
        const pool = princess.length ? princess : enemyTowers;
        if (!pool.length) continue;
        let bt = null, bd = Infinity;
        for (const t of pool) { const d = dist(u, t); if (d < bd) { bd = d; bt = t; } }
        target = { kind: 'tower', ref: bt, d: bd };
        target.advance = true;
      }

      const tObj = target.ref;
      const tRadius = target.kind === 'tower' ? 0.9 : (CARD_DEFS[tObj.type] ? CARD_DEFS[tObj.type].radius : 0.4);
      const reach = def.range + tRadius;

      if (target.d <= reach) {
        // 攻击
        if (u.cd <= 0) {
          u.cd = def.hitSpeed;
          if (def.range >= 2) {
            this.projectiles.push({ id: this.nextId++, side: u.side, x: u.x, y: u.y, tx: tObj.x, ty: tObj.y, targetId: tObj.id, targetKind: target.kind, speed: 10, dmg: def.dmg });
          } else if (target.kind === 'unit') {
            tObj.hp -= def.dmg;
            this.effects.push({ id: this.nextId++, kind: 'hit', x: tObj.x, y: tObj.y, ttl: 0.2 });
          } else {
            this.damageTower(tObj, def.dmg, u.side);
            this.effects.push({ id: this.nextId++, kind: 'hit', x: tObj.x, y: tObj.y, ttl: 0.2 });
          }
        }
        continue;
      }

      // 移动：需要过河时先走桥
      let gx = tObj.x, gy = tObj.y;
      const needCross = (u.y < RIVER_Y) !== (gy < RIVER_Y);
      if (needCross) {
        const b = BRIDGES.reduce((a, c) => Math.abs(c - u.x) < Math.abs(a - u.x) ? c : a);
        const onBridge = Math.abs(u.x - b) < 0.9;
        if (!onBridge || (Math.abs(u.y - RIVER_Y) < 1.2 && Math.abs(u.x - b) >= 0.9)) {
          gx = b; gy = u.y > RIVER_Y ? RIVER_Y + 0.4 : RIVER_Y - 0.4;
          if (Math.abs(u.x - b) >= 0.9) { gx = b; gy = u.y; }
        }
      }
      const dx = gx - u.x, dy = gy - u.y;
      const d = Math.hypot(dx, dy) || 1;
      const step = def.speed * dt;
      u.x = clamp(u.x + (dx / d) * step, 0.4, ARENA_W - 0.4);
      u.y = clamp(u.y + (dy / d) * step, 0.4, ARENA_H - 0.4);
      // 河道碰撞：非桥上不许进河
      if (Math.abs(u.y - RIVER_Y) < 0.5) {
        const nearBridge = BRIDGES.some(b => Math.abs(u.x - b) < 1.1);
        if (!nearBridge) u.y = u.side === 0 ? RIVER_Y + 0.5 : RIVER_Y - 0.5;
      }
    }
    // 简单挤开，避免完全重叠
    for (let i = 0; i < this.units.length; i++) {
      for (let j = i + 1; j < this.units.length; j++) {
        const a = this.units[i], b = this.units[j];
        const d = dist(a, b), min = 0.5;
        if (d < min && d > 0.001) {
          const push = (min - d) / 2, dx = (b.x - a.x) / d, dy = (b.y - a.y) / d;
          a.x -= dx * push; a.y -= dy * push; b.x += dx * push; b.y += dy * push;
        }
      }
    }
  }

  simTowers(dt) {
    for (const t of this.towers) {
      if (!t.alive || !t.active) continue;
      t.cd = Math.max(0, t.cd - dt);
      if (t.cd > 0) continue;
      const def = TOWER_DEFS[t.kind];
      const enemy = this.enemyOf(t.side);
      let target = null, best = Infinity;
      for (const u of this.units) {
        if (u.side !== enemy || u.hp <= 0 || u.spawnCd > 0) continue;
        const d = dist(t, u);
        if (d <= def.range && d < best) { best = d; target = u; }
      }
      if (target) {
        t.cd = def.hitSpeed;
        this.projectiles.push({ id: this.nextId++, side: t.side, x: t.x, y: t.y, tx: target.x, ty: target.y, targetId: target.id, targetKind: 'unit', speed: 12, dmg: def.dmg });
      }
    }
  }

  simProjectiles(dt) {
    for (const p of this.projectiles) {
      const target = p.targetKind === 'unit'
        ? this.units.find(u => u.id === p.targetId && u.hp > 0)
        : this.towers.find(t => t.id === p.targetId && t.alive);
      if (target) { p.tx = target.x; p.ty = target.y; }
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (d <= step + 0.15) {
        p.dead = true;
        if (target) {
          if (p.targetKind === 'unit') target.hp -= p.dmg;
          else this.damageTower(target, p.dmg, p.side);
          this.effects.push({ id: this.nextId++, kind: 'hit', x: p.tx, y: p.ty, ttl: 0.2 });
        }
      } else {
        p.x += (dx / d) * step; p.y += (dy / d) * step;
      }
    }
    this.projectiles = this.projectiles.filter(p => !p.dead);
  }

  // ---------- 简单人机 ----------
  simBot(dt) {
    const p = this.players[this.botSide];
    if (!p) return;
    this.botTimer -= dt;
    if (this.botTimer > 0) return;
    this.botTimer = 1.6 + Math.random() * 2.2;
    const affordable = p.hand.filter(c => CARD_DEFS[c].cost <= p.elixir);
    if (!affordable.length) return;
    // 防守优先：己方半场有敌人就去堵；否则进攻
    const enemySide = this.enemyOf(this.botSide);
    const threat = this.units.find(u => u.side === enemySide && (this.botSide === 0 ? u.y > RIVER_Y : u.y < RIVER_Y));
    const card = affordable[Math.floor(Math.random() * affordable.length)];
    let x, y;
    if (threat && CARD_DEFS[card].kind === 'unit') {
      x = threat.x + (Math.random() - 0.5) * 2;
      y = this.botSide === 0 ? Math.max(threat.y + 1, RIVER_Y + 1.5) : Math.min(threat.y - 1, RIVER_Y - 1.5);
    } else {
      const lane = Math.random() < 0.5 ? 3.5 : 14.5;
      x = lane + (Math.random() - 0.5) * 3;
      y = this.botSide === 0 ? RIVER_Y + 3 + Math.random() * 4 : RIVER_Y - 3 - Math.random() * 4;
    }
    this.handleDeploy(p, { card, x, y });
  }

  // ---------- 快照 ----------
  snapshot() {
    return {
      time: Math.max(0, Math.ceil((this.overtime ? MATCH_TIME + OVERTIME : MATCH_TIME) - this.elapsed)),
      overtime: this.overtime,
      towers: this.towers.map(t => ({ id: t.id, side: t.side, kind: t.kind, x: r1(t.x), y: r1(t.y), hp: Math.ceil(t.hp), maxHp: t.maxHp, alive: t.alive, active: t.active })),
      units: this.units.map(u => ({ id: u.id, side: u.side, type: u.type, x: r1(u.x), y: r1(u.y), hp: Math.ceil(u.hp), maxHp: u.maxHp, spawn: u.spawnCd > 0 })),
      projectiles: this.projectiles.map(p => ({ id: p.id, side: p.side, x: r1(p.x), y: r1(p.y), tx: r1(p.tx), ty: r1(p.ty) })),
      effects: this.effects.map(e => ({ id: e.id, kind: e.kind, x: r1(e.x), y: r1(e.y), radius: e.radius, ttl: r1(e.ttl) })),
      players: this.players.map(p => p ? { name: p.name, elixir: Math.floor(p.elixir), crowns: p.crowns, hand: p.hand, next: p.next[0] || null, connected: p.connected } : null),
    };
  }

  // ---------- 结束与清理 ----------
  endGame(winnerSide, reason) {
    if (this.state !== 'playing') return;
    this.state = 'ended';
    clearInterval(this.timer);
    const result = { t: 'end', winner: winnerSide, reason, crowns: this.players.map(p => p ? p.crowns : 0) };
    this.broadcast(result);
    console.log(`[房间 ${this.code}] 对战结束: ${reason}, 胜方=${winnerSide}`);
    setTimeout(() => this.destroy(), 30000);
  }

  onDisconnect(sock) {
    const side = this.sideOf(sock);
    if (side < 0) return;
    const p = this.players[side];
    p.connected = false; p.sock = null; p.disconnectedAt = Date.now();
    this.broadcast({ t: 'peer', side, connected: false });
    if (this.state === 'waiting') { this.players[side] = null; }
  }

  tryReconnect(token, sock) {
    for (const p of this.players) {
      if (p && p.token === token) {
        p.sock = sock; p.connected = true;
        this.broadcast({ t: 'peer', side: p.side, connected: true });
        this.send(p, { t: 'rejoined', side: p.side, state: this.state, snapshot: this.state === 'playing' ? this.snapshot() : null });
        return true;
      }
    }
    return false;
  }

  destroy() {
    clearInterval(this.timer);
    this.state = 'destroyed';
    for (const p of this.players) if (p && p.sock) { try { p.sock.close(); } catch (_) {} }
    rooms.delete(this.code);
  }
}

// ---------------- 大厅 ----------------
const rooms = new Map();
const waitingQueue = []; // 快速匹配队列

function makeRoomCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  return code;
}
function getOrCreateRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = new Room(code); rooms.set(code, r); }
  return r;
}

function tryMatchmake(sock, name) {
  const q = waitingQueue.find(e => e.sock.readyState === WebSocket.OPEN);
  if (q) {
    waitingQueue.splice(waitingQueue.indexOf(q), 1);
    const room = q.room;
    room.matchmaking = false;
    room.addPlayer(sock, name);
    joinClientToRoom(sock, room);
    room.start();
  } else {
    const room = getOrCreateRoom(makeRoomCode());
    room.matchmaking = true;
    room.addPlayer(sock, name);
    waitingQueue.push({ sock, room });
    send(sock, { t: 'queued', room: room.code });
  }
}

function joinClientToRoom(sock, room) {
  sock._room = room;
  const p = room.players[room.sideOf(sock)];
  send(sock, { t: 'room', code: room.code, side: room.sideOf(sock), token: p.token, name: p.name });
}

function send(sock, msg) { try { sock.send(JSON.stringify(msg)); } catch (_) {} }

// ---------------- HTTP + WebSocket ----------------
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  // 静态文件服务（网页版客户端）
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const fp = path.join(STATIC_DIR, path.normalize(file));
  if (fp.startsWith(STATIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    return fs.createReadStream(fp).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ game: 'crown-war', rooms: rooms.size, online: wss.clients.size }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (sock) => {
  sock.isAlive = true;
  sock.on('pong', () => { sock.isAlive = true; });

  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const room = sock._room;

    switch (msg.t) {
      case 'create': {
        const r = getOrCreateRoom(makeRoomCode());
        r.addPlayer(sock, msg.name);
        joinClientToRoom(sock, r);
        break;
      }
      case 'join': {
        const code = String(msg.code || '').trim();
        const r = rooms.get(code);
        if (!r || r.state !== 'waiting') return send(sock, { t: 'error', msg: '房间不存在或已开始' });
        if (r.players[0] && r.players[1]) return send(sock, { t: 'error', msg: '房间已满' });
        r.addPlayer(sock, msg.name);
        joinClientToRoom(sock, r);
        r.start();
        break;
      }
      case 'quick': {
        tryMatchmake(sock, msg.name);
        break;
      }
      case 'bot': {
        const r = getOrCreateRoom(makeRoomCode());
        r.addPlayer(sock, msg.name);
        const bot = r.makePlayer(1, '电脑对手', null);
        bot.connected = true;
        r.players[1] = bot;
        r.botSide = 1;
        joinClientToRoom(sock, r);
        r.start();
        break;
      }
      case 'deploy': {
        if (room) {
          const side = room.sideOf(sock);
          if (side >= 0) room.handleDeploy(room.players[side], msg);
        }
        break;
      }
      case 'leave': {
        if (room) {
          room.onDisconnect(sock);
          sock._room = null;
          send(sock, { t: 'left' });
        }
        break;
      }
      case 'rejoin': {
        for (const r of rooms.values()) {
          if (r.code === msg.room && r.tryReconnect(msg.token, sock)) { sock._room = r; return; }
        }
        send(sock, { t: 'error', msg: '无法重连：对局已结束' });
        break;
      }
      default: break;
    }
  });

  sock.on('close', () => {
    const room = sock._room;
    if (room) room.onDisconnect(sock);
    const qi = waitingQueue.findIndex(e => e.sock === sock);
    if (qi >= 0) waitingQueue.splice(qi, 1);
  });
});

// 心跳检测 + 清理空房间
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.state === 'destroyed') continue;
    const anyConnected = r.players.some(p => p && p.connected);
    if (!anyConnected) {
      if (!r.emptySince) r.emptySince = now;
      else if (now - r.emptySince > RECONNECT_GRACE) r.destroy();
    } else r.emptySince = 0;
  }
}, 15000);

httpServer.listen(PORT, () => {
  console.log(`Crown War 服务器已启动: ws://0.0.0.0:${PORT} (http 健康检查 /health)`);
});
