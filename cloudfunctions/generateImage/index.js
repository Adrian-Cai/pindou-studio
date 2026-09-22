const https = require('https')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  // AI 生图与云存储上传耗时较长，SDK 默认 15s 会中断请求
  timeout: 600000,
})

const IMAGE_MODEL = 'HY-Image-v3.0-I2I-ToB-v1.0.1'
const TEXT_IMAGE_MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0'
const ALLOWED_SIZES = ['1024x1024', '1280x720', '720x1280', '1280x1280']
const MAX_PROMPT_LENGTH = 500
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

exports.main = async (event) => {
  const payload = parsePayload(event)
  if (!payload) {
    return { error: '请求参数格式无效', code: 'INVALID_BODY' }
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
  if (!prompt) return { error: '请输入提示词', code: 'INVALID_PROMPT' }
  if (prompt.length > MAX_PROMPT_LENGTH) {
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
      revise: { value: image ? false : true },
    })
    const generatedImage = response?.data?.[0]
    if (!generatedImage || typeof generatedImage.url !== 'string' || !generatedImage.url) {
      throw new Error('模型未返回有效图片地址')
    }

    const downloadedImage = await downloadImage(generatedImage.url)
    const uploadResponse = await cloud.uploadFile({
      cloudPath: `ai-images/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${fileExtension(downloadedImage.contentType)}`,
      fileContent: downloadedImage.buffer,
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
      response.on('end', () => finish(null, {
        buffer: Buffer.concat(chunks),
        contentType,
      }))
      response.on('error', (error) => finish(error))
    })

    request.setTimeout(120000, () => request.destroy(new Error('图片下载超时')))
    request.on('error', (error) => finish(error))
  })
}

function fileExtension(contentType) {
  if (contentType === 'image/jpeg') return 'jpg'
  if (contentType === 'image/webp') return 'webp'
  return 'png'
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
