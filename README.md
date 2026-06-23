# Claudio FM

**一个 AI 私人电台。** 自动选歌、DJ 开场、歌曲串场，像真实的电台一样运转。

![Claudio FM preview](assets/claudio-fm-preview.png)

---

## 快速上手（5 分钟）

### 1. 环境要求

- [Node.js](https://nodejs.org/) v18 或以上
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)（可选，使用 yt-dlp 音乐源时需要）
- 网易云音乐 App（用于扫码登录）

### 2. 下载项目

```bash
git clone https://github.com/hrhou929/Claudio-FM.git
cd Claudio-FM
```

或直接在 GitHub 页面点击 **Code → Download ZIP**，解压后进入文件夹。

### 3. 安装依赖

```bash
npm install
```

### 4. 生成配置文件

```bash
cp .env.example .env
```

配置已内置，无需修改，直接下一步。

### 5. 启动

```bash
npm start
```

首次启动会自动弹出网易云二维码页面，**用手机网易云 App 扫码登录**，登录成功后电台自动开始播放。

### 6. 打开电台

浏览器访问：**http://localhost:8888**

---

## 常见问题

**Q：扫码之后网页没有变化？**
正常的，网页是静态的。扫码后盯着**终端**看，出现 `Login succeeded` 就成功了。

**Q：8080 端口被占用？**
`.env` 里已默认改为 8888，与其他服务不冲突。

**Q：重启不需要重新扫码吗？**
不需要。Cookie 已自动保存在本地，下次启动直接使用。

**Q：朋友能一起用吗？**
可以。在同一局域网内，朋友用你的 IP 加端口访问即可（如 `http://192.168.1.x:8888`）。

---

## 功能说明

- AI 根据时间和氛围自动选歌（默认每次 5 首）
- DJ 开场白 + 歌曲串场，TTS 转语音播放
- 支持通过 Request Line 发送收听偏好
- 音乐源：网易云（推荐）或 yt-dlp
- DJ 声音和音乐音量独立控制

---

## 配置说明

所有配置在 `.env` 文件中，主要参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `OPENAI_COMPAT_API_KEY` | API Key（必填） | — |
| `OPENAI_COMPAT_BASE_URL` | API 地址 | `https://api.vveai.com/v1` |
| `OPENAI_COMPAT_MODEL` | LLM 模型 | `claude-sonnet-4-6` |
| `OPENAI_TTS_VOICE` | DJ 音色 | `shimmer` |
| `OPENAI_TTS_SPEED` | 语速（0.25–4.0） | `0.85` |
| `MUSIC_PROVIDER` | 音乐源（`netease`/`yt-dlp`） | `netease` |
| `CLAUDIO_PORT` | 访问端口 | `8888` |

---

## 项目来源

Fork 自 [bingyanglu/Claudio-FM](https://github.com/bingyanglu/Claudio-FM)，创意来自抖音博主 **mmguo**。

本 fork 的主要改动：
- LLM 换为 OpenAI 兼容接口（支持 Claude 代理）
- TTS 换为 OpenAI TTS（通过同一代理，无需额外注册）
- 音乐源默认网易云，自动处理 NeteaseCloudMusicApi 启动
- 默认每次选 5 首歌
- 端口改为 8888，避免与其他服务冲突
