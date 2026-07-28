// Speech-to-Text:在 main 进程惰性加载 whisper.cpp,renderer 通过 IPC 传 16kHz
// mono PCM 过来 → 返回识别文本。模型常驻内存(初次加载 ~1-2s,后续每段转写
// ~数百 ms),退出时 free()。
//
// 设计要点:
//   - 模型路径:开发 = resources/models/,打包 = process.resourcesPath/models/。
//     `extraResources` 把 `resources/models` 复制到包外的 `Resources/models`,
//     运行时通过 process.resourcesPath 命中,完全离线。
//   - 单例 + initPromise 去重:多次并发首次调用只触发一次构造。失败时清掉
//     promise,下次重试不会卡在永久 rejected。
//   - smart-whisper 是 native binding(ESM, 顶层 `new Whisper(modelPath)`)—
//     用 dynamic import,模型文件缺失 / native ABI 不匹配时,错误向上抛到 IPC
//     层,UI 显示原始 error.message,而不是让整个 main 进程因 require 失败崩溃。
//   - transcribe 选项:no_timestamps 拿纯文本,suppress_non_speech_tokens 避免
//     "[音乐]" "[掌声]" 这种标注混入;language='auto' 让 whisper 自检中英。

import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

const MODEL_FILE = 'ggml-small-q5_1.bin'

// 在 dev 与打包下,模型文件落在不同位置 —— 解析时按优先级试。
// dev: __dirname = D:\project\troupe\out\main → ../../resources/models/
// pkg: process.resourcesPath = <app>/Resources → models/
function resolveModelPath(): string | null {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, 'models', MODEL_FILE))
  } else {
    candidates.push(join(__dirname, '..', '..', 'resources', 'models', MODEL_FILE))
    candidates.push(join(process.cwd(), 'resources', 'models', MODEL_FILE))
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

// smart-whisper 的运行时类型 —— 它是 CJS-friendly 但只暴露最小 API,我们这里
// 显式标 any 避免引入 `@types/smart-whisper`(无官方类型)。
type WhisperInstance = {
  transcribe: (
    pcm: Float32Array,
    opts: Record<string, unknown>
  ) => Promise<{ result: Promise<Array<{ text?: string }>> }>
  free: () => Promise<void>
}

let whisperInstance: WhisperInstance | null = null
let initPromise: Promise<WhisperInstance> | null = null

// 繁→简后处理 converter。opencc-js/t2cn 只 ~66KB(vs 完整包 1MB),仅含繁→简
// 字典。**惰性**加载:用户没说中文时(language!='zh')永远不实例化,模块不占内存。
type T2sConverter = (text: string) => string
let t2sConverter: T2sConverter | null = null
let t2sInitPromise: Promise<T2sConverter> | null = null

async function getT2sConverter(): Promise<T2sConverter> {
  if (t2sConverter) return t2sConverter
  if (t2sInitPromise) return t2sInitPromise
  t2sInitPromise = (async () => {
    const mod = await import('opencc-js/t2cn')
    // `from: 't'` 是通用繁体(覆盖港、台、各种繁体变体);to: 'cn' 简体。比指定
    // 'tw'/'hk' 更宽松 —— 我们只想把任何繁体扫成简体,不在意源是哪一支。
    const conv = mod.Converter({ from: 't', to: 'cn' })
    return conv
  })()
  try {
    t2sConverter = await t2sInitPromise
    return t2sConverter
  } catch (err) {
    t2sInitPromise = null
    throw err
  }
}

async function getWhisper(): Promise<WhisperInstance> {
  if (whisperInstance) return whisperInstance
  if (initPromise) return initPromise
  initPromise = (async () => {
    const modelPath = resolveModelPath()
    if (!modelPath) {
      throw new Error(
        `未找到 whisper 模型文件 ${MODEL_FILE}。请运行 \`yarn fetch-models\` 拉取后重启。`
      )
    }
    // dynamic import:smart-whisper 是 native binding,加载失败要把错误传给 IPC
    // 调用方,而不是让 main 进程启动期 require 时就崩。
    const mod = await import('smart-whisper')
    const Whisper = (mod as { Whisper: new (path: string, opts?: object) => WhisperInstance })
      .Whisper
    // gpu: true —— macOS 上走 Metal(Apple Silicon 快很多),win/linux 无对应
    // 后端时 smart-whisper 自动回退 CPU,不会出错。
    return new Whisper(modelPath, { gpu: true })
  })()
  try {
    whisperInstance = await initPromise
    return whisperInstance
  } catch (err) {
    initPromise = null
    throw err
  }
}

export async function transcribePcm(
  pcm: Float32Array,
  language: string = 'zh'
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    if (!pcm || pcm.length === 0) {
      return { ok: false, error: '没有录到声音' }
    }
    const whisper = await getWhisper()
    // 简体引导 prompt:language='zh' 时显著降低 whisper-tiny/small 输出繁体(港台
    // 用语)的概率 —— 量化模型本身不区分简繁,给一段简体文本作 prefix 会让后续
    // token sampling 偏向简体字符表。
    // language='auto' 时**故意不加** —— initial_prompt 会污染 whisper 内部的语言
    // 检测路径,把英语录音强制推成中文输出。auto 用户接受 whisper 的判断即可。
    const opts: Record<string, unknown> = {
      language,
      suppress_non_speech_tokens: true,
      no_timestamps: true
    }
    if (language === 'zh') {
      opts.initial_prompt = '以下是普通话的句子,使用简体中文转写。'
    }
    const task = await whisper.transcribe(pcm, opts)
    const segments = await task.result
    let text = (Array.isArray(segments) ? segments : [])
      .map((s) => (typeof s?.text === 'string' ? s.text : ''))
      .join('')
      .trim()
    // 双保险:initial_prompt 没拦住的残留繁体词(small 量化模型偶尔会跑偏),
    // 在这里 OpenCC 强制转简体。仅对 language='zh' 做 —— 'auto' 可能是英语
    // 里碰到的"México"/"São Paulo"等专名,不应改;'en' 之外的其它语言同理。
    if (language === 'zh' && text) {
      try {
        const conv = await getT2sConverter()
        text = conv(text)
      } catch {
        // OpenCC 加载/转换失败不影响主功能,返回原始文本即可。
      }
    }
    return { ok: true, text }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

export async function disposeStt(): Promise<void> {
  if (whisperInstance) {
    try {
      await whisperInstance.free()
    } catch {
      // 忽略 —— 进程退出阶段 free 失败不是 fatal。
    }
    whisperInstance = null
  }
  initPromise = null
}

export function sttModelExists(): boolean {
  return resolveModelPath() !== null
}
