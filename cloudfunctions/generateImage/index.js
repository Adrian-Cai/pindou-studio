const https = require('https')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 900000,
})

const IMAGE_MODEL = 'HY-Image-v3.0-I2I-ToB-v1.0.1'
const TEXT_IMAGE_MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0'
const ALLOWED_SIZES = ['1024x1024', '1280x720', '720x1280', '1280x1280']
const MAX_PROMPT_LENGTH = 500
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

exports.main = async (event) => {
  const prompt = typeof event?.prompt === 'string' ? event.prompt.trim() : ''
  if (!prompt) return { error: '请输入提示词', code: 'INVALID_PROMPT' }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { error: `提示词最多 ${MAX_PROMPT_LENGTH} 字`, code: 'INVALID_PROMPT' }
  }

  const hasImageInput = event?.imageDataUrl !== undefined
  const image = hasImageInput ? parseInputImage(event.imageDataUrl) : null
  if (hasImageInput && !image) {
    return { error: '请输入有效的参考图片', code: 'INVALID_IMAGE' }
  }

  const size = ALLOWED_SIZES.includes(event?.size) ? event.size : '1024x1024'

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
    console.error('[generateImage] generation failed', serializeError(error))
    return { error: '图片生成失败，请稍后重试', code: 'IMAGE_GENERATION_FAILED' }
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
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { message: String(error) }
}
