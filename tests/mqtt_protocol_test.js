// 模拟房主+客机，走真实公共 MQTT 通道，验证联机协议
const mqtt = require('mqtt');
const ROOM = String(Math.floor(1000 + Math.random() * 9000));
const T = 'cw26v1/' + ROOM;
const log = (...a) => console.log('[test]', ...a);

// 沙箱出网需走 HTTP 代理；用户手机/浏览器直连，无需代理
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy;
let wsOptions = {};
if (PROXY) {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  wsOptions = { agent: new HttpsProxyAgent(PROXY) };
  log('使用出网代理:', PROXY);
}

function connect(name) {
  return new Promise((res, rej) => {
    const c = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
      clientId: 'cwtest' + name + Math.random().toString(36).slice(2, 6),
      keepalive: 30, connectTimeout: 8000, clean: true, wsOptions,
    });
    c.on('connect', () => res(c));
    c.on('error', rej);
    setTimeout(() => rej(new Error('connect timeout ' + name)), 10000);
  });
}

(async () => {
  try {
    const host = await connect('host');
    const guest = await connect('guest');
    log('两端均连接公共通道 OK, 房间号', ROOM);

    const got = { start: 0, state: 0, deployed: 0, end: false, pong: false };

    await new Promise((res, rej) => {
      host.subscribe(T + '/g/#', res);
      setTimeout(() => rej(new Error('host sub timeout')), 8000);
    });
    await new Promise((res, rej) => {
      guest.subscribe(T + '/h/#', res);
      setTimeout(() => rej(new Error('guest sub timeout')), 8000);
    });
    log('订阅 OK');

    host.on('message', (topic, payload) => {
      const m = JSON.parse(payload.toString());
      const kind = topic.split('/').slice(2).join('/');
      if (kind === 'g/join') {
        log('房主收到加入请求:', m.name);
        host.publish(T + '/h/start', JSON.stringify({ snapshot: { fake: 'start' } }));
        let n = 0;
        const iv = setInterval(() => {
          host.publish(T + '/h/state', JSON.stringify({ snapshot: { n: n++ } }));
          if (n >= 20) { clearInterval(iv); host.publish(T + '/h/end', JSON.stringify({ winner: 0, crowns: [1, 0], reason: '测试结束' })); }
        }, 100);
      }
      if (kind === 'g/deploy') { got.deployed++; log('房主收到部署:', JSON.stringify(m)); }
      if (kind === 'g/ping') { host.publish(T + '/h/pong', '{}'); }
    });

    guest.on('message', (topic, payload) => {
      const m = JSON.parse(payload.toString());
      const kind = topic.split('/').slice(2).join('/');
      if (kind === 'h/start') { got.start++; log('客机收到 start'); }
      if (kind === 'h/state') { got.state++; if (got.state === 1) log('客机收到首个 state'); }
      if (kind === 'h/pong') got.pong = true;
      if (kind === 'h/end') { got.end = true; log('客机收到 end:', JSON.stringify(m)); }
    });

    guest.publish(T + '/g/join', JSON.stringify({ name: '客机测试' }));
    await new Promise(r => setTimeout(r, 1500));
    guest.publish(T + '/g/deploy', JSON.stringify({ card: 'knight', x: 9, y: 20 }));
    guest.publish(T + '/g/ping', '{}');

    await new Promise(r => setTimeout(r, 4000));

    log('结果: start=' + got.start, 'state=' + got.state, 'deployed=' + got.deployed, 'pong=' + got.pong, 'end=' + got.end);
    const pass = got.start >= 1 && got.state >= 10 && got.pong && got.end && got.deployed >= 1;
    log(pass ? '全部通过' : '未通过');
    host.end(true); guest.end(true);
    process.exit(pass ? 0 : 1);
  } catch (e) {
    log('失败:', e.message);
    process.exit(1);
  }
})();
