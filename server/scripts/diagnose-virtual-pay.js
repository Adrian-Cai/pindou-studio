/**
 * 虚拟支付配置体检（运维一次性诊断脚本，不属于服务运行时）。
 *
 * 用途：支付报 `requestVirtualPayment:fail SIGNATURE_INVALID`（-15005）时，
 * 一次跑完就能分清三类根因，不用在真机上反复试、也不用抓包：
 *   ① paySig 探针返回 268490003  ⇒ AppKey 就是错的（沙箱/现网混用、填错、填成别的密钥）；
 *   ② 探针通过但套餐/订单数据异常 ⇒ OfferID 或道具配置（virtual_product_id / price_fen）有问题；
 *   ③ 用户 session_key_ciphertext 为空 ⇒ signature 那一路根本没东西可签。
 *
 * 为什么能拿 query_order 当探针：它与拉起支付用的是**同一把 AppKey、同一套
 * HMAC-SHA256(uri + "&" + body) 算法**，而它不依赖 session_key、也不依赖道具配置，
 * 因此返回「pay_sig 校验失败」时，可以干净地把结论限定在「密钥/算法」这一侧。
 *
 * 用法（脚本在容器内执行，容器里才有真实的 env 与 pg）：
 *   docker exec -i <容器名> node < server/scripts/diagnose-virtual-pay.js
 * 也可以先 docker cp 进容器再 node 执行。宿主机直接跑只会看到「环境变量缺失」。
 *
 * 安全：**绝不打印 AppKey / AppSecret 明文**，只给长度与首尾各 4 位——
 * 这串字符等价于该商户的支付签名权，落进聊天记录或日志就是事故。
 */
const { createHmac } = require('node:crypto')

/** 只暴露长度与首尾各 4 位：足以人工比对「是不是同一把钥匙」，不足以拿去签名。 */
function fingerprint(value) {
  if (!value) return '(空)'
  if (value.length <= 8) return `len=${value.length}`
  return `len=${value.length} ${value.slice(0, 4)}…${value.slice(-4)}`
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

function checkConfig() {
  section('1. 配置体检（密钥只显示指纹）')
  const offerId = process.env.VIRTUAL_PAY_OFFER_ID || ''
  const appKey = process.env.VIRTUAL_PAY_APP_KEY || ''
  const appId = process.env.WECHAT_APP_ID || ''
  const appSecret = process.env.WECHAT_APP_SECRET || ''
  console.log(`VIRTUAL_PAY_OFFER_ID : ${offerId || '(未配置)'}`)
  console.log(`VIRTUAL_PAY_APP_KEY  : ${fingerprint(appKey)}`)
  console.log(`WECHAT_APP_ID        : ${appId || '(未配置)'}`)
  console.log(`WECHAT_APP_SECRET    : ${fingerprint(appSecret)}`)
  return { offerId, appKey, appId, appSecret }
}

/**
 * paySig 探针。
 *
 * 故意用**不存在**的 openid 与单号：这一趟只关心「签名有没有被接受」，
 * 不关心订单结果。命中 268490003 即判定 pay_sig 校验失败。
 */
async function probePaySig(appKey, appId, appSecret) {
  section('2. paySig 探针（/xpay/query_order）')
  if (!appKey || !appId || !appSecret) {
    console.log('跳过：AppKey / AppId / AppSecret 有缺失')
    return null
  }
  const body = JSON.stringify({
    openid: 'oPROBE0000000000000000000000000',
    env: 0,
    order_id: 'vpay_probe_00000000000000000001',
  })
  const paySig = createHmac('sha256', appKey).update(`/xpay/query_order&${body}`, 'utf8').digest('hex')
  try {
    const tokenResponse = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`,
    )
    const token = await tokenResponse.json()
    if (!token.access_token) {
      console.log(`access_token 获取失败：${JSON.stringify(token)}`)
      return null
    }
    const query = new URLSearchParams({ access_token: token.access_token, pay_sig: paySig })
    const response = await fetch(`https://api.weixin.qq.com/xpay/query_order?${query.toString()}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body,
    })
    const record = await response.json()
    const errcode = record.errcode ?? record.errCode
    console.log(`errcode = ${errcode}  errmsg = ${record.errmsg ?? record.errMsg ?? ''}`)
    if (errcode === 268490003) {
      console.log('结论：pay_sig 校验失败 ⇒ AppKey 不对（沙箱/现网混用，或填成了别的密钥）')
    } else {
      console.log('结论：pay_sig 被接受 ⇒ 密钥与算法没问题，去查 OfferID / 道具配置 / session_key')
    }
    return errcode
  } catch (error) {
    console.log(`探针请求失败：${error.message}（容器能否出网？）`)
    return null
  }
}

/** 套餐与订单侧核对：OfferID 之外的第二现场——道具 ID、定价、登录态。 */
async function checkDatabase() {
  section('3. 套餐 / 订单 / 登录态（需 DATABASE_URL）')
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.log('跳过：未拿到 DATABASE_URL')
    return
  }
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString })
  try {
    const packages = await pool.query(
      `SELECT id, label, price_fen, virtual_product_id, enabled
         FROM pindou_packages
        ORDER BY id`,
    )
    for (const row of packages.rows) {
      console.log(
        `套餐 ${row.id}（${row.label}）price_fen=${row.price_fen} `
          + `virtual_product_id=${row.virtual_product_id || '(空 → 下单会被拦)'} enabled=${row.enabled}`,
      )
    }
    const missingSession = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM pindou_users
        WHERE deleted_at IS NULL AND session_key_ciphertext IS NULL`,
    )
    console.log(`无 session_key 的用户数：${missingSession.rows[0].count}（>0 说明这些人签名必然失败）`)
    const recent = await pool.query(
      `SELECT id, status, virtual_out_trade_no, created_at
         FROM pindou_orders
        ORDER BY created_at DESC
        LIMIT 5`,
    )
    for (const row of recent.rows) {
      console.log(`最近订单 ${row.id} status=${row.status} outTradeNo=${row.virtual_out_trade_no}`)
    }
  } catch (error) {
    console.log(`数据库查询失败：${error.message}`)
  } finally {
    await pool.end().catch(() => {})
  }
}

;(async () => {
  const { appKey, appId, appSecret } = checkConfig()
  await probePaySig(appKey, appId, appSecret)
  await checkDatabase()
  console.log('\n（探针单号与 openid 是假的，不会查到任何真实订单）')
})()
