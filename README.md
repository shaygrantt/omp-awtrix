# omp-awtrix

An [omp](https://github.com/can1357/oh-my-pi) extension that shows what your coding agent is doing on an
[AWTRIX NG](https://blueforcer.github.io/awtrix-ng/esp32/) LED matrix clock (Ulanzi TC001/TC002 or a DIY ESP32 build).

It copies how the [openharness](https://github.com/autonomous-ai/openharness) Harness device works:
turn started, activity, done with recap and beep, error, and question. Openharness sends these over
USB serial; this extension uses the clock's HTTP API instead.

| Agent state | On the clock |
|---|---|
| Working | Pushed app `omp-<project>-<pid>`: walking-invader icon, project name, current tool step. Middle edge light fades in the tile color |
| Question / permission prompt | Orange `?` notification that wakes the display (no beep). Top edge light blinks orange until answered |
| Done | Green ✓ notification with the first line of the reply and three short beeps. Bottom edge light turns green for 10 min |
| Error | Red ✗ notification with the error message. Bottom edge light turns red |

- **Main agent only:** sub-agents and the advisor never drive the clock.
- **Turn end:** the extension waits for running task sub-agents before it marks a turn done.
- **Edge lights:** they combine the state of every omp process on the machine.
- **Busy tiles:** they expire on the clock 45 s after the last heartbeat. A crashed omp leaves nothing behind.
- **Exit:** quitting omp removes its tile and lights.

## Install

```sh
git clone https://github.com/devsecwipay/omp-awtrix.git
ln -s "$PWD/omp-awtrix/awtrix-status.ts" ~/.omp/agent/extensions/awtrix-status.ts
export AWTRIX_URL=http://<your-clock-ip>
```

New omp sessions load it automatically.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `AWTRIX_URL` | `http://10.42.1.80` | Clock address; `off` disables the extension |
| `AWTRIX_AUTH` | none | `user:pass` when the clock's web login is on |
| `AWTRIX_SOUND` | `1` | `0` silences the done beep |
| `AWTRIX_INDICATORS` | `1` | `0` leaves the three edge lights alone (for example when Home Assistant uses them) |
| `AWTRIX_INK` | `#4FC3F7` | Tile and working-light color |

## Commands

- `/awtrix`: clock reachability, current app, and the state of every omp session.
- `/awtrix test`: run working → question → done on the clock.
- `/awtrix mute` / `/awtrix unmute`: turn the done beep off or on for this session.
