const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const compiledRoot = path.resolve(
  __dirname,
  '..',
  '..',
  '.ai-failure-test-build',
  'miniprogram',
)
const service = require(path.join(compiledRoot, 'services', 'ai-generation-service.js'))
const manager = require(path.join(compiledRoot, 'services', 'ai-generation-manager.js'))

/**
 * 这一组用例锁两条不变式。
 *
 * 一、**有独立文案的失败码，必须也能被 aiGenerationFailure 解析出 failure**。
 *     aiGenerationErrorMessage 是一张 switch，failureDefinition 是另一张表；
 *     只登记前者不登记后者时，aiGenerationFailure 返回 null，setFailure 会兜底成
 *     AI_GENERATION_FAILED —— 于是任务页显示真实原因（走 message），列表页显示
 *     「AI 生成失败，请稍后重试」（走落库的 failure.message），同一个失败两句话，
 *     而且真实原因在用户最常看的那一页彻底消失。CONTENT_SECURITY_CHECK_INVALID /
 *     IMAGE_TOO_LARGE / RATE_LIMITED 等七个码曾长期处于这种状态。
 *
 * 二、**失败动作只允许有一张表**。manager 的 canRetryTask / retryActionLabel 与
 *     service 的 aiFailureAction 必须永远一致，否则同一个码在任务页与列表页会给出
 *     不同按钮（IMAGE_TOO_LARGE 曾是「可重试」与「应换图」并存）。
 */

const FALLBACK_MESSAGE = 'AI 生成失败，请稍后重试'

// 与 aiGenerationErrorMessage 的 switch 一一对应：每个有独立文案的码。
// 在 switch 里加 case 时同步加到这里，让「是否有对应 failure 定义」受测试保护。
const CODES_WITH_OWN_MESSAGE = [
  'USER_AI_QUOTA_EXHAUSTED',
  'AI_SERVICE_UNAVAILABLE',
  'AI_SERVICE_BUSY',
  'AI_TIMEOUT',
  'AI_RESULT_INVALID',
  'INVALID_IMAGE',
  'CONTENT_REJECTED',
  'AI_GENERATION_FAILED',
  'AI_INPUT_FILE_UNAVAILABLE',
  'CONTENT_SECURITY_CHECK_INVALID',
  'IMAGE_TOO_LARGE',
  'RATE_LIMITED',
  'UNSUPPORTED_IMAGE',
  'IMAGE_DECODE_ERROR',
  'AI_TASK_EXPIRED',
  'NETWORK_ERROR',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'INVALID_RESPONSE',
  'INVALID_INPUT',
]

// 服务端 error-contract 已登记的内部码 → 客户端归一化后应得到的公开码。
// 服务端版本落后时这些内部码会原样透出，客户端必须自己兜住。
const SERVER_INTERNAL_CODES = {
  AI_PROVIDER_QUOTA_EXHAUSTED: 'AI_SERVICE_UNAVAILABLE',
  AI_STORAGE_NOT_CONFIGURED: 'AI_SERVICE_UNAVAILABLE',
  AI_PROVIDER_NOT_CONFIGURED: 'AI_SERVICE_UNAVAILABLE',
  AI_SUBMISSION_UNKNOWN: 'AI_SERVICE_UNAVAILABLE',
  AI_SUBMISSION_TIMEOUT: 'AI_SERVICE_UNAVAILABLE',
  AI_PROVIDER_RATE_LIMITED: 'AI_SERVICE_BUSY',
  AI_PROVIDER_UNAVAILABLE: 'AI_SERVICE_BUSY',
  AI_PROVIDER_ERROR: 'AI_GENERATION_FAILED',
  AI_PROVIDER_TASK_FAILED: 'AI_GENERATION_FAILED',
  AI_GENERATION_INTERNAL_ERROR: 'AI_GENERATION_FAILED',
  AI_QUOTA_UNAVAILABLE_AT_COMPLETION: 'USER_AI_QUOTA_EXHAUSTED',
  AI_PROVIDER_TIMEOUT: 'AI_TIMEOUT',
  AI_PROVIDER_OUTPUT_INVALID: 'AI_RESULT_INVALID',
  AI_PROVIDER_OUTPUT_TOO_LARGE: 'AI_RESULT_INVALID',
  AI_IMAGE_DIMENSIONS_TOO_LARGE: 'IMAGE_TOO_LARGE',
  PAYLOAD_TOO_LARGE: 'IMAGE_TOO_LARGE',
  AI_TASK_EXPIRED: 'AI_TASK_EXPIRED',
  CONTENT_RISKY: 'CONTENT_REJECTED',
}

