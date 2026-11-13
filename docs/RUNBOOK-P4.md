# P4（slapah ns2jb-port 完整 acquisition）运行手册

> 适用：CivSwitch 已固化（触发存档 `XSTRIG.Civ7Save` 已装），PC 与 S2 同网段
> （下文以 `<PC_IP>` / `<S2_IP>` 代指两端的局域网地址）。
> 引擎目录：本包 `port\`；对引擎的改动见 `CHANGES.md`。

## 1. 控制台侧（Switch 2）

**不需要按住 R**（那是 Switch 1 进 hbmenu 的 title override；S2 无 Atmosphère，正常启动即可）。

1. 强制关机再开机（实测：每轮 P4 跑完后主机已完全卡死，Power Options 不可用）：**长按电源 12 秒强制断电**，等 5 秒再按电源开机。
2. 正常启动《文明 7》（实体卡）。
3. 标题画面 → **Load Game** → 选 `XSTRIG.Civ7Save` → 读取。
4. 等屏幕出现 `Awaiting payload at <S2_IP>:9026` → 回「好了」。
5. 读到 loader 后**别动主机**；P4 每轮跑完主机都会 wedge（这是本项目的常态），卡死 >3 分钟 → 长按电源 12 秒强制断电 → 等 5 秒 → 开机。

## 2. 每次失败后（恢复干净存档，约 14 秒）

在包的根目录执行（`<backup-dir>` 是 `dump_save_tree.py` 产出的备份目录）：

```powershell
python -u .\save-tools\restore_save.py <backup-dir> <S2_IP> 9026
```

- 期望：6 个文件 `WROTE`，`HallofFame.sqlite` 报 `E: open … 0x0e02`（被游戏占用，属正常）。
- 残留 `/NS2_GAP_*` 不用手动清：引擎 `Remove exploit scratch from prior launches` 阶段会删。

## 3. PC 侧跑 P4（完整模式）

引擎必须用 `danger-full-access` 跑（默认沙箱禁止管道式 child_process，P3 已确认）。

```powershell
node .\port\engine\run.cjs <PC_IP>
```

等它打印 `Run folder: …` 与 `Waiting for Civilization VII via CivSwitch at <PC_IP>:39380.` 后：

```powershell
python -u .\save-tools\send_js.py <S2_IP> .\port\payload.js
```

桥接文件用 `port\payload.js`；首次使用前先跑 `set-pc-ip.ps1 -PcIp <PC_IP>` 把 PC 地址写进去。

## 4. 判读

- 成功：`FS execution verified. Original instructions restored and scratch cleaned up.` / `Restart the console when finished.`，exit 0。
- 失败：`The run stopped. Keep the runs folder and restart the console before trying again.`，exit 1 → 读 `runs\<session>\switch2\acquisition.log` 与 `switch2\pipeline.json`、`switch2\memory\reserved-gap-*.json` 的 `error` 字段。
- 已知失败模式：
  - `Unexpected wait-synchronization result: 59905`（0xEA01）= join 轮询超时没被识别（已打补丁：`thread-code.json` 的 `waitTimeoutResult` 0xE901→0xEA01）；若还出现看补丁是否被覆盖。
  - `Console response timed out; restart the application` = 控制台 app 已 wedge，只能重启。
- 每次 run 的 run 目录都在 `port\engine\runs\switch2-XXXXXX\`（不删，留证据）。

## 5. 证据/留档

- 抓屏：`ffmpeg -f dshow -i "video=OBS Virtual Camera" -frames:v 1 <png>`（采集卡走 OBS 虚拟摄像头）。
- 每次 run 记一行到自己的 `NOTES.md`：session、时间、失败阶段、error 首行。
