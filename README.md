# 皇室对决 Crown War（免服务器联机版）

皇室战争风格的实时对战游戏。**无需部署服务器、无需注册、无需绑卡**：联机走公共免费 MQTT 通道。

## 下载安装

APK 直接下载（手机浏览器打开）：
https://github.com/user-test0/crown-war/releases/download/v2.0-serverless/crown-war-release.apk

首次安装请在手机设置中允许「安装未知来源应用」。

## 玩法

1. 两台手机各装一个 APK
2. 一人点「创建房间」，得到 4 位房间号，微信发给朋友
3. 朋友输入房间号点「加入」，立即开战
4. 选手牌、点自己半场部署军队，摧毁对方国王塔获胜
5. 也支持 🤖 人机练习

## 联机原理

- 战斗引擎内嵌在客户端：房主手机跑模拟，客机手机渲染快照（100ms 同步）
- 通信走公共 MQTT 通道（HiveMQ → EMQX → Mosquitto 自动回退），房间号即话题隔离
- 客机加入重试、断线自动重连、心跳掉线判定、加时赛双倍圣水

## 目录结构

- `client/` 网页版客户端（浏览器打开即玩）
- `android/` 安卓壳工程（WebView 打包成 APK）
- `tests/` 联机协议自动化测试
- `server/`、`Dockerfile`、`render.yaml` 旧的自建服务器方案，已不需要，仅作参考保留

## 开发

```bash
# 浏览器试玩
cd client && python3 -m http.server 8026

# 联机协议测试
cd tests && npm install && node mqtt_protocol_test.js

# 打包 APK
cd android && ANDROID_HOME=/opt/android-sdk gradle assembleRelease
```