const ACTION_LABELS = {
  RETRY: '重试',
  SELECT_IMAGE: '重新选图生成',
  USE_STANDARD_MODE: '用标准模式生成',
  VIEW_BENEFITS: '购买次数',
}

test('有独立文案的失败码都能解析出 failure，且文案不被兜底覆盖', () => {
  for (const code of CODES_WITH_OWN_MESSAGE) {
    const error = { errorCode: code }
    const failure = service.aiGenerationFailure(error)
    const message = service.aiGenerationErrorMessage(error)

    assert.ok(failure, `${code} 没有对应的 failure 定义，会被兜底成 ${FALLBACK_MESSAGE}`)
    assert.equal(failure.code, code)
    // 同一个码只允许有一句话：任务卡片（failure.message）与列表页（aiGenerationErrorMessage）必须一致
    assert.equal(failure.message, message, `${code} 的文案在 failure 定义与 switch 里不一致`)
    if (code !== 'AI_GENERATION_FAILED') {
      assert.notEqual(message, FALLBACK_MESSAGE, `${code} 的文案被兜底覆盖，真实原因会丢失`)
    }
  }
})

test('服务端可能透出的内部码都被归一化到预期的公开码', () => {
  for (const [internal, expected] of Object.entries(SERVER_INTERNAL_CODES)) {
    const error = { errorCode: internal }
    const failure = service.aiGenerationFailure(error)
    assert.ok(failure, `${internal} 没有对应 failure 定义`)
    assert.equal(failure.code, expected, `${internal} 归一化结果与预期不符`)
    assert.ok(
      failure.message && failure.message.length > 0,
      `${internal} 归一化后没有可用文案`,
    )
  }
})

test('额度耗尽与服务端不可用不再显示成「AI 生成失败，请稍后重试」', () => {
  for (const code of ['AI_PROVIDER_QUOTA_EXHAUSTED', 'AI_STORAGE_NOT_CONFIGURED', 'AI_PROVIDER_NOT_CONFIGURED']) {
    const message = service.aiGenerationErrorMessage({ errorCode: code })
    assert.notEqual(message, FALLBACK_MESSAGE)
    assert.equal(service.aiGenerationFailure({ errorCode: code }).action, 'USE_STANDARD_MODE')
  }
})

test('未登记的码保持兜底语义（不编造动作，也不丢文案）', () => {
  const error = { errorCode: 'AI_TOTALLY_UNKNOWN_CODE' }
  assert.equal(service.aiGenerationFailure(error), null)
  assert.equal(service.aiGenerationErrorMessage(error), FALLBACK_MESSAGE)
  assert.equal(service.aiFailureAction('AI_TOTALLY_UNKNOWN_CODE'), 'SELECT_IMAGE')
  assert.equal(manager.canRetryTask('AI_TOTALLY_UNKNOWN_CODE'), false)
})

test('服务端返回的结构化 failure 也能归一化', () => {
  const failure = service.aiGenerationFailure({
    failure: {
      code: 'AI_PROVIDER_UNAVAILABLE',
      message: '原始文案',
      category: 'PROVIDER',
      retryable: true,
      action: 'RETRY',
    },
  })
  assert.ok(failure)
  assert.equal(failure.code, 'AI_SERVICE_BUSY')
})

test('重试动作只有一张表：manager 与 service 对每个码给同一个动作', () => {
  const codes = [...CODES_WITH_OWN_MESSAGE, ...Object.keys(SERVER_INTERNAL_CODES), 'AI_UNKNOWN_X']
  for (const code of codes) {
    const action = service.aiFailureAction(code)
    assert.equal(
      manager.canRetryTask(code),
      action === 'RETRY',
      `${code} 在 manager 与 service 之间的可重试判定不一致`,
    )
    assert.equal(
      manager.retryActionLabel(code),
      ACTION_LABELS[action],
      `${code} 的操作文案与动作不一致`,
    )
  }
})
