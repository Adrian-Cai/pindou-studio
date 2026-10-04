const https = require('https')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  // AI 生图与云存储上传耗时较长，SDK 默认 15s 会中断请求
  timeout: 600000,
})

const IMAGE_MODEL = 'HY-Image-v3.0-I2I-ToB-v1.0.1'
const TEXT_IMAGE_MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0'
const ALLOWED_SIZES = ['1024x1024', '1280x720', '720x1280']
const MAX_PROMPT_LENGTH = 500
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/**
 * 产物右下角的显式标识文案（SDK 的 footnote 参数），上限 16 个字符。
 * 平台默认标注「AI生成」且当前 SDK 不提供关闭参数；这里使用明确的 AI 生成文案。
 */
const IMAGE_FOOTNOTE = 'AI生成'

/**
 * 云函数入口：解析入参并触发一次混元生图，产物上传云存储后回包。
 * 入参：{ prompt, imageDataUrl?, size? }；成功回包含 fileID/contentType/size/revisedPrompt/requestId。
 */
exports.main = async (event) => {
  const payload = parsePayload(event)
  if (!payload) {
    return { error: '请求参数格式无效', code: 'INVALID_BODY' }
  }
  if (payload.action === 'inspirations') return generateInspirations()

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
  if (!prompt) return { error: '请输入提示词', code: 'INVALID_PROMPT' }
  if (Array.from(prompt).length > MAX_PROMPT_LENGTH) {
    return { error: `提示词最多 ${MAX_PROMPT_LENGTH} 字`, code: 'INVALID_PROMPT' }
  }

  const hasImageInput = payload.imageDataUrl !== undefined
  const image = hasImageInput ? parseInputImage(payload.imageDataUrl) : null
  if (hasImageInput && !image) {
    return { error: '请输入有效的参考图片', code: 'INVALID_IMAGE' }
  }

  const size = ALLOWED_SIZES.includes(payload.size) ? payload.size : '1024x1024'

  try {
    const imageModel = cloud.ai().createImageModel('hunyuan-image')
    const response = await imageModel.generateImage({
      model: image ? IMAGE_MODEL : TEXT_IMAGE_MODEL,
      prompt,
      ...(image ? { images: [image.base64] } : {}),
      size,
      // 覆盖平台默认角标文案；服务端在生图时同步写入，不增加额外耗时
      footnote: IMAGE_FOOTNOTE,
      revise: { value: image ? false : true },
    })
    const generatedImage = response?.data?.[0]
    if (!generatedImage || typeof generatedImage.url !== 'string' || !generatedImage.url) {
      throw new Error('模型未返回有效图片地址')
    }

    const downloadedImage = await downloadImage(generatedImage.url)
    const cloudPath = `ai-images/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${fileExtension(downloadedImage.contentType)}`
    const uploadResponse = await cloud.uploadFile({
      cloudPath,
      fileContent: downloadedImage.buffer,
    })

    // 诊断用：记录落盘文件的真实字节特征，用于确认模型实际返回的图片格式
    console.log('[generateImage] output persisted', {
      cloudPath,
      fileID: uploadResponse.fileID,
      headerContentType: downloadedImage.contentType,
      detectedFormat: detectImageFormat(downloadedImage.buffer),
      byteSize: downloadedImage.buffer.length,
      signatureHex: downloadedImage.buffer.subarray(0, 16).toString('hex'),
    })

    return {
      fileID: uploadResponse.fileID,
      contentType: downloadedImage.contentType,
      size: downloadedImage.buffer.length,
      revisedPrompt: typeof generatedImage.revised_prompt === 'string'
        ? generatedImage.revised_prompt
        : prompt,
      requestId: typeof response.request_id === 'string'
        ? response.request_id
        : typeof response.id === 'string' ? response.id : '',
    }
  } catch (error) {
    const serialized = serializeError(error)
    console.error('[generateImage] generation failed', serialized)
    return {
      error: '图片生成失败，请稍后重试',
      code: 'IMAGE_GENERATION_FAILED',
      ...(serialized.statusCode ? { statusCode: serialized.statusCode } : {}),
    }
  }
}

/** 复用现有云端 AI 鉴权；hy3 已在当前环境 cloudbase 组启用。 */
async function generateInspirations() {
  try {
    const response = await cloud.ai().createModel('cloudbase').generateText({
      model: 'hy3',
      messages: [{ role: 'user', content: '一次提供5个主题明显不同、适合制作拼豆图的中文文生图创意。每个创意突出主要主体，使用简洁构图、清晰轮廓、少量易区分的纯色色块和简洁背景；避免细碎纹理、细线、密集小物件、复杂渐变。仅输出JSON数组，每项包含title（2到8字）和prompt（30到100字，描述主体、场景、风格和配色）；不要输出数组以外的文字，不要重复创意。不包含真实人物、商标、暴力、色情或违法内容。' }],
    })
    // 灵感是唯一「不扣用户额度、但真实消耗 token」的调用：按次记录用量，便于成本对账。
    console.log('[generateImage] inspirations usage', describeTokenUsage(response))
    if (response.error) throw new Error('AI 灵感生成失败')
    const items = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    if (!Array.isArray(items) || items.length !== 5 || items.some(item =>
      !item || typeof item.title !== 'string' || !item.title.trim() || Array.from(item.title).length > 12
      || typeof item.prompt !== 'string' || !item.prompt.trim() || Array.from(item.prompt).length > 500)) {
      throw new Error('AI 灵感格式异常')
    }
    return { items: items.map(item => ({ title: item.title.trim(), prompt: item.prompt.trim() })) }
  } catch {
    return { error: 'AI 灵感暂时不可用，请稍后换一换', code: 'AI_INSPIRATION_UNAVAILABLE' }
  }
}

/**
 * 文本模型用量对账用：上游字段名不稳定，缺失一律记 null（不写 0，避免把「没读到」当「没消耗」）。
 * 顺带记录回包字段名，便于确认当前 SDK 版本真实的用量字段。
 */
function describeTokenUsage(response) {
  const body = response && typeof response === 'object' ? response : {}
  const usage = body.usage && typeof body.usage === 'object' ? body.usage : null
  const inputTokens = numberOrNull(usage?.prompt_tokens) ?? numberOrNull(usage?.input_tokens)
  const outputTokens = numberOrNull(usage?.completion_tokens) ?? numberOrNull(usage?.output_tokens)
  const totalTokens = numberOrNull(usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
  return {
    model: 'hy3',
    inputTokens,
    outputTokens,
    totalTokens,
    ...(usage ? {} : { usageUnavailable: true, responseKeys: Object.keys(body).join(',') }),
  }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parsePayload(event) {
  if (!event || typeof event !== 'object') return {}
  if (typeof event.body === 'undefined') return event
  if (typeof event.body === 'object' && event.body !== null) {
    return Array.isArray(event.body) ? null : event.body
  }
  if (typeof event.body !== 'string') return null

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    console.error('[generateImage] request body is not valid JSON', {
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function parseInputImage(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i)
  if (!match) return null

  const contentType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase()
  const base64 = match[2].replace(/\s/g, '')
  let buffer
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch {
    return null
  }
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null
  return { base64, buffer, contentType }
}

function downloadImage(imageUrl) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try {
      parsedUrl = new URL(imageUrl)
    } catch {
      reject(new Error('模型返回的图片地址无效'))
      return
    }
    if (parsedUrl.protocol !== 'https:') {
      reject(new Error('模型返回的图片地址协议无效'))
      return
    }

    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }

    const request = https.get(parsedUrl, { headers: { accept: 'image/*' } }, (response) => {
      const statusCode = response.statusCode || 0
      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        finish(new Error(`图片下载失败，状态码 ${statusCode}`))
        return
      }

      const contentType = String(response.headers['content-type'] || 'image/png').split(';')[0].trim()
      if (!contentType.startsWith('image/')) {
        response.resume()
        finish(new Error('模型返回的内容不是图片'))
        return
      }

      const contentLength = Number(response.headers['content-length'])
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
        response.resume()
        finish(new Error('生成图片超过大小限制'))
        return
      }

      const chunks = []
      let totalBytes = 0
      response.on('data', (chunk) => {
        totalBytes += chunk.length
        if (totalBytes > MAX_IMAGE_BYTES) {
          response.destroy()
          finish(new Error('生成图片超过大小限制'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        // 模型临时地址可能缺失 content-type 头，回退成 image/png 会把 JPEG 误标成 PNG
        finish(null, { buffer, contentType: resolveContentType(buffer, contentType) })
      })
      response.on('error', (error) => finish(error))
    })

    request.setTimeout(120000, () => request.destroy(new Error('图片下载超时')))
    request.on('error', (error) => finish(error))
  })
}

function resolveContentType(buffer, headerContentType) {
  const detected = detectImageFormat(buffer)
  if (detected === 'jpeg') return 'image/jpeg'
  if (detected === 'png') return 'image/png'
  if (detected === 'webp') return 'image/webp'
  return headerContentType || 'image/png'
}

function fileExtension(contentType) {
  if (contentType === 'image/jpeg') return 'jpg'
  if (contentType === 'image/webp') return 'webp'
  return 'png'
}

function detectImageFormat(buffer) {
  if (buffer.length === 0) return 'empty'
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'webp'
  return 'unknown'
}

function serializeError(error) {
  const response = error?.response || {}
  const statusCode = Number(error?.statusCode ?? error?.status ?? response.status ?? response.statusCode)
  const providerCode = error?.code || error?.error_code || response.data?.code

  return {
    currentEnv: currentEnv(),
    name: error?.name || 'Error',
    message: error?.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500),
    ...(providerCode ? { providerCode: String(providerCode) } : {}),
    ...(Number.isFinite(statusCode) && statusCode > 0 ? { statusCode } : {}),
  }
}

/** 诊断用：优先读微信上下文 ENV，否则回退 TCB_ENV / SCF_NAMESPACE；仅供日志，不参与环境绑定。 */
function currentEnv() {
  try {
    if (typeof cloud.getWXContext === 'function') {
      const wxContext = cloud.getWXContext() || {}
      if (wxContext.ENV) return String(wxContext.ENV)
    }
  } catch (error) {
    // 诊断信息不能影响错误处理本身
    console.error('[generateImage] failed to read WX context', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'unknown'
}
